/**
 * sync.js: merging two copies of your notes, and packing a copy for Google Drive. No network here:
 * views/driveSync.js moves the copies. Everything in this file can be tested on its own.
 *
 * A copy ("snapshot") is { records: { "store:id": record }, deleted: { "store:id": time } }.
 *
 * MERGING: for every record, the newest change wins, whether it's an edit or a deletion. Each
 * record carries syncAt, the time it last changed (see db.js). Nothing is ever lost silently: when
 * a note was edited on two devices between syncs, the older edit is reported as a conflict on the
 * device where the two meet, and kept in that note's version history there.
 *
 * Merging is the same whichever side is "local", and doing it twice changes nothing, so two
 * devices that sync at the same moment still end up with the same notes on their next sync.
 */
import { createLock, decryptValue, encryptValue, openLock } from './crypto.js';
import { SYNC_META, SYNC_STORES, syncsRecord } from './syncScope.js';

export const SYNC_FORMAT = 'notes-sync';
export const SYNC_VERSION = 1;
export const SNAPSHOT_NAME = 'notes-sync.json';
/** Deletions are remembered this long, so a device away for months still learns about them. */
export const KEEP_DELETIONS_DAYS = 400;

export const stampOf = (record) => record?.syncAt ?? record?.updated ?? record?.created ?? 0;
const splitKey = (key) => {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
};

/** This device's copy. */
export function snapshotOf(db) {
  const records = {};
  for (const store of SYNC_STORES) {
    for (const record of db.data[store].values()) {
      if (syncsRecord(store, record)) records[`${store}:${record.id}`] = record;
    }
  }
  for (const id of SYNC_META) {
    const record = db.data.meta.get(id);
    if (record) records[`meta:${id}`] = record;
  }
  return { records, deleted: db.syncTombstones() };
}

/**
 * The newest of the candidates. A deletion beats an edit made at the very same moment, and with
 * equal times this device's copy stays: the same time means the same change.
 */
function newest(candidates) {
  return candidates.filter(Boolean).reduce((best, c) => {
    if (!best) return c;
    if (c.at !== best.at) return c.at > best.at ? c : best;
    if (c.deleted !== best.deleted) return c.deleted ? c : best;
    return best.side === 'local' ? best : c;
  }, null);
}

/**
 * Merges this device's copy with the one from Drive.
 *   since  when this device last synced: its own edits after that count as unsynced
 * Returns {
 *   merged,                     the copy both should hold now
 *   puts: [{ store, record }],  records to change here
 *   removes: [{ store, id, at }], records to delete here
 *   remoteChanged,              whether Drive needs the merged copy
 *   conflicts: [{ store, record }]  edits made on both sides since the last sync: the one that
 *                                    lost, whichever side it came from
 * }
 */
export function mergeSnapshots(local, remote, { since = 0, now = Date.now() } = {}) {
  const keys = new Set([
    ...Object.keys(local.records), ...Object.keys(local.deleted ?? {}),
    ...Object.keys(remote.records), ...Object.keys(remote.deleted ?? {}),
  ]);
  const cutoff = now - KEEP_DELETIONS_DAYS * 86400000;
  const merged = { records: {}, deleted: {} };
  const puts = [];
  const removes = [];
  const conflicts = [];
  let remoteChanged = false;

  for (const key of keys) {
    const [store] = splitKey(key);
    const mine = local.records[key];
    const theirs = remote.records[key];
    const winner = newest([
      mine && { at: stampOf(mine), record: mine, side: 'local' },
      theirs && { at: stampOf(theirs), record: theirs, side: 'remote' },
      local.deleted?.[key] !== undefined && { at: local.deleted[key], deleted: true, side: 'local' },
      remote.deleted?.[key] !== undefined && { at: remote.deleted[key], deleted: true, side: 'remote' },
    ]);
    if (winner.deleted) {
      if (winner.at >= cutoff) merged.deleted[key] = winner.at;
      if (mine) removes.push({ store, id: mine.id, at: winner.at });
      if (theirs || (remote.deleted?.[key] !== winner.at && winner.at >= cutoff)) remoteChanged = true;
      continue;
    }
    merged.records[key] = winner.record;
    if (winner.side === 'remote') {
      puts.push({ store, record: winner.record });
      if (mine && stampOf(mine) > since) conflicts.push({ store, record: mine });
    } else if (!theirs || stampOf(theirs) !== stampOf(winner.record)) {
      remoteChanged = true;
      // Edited on both sides since the last sync, and the other side lost: keep it here too.
      if (theirs && stampOf(theirs) > since && stampOf(mine) > since) conflicts.push({ store, record: theirs });
    }
  }
  // Old deletions that only Drive still listed are let go.
  if (Object.keys(remote.deleted ?? {}).some((key) => !(key in merged.deleted) && !(key in merged.records))) remoteChanged = true;
  return {
    merged, puts, removes, remoteChanged, conflicts,
  };
}

/** The newest change time in a copy, for knowing whether there's anything new to send. */
export function latestChange(snapshot) {
  let latest = 0;
  for (const record of Object.values(snapshot.records)) latest = Math.max(latest, stampOf(record));
  for (const at of Object.values(snapshot.deleted ?? {})) latest = Math.max(latest, at);
  return latest;
}

// -- Packing for Drive ---------------------------------------------------------------------
// The file in Drive: { format, version, savedAt, lock?, data }. With a passphrase, lock is the
// passphrase-protected key (the same scheme as the passcode lock, see crypto.js) and data is
// encrypted, so Google holds nothing readable. Without one, data is the copy itself.

/** A new key for encrypting the Drive copy, and the lock record that protects it. */
export async function createSyncKey(passphrase) {
  const { key, record } = await createLock(passphrase);
  return { key, lock: record };
}

/** The key from a Drive copy's lock record. Throws WrongPasscodeError for a wrong passphrase. */
export function openSyncKey(lock, passphrase) {
  return openLock(lock, passphrase, { extractable: true });
}

export async function exportKey(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function importKey(text) {
  const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** The text of the Drive file for a copy. */
export async function packSnapshot(snapshot, { key = null, lock = null, now = Date.now() } = {}) {
  const body = { records: snapshot.records, deleted: snapshot.deleted };
  const file = {
    format: SYNC_FORMAT, version: SYNC_VERSION, savedAt: now, encrypted: Boolean(key),
  };
  if (key) {
    file.lock = lock;
    file.data = await encryptValue(key, body, { asText: true });
  } else {
    file.data = body;
  }
  return JSON.stringify(file);
}

export class SyncFileError extends Error {}

/** Reads the head of a Drive file without opening it: { encrypted, lock }. */
export function peekSnapshot(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new SyncFileError('The copy in Google Drive is damaged.');
  }
  if (file?.format !== SYNC_FORMAT) throw new SyncFileError('The copy in Google Drive isn’t from this app.');
  if (file.version > SYNC_VERSION) throw new SyncFileError('The copy in Google Drive was made by a newer version of the app. Reload to update.');
  return { file, encrypted: file.encrypted === true, lock: file.lock ?? null };
}

/**
 * Opens a Drive file into a copy. Only the shape is checked here. Records that win a merge are
 * checked fully, the same way as a backup's, before they're saved (see driveSync.js).
 */
export async function unpackSnapshot(text, { key = null } = {}) {
  const { file, encrypted } = peekSnapshot(text);
  if (encrypted && !key) throw new SyncFileError('The copy in Google Drive is encrypted. Enter your sync passphrase.');
  let body;
  try {
    body = encrypted ? await decryptValue(key, file.data) : file.data;
  } catch {
    throw new SyncFileError('This device’s sync key doesn’t open the copy in Google Drive. Turn sync off and on again with your passphrase.');
  }
  return normalizeCopy(body);
}

// -- Sealed records ------------------------------------------------------------------------
// With your own server, the copy there is readable, so Claude can work with it. Private notes are
// the exception: each one is sealed with the passphrase's key before it leaves the device, as
// { id, syncAt, sealed }. The server and Claude only see that it exists and when it changed.

export const isSealed = (record) => typeof record?.sealed === 'string';

/** A copy with every private note sealed. */
export async function sealPrivate(snapshot, key) {
  const records = {};
  for (const [name, record] of Object.entries(snapshot.records)) {
    records[name] = name.startsWith('notes:') && record.private === true
      ? { id: record.id, syncAt: stampOf(record), sealed: await encryptValue(key, record, { asText: true }) }
      : record;
  }
  return { records, deleted: snapshot.deleted };
}

/**
 * Opens the sealed records of a copy. Throws SyncFileError when the key doesn't open them, which
 * means this device has the wrong passphrase.
 */
export async function openSealed(snapshot, key) {
  const records = {};
  for (const [name, record] of Object.entries(snapshot.records)) {
    if (!isSealed(record)) {
      records[name] = record;
      continue;
    }
    if (!key) throw new SyncFileError('Enter your passphrase to open your private notes.');
    let opened;
    try {
      opened = await decryptValue(key, record.sealed);
    } catch {
      throw new SyncFileError('Your passphrase doesn’t open the private notes on your server. Disconnect and connect again with the right one.');
    }
    // What's inside decides, except the name: a sealed record can't move into another's place.
    if (opened?.id === record.id) records[name] = { ...opened, syncAt: record.syncAt };
  }
  return { records, deleted: snapshot.deleted };
}

/** Checks the shape of a copy from elsewhere: only stores and settings that sync, with matching ids. */
export function normalizeCopy(body) {
  const records = {};
  for (const [key2, raw] of Object.entries(body?.records ?? {})) {
    const [store, id] = splitKey(key2);
    if (store !== 'meta' && !SYNC_STORES.includes(store)) continue;
    if (store === 'meta' && !SYNC_META.includes(id)) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.id === id) {
      records[key2] = Number.isFinite(raw.syncAt) ? raw : { ...raw, syncAt: stampOf(raw) };
    }
  }
  const deleted = {};
  for (const [key2, at] of Object.entries(body?.deleted ?? {})) if (Number.isFinite(at)) deleted[key2] = at;
  return { records, deleted };
}
