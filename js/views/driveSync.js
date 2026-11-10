/**
 * driveSync.js: keeping a copy of your notes in your own Google Drive, and the same notes on
 * every device where sync is on.
 *
 * The copy lives in Drive's hidden app folder: one file for the notes (notes-sync.json) and one
 * per image (asset-<id>). With a passphrase, both are encrypted before they leave the device.
 *
 * When: right after signing in, a few seconds after a change, when the app comes back into view,
 * and every few minutes while open. A check that finds nothing new costs one small request.
 * Merging is in data/sync.js.
 *
 * Stored on this device only (never in backups): driveSync (the settings below) and
 * driveSyncKey (the encryption key, unlocked once with the passphrase).
 *   { on, clientId, encrypted, fileId, remoteVersion, lastSync, since }
 */
import { app } from '../context.js';
import { WrongPasscodeError } from '../data/crypto.js';
import { assetIds } from '../data/html.js';
import { readGoogleErrorReason } from '../data/googleErrors.js';
import { cleanRecord } from '../data/porting.js';
import {
  SNAPSHOT_NAME, KEEP_DELETIONS_DAYS, SyncFileError, createSyncKey, exportKey, importKey, latestChange, mergeSnapshots, openSyncKey,
  packSnapshot, peekSnapshot, snapshotOf, unpackSnapshot,
} from '../data/sync.js';
import { SYNC_STORES } from '../data/syncScope.js';
import { decryptValue, encryptValue } from '../data/crypto.js';
import {
  forgetGoogleToken, googleSignIn, googleToken, hasGoogleToken, loadGoogleLibrary, registerGoogleFeature, revokeGoogleUnlessUsed,
} from './googleAuth.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CONFIG_KEY = 'driveSync';
const KEY_KEY = 'driveSyncKey';
const CHANGE_DELAY_MS = 4000;
const CHECK_EVERY_MS = 3 * 60000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class DriveAuthError extends Error {}
export class NeedPassphraseError extends Error {}
export class DriveError extends Error {
  constructor(message, status, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// -- Settings ------------------------------------------------------------------------------

export function driveConfig(db = app.db) {
  return {
    on: false, clientId: '', encrypted: false, fileId: '', remoteVersion: '', lastSync: 0, since: 0, ...db.getMeta(CONFIG_KEY),
  };
}

function updateConfig(patch) {
  app.db.setMeta(CONFIG_KEY, { ...driveConfig(), ...patch });
}

async function storedKey() {
  const text = app.db.getMeta(KEY_KEY);
  return text ? importKey(text) : null;
}

// -- Status --------------------------------------------------------------------------------

/** idle, syncing, signed-out, passphrase (needs the passphrase) or error. */
const status = { state: 'signed-out', message: '' };
const listeners = new Set();

function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  listeners.forEach((listener) => listener());
}

export const driveStatus = () => status;
export function onDriveStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// -- The Drive API -------------------------------------------------------------------------

async function send(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${googleToken()}`, ...options.headers } });
  if (response.ok) return response;
  if (response.status === 401) throw new DriveAuthError('Sign in again.');
  const reason = await readGoogleErrorReason(response);
  const error = new DriveError(`Google Drive answered ${response.status}`, response.status, reason);
  error.message = explainDrive(error);
  throw error;
}

const drive = {
  /** Every file in the app folder: [{ id, name, version }]. */
  async list() {
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,version)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await send(`${FILES}?${params}`)).json();
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return files;
  },
  async version(id) {
    return (await (await send(`${FILES}/${id}?fields=version`)).json()).version;
  },
  async read(id) {
    return (await send(`${FILES}/${id}?alt=media`)).text();
  },
  async create(name, text) {
    const boundary = `notes${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    return (await send(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })).json();
  },
  async update(id, text) {
    return (await send(`${UPLOAD}/${id}?uploadType=media&fields=id,version`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text,
    })).json();
  },
  async remove(id) {
    try {
      await send(`${FILES}/${id}`, { method: 'DELETE' });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  },
};

const tooBig = (text) => new Blob([text]).size > MAX_FILE_BYTES;

// -- Syncing -------------------------------------------------------------------------------

/** Applies what a merge decided, keeping the times changes were made, and saves lost edits. */
function applyMerge(result) {
  const { db } = app;
  const deletedAt = new Map(result.removes.map((r) => [`${r.store}:${r.id}`, r.at]));
  db.withSyncTimes(() => {
    for (const { store, record } of result.puts) {
      const clean = store === 'meta' ? cleanRecord('meta', record) : cleanRecord(store, record);
      if (clean) db._put(store, { ...clean, syncAt: record.syncAt });
    }
    for (const { store, id } of result.removes) db._remove(store, id);
    if (result.puts.length || result.removes.length) {
      db.repairIntegrity();
      db.rebuildLinks();
    }
  }, deletedAt);
  db.adoptTombstones(result.merged.deleted);
  // An edit made here that lost to a newer one elsewhere is kept in the note's history.
  for (const { store, record } of result.conflicts) {
    if (store === 'notes' && db.getNote(record.id)) db.snapshotNote(record.id, record);
  }
}

/** Images: each one is a file of its own, sent once and fetched when a note here needs it. */
async function syncAssets(files, key) {
  const { db } = app;
  const wanted = new Set();
  for (const note of db.data.notes.values()) for (const id of assetIds(note.body)) wanted.add(id);
  const remote = new Map(files.filter((f) => f.name.startsWith('asset-')).map((f) => [f.name.slice(6), f]));
  const local = new Map((await db.storage.getAll('assets')).map((a) => [a.id, a]));
  for (const id of wanted) {
    if (local.has(id) && !remote.has(id)) {
      const text = key ? JSON.stringify({ encrypted: true, data: await encryptValue(key, local.get(id), { asText: true }) }) : JSON.stringify(local.get(id));
      if (!tooBig(text)) await drive.create(`asset-${id}`, text);
    } else if (!local.has(id) && remote.has(id)) {
      const parsed = JSON.parse(await drive.read(remote.get(id).id));
      const asset = parsed.encrypted ? await decryptValue(key, parsed.data) : parsed;
      const clean = cleanRecord('assets', asset);
      if (clean) await db.storage.commit([{ store: 'assets', id: clean.id, value: clean }]);
    }
  }
  // Images no note uses any more are removed from Drive. They stay in this device's history.
  for (const [id, file] of remote) if (!wanted.has(id)) await drive.remove(file.id);
}

async function syncOnce() {
  const { db } = app;
  const config = driveConfig();
  const key = await storedKey();
  const started = Date.now();
  let fileId = config.fileId;
  let files = null;
  if (!fileId) {
    files = await drive.list();
    fileId = files.find((f) => f.name === SNAPSHOT_NAME)?.id ?? '';
  }

  const local = snapshotOf(db);
  let version = '';
  if (fileId) {
    try {
      version = await drive.version(fileId);
    } catch (error) {
      if (error.status !== 404) throw error;
      fileId = '';
    }
  }
  // Nothing new on either side: no download, no upload.
  const changedHere = latestChange(local) > config.since;
  if (fileId && version === config.remoteVersion && !changedHere) {
    updateConfig({ lastSync: Date.now(), fileId });
    return { changed: false };
  }

  let result = null;
  if (fileId && version !== config.remoteVersion) {
    const text = await drive.read(fileId);
    const { encrypted } = peekSnapshot(text);
    if (encrypted && !key) throw new NeedPassphraseError('Enter your sync passphrase to open the copy in Google Drive.');
    const remote = await unpackSnapshot(text, { key: encrypted ? key : null });
    result = mergeSnapshots(local, remote, { since: config.since, now: started });
    applyMerge(result);
  }

  // Send what this device has, merged, unless Drive already holds exactly that.
  const needsUpload = !fileId || changedHere || result?.remoteChanged;
  if (needsUpload) {
    db.pruneTombstones(started - KEEP_DELETIONS_DAYS * 86400000);
    const lock = key ? config.lock : null;
    const text = await packSnapshot(snapshotOf(db), { key, lock });
    if (tooBig(text)) throw new DriveError('Your notes are too large to sync in one file (over 5 MB). Large images are the usual cause.', 413);
    const saved = fileId ? await drive.update(fileId, text) : await drive.create(SNAPSHOT_NAME, text);
    fileId = saved.id;
    version = saved.version;
  }
  await syncAssets(files ?? await drive.list(), key);
  updateConfig({
    fileId, remoteVersion: version, lastSync: Date.now(), since: started,
  });
  return { changed: Boolean(result?.puts.length || result?.removes.length || needsUpload), received: result ? result.puts.length + result.removes.length : 0 };
}

/** A plain-English sentence for an answer from Drive that wasn't OK. */
function explainDrive({ status, reason }) {
  if (reason === 'apiOff') {
    return 'The Google Drive API isn’t turned on in your Google project. Turn it on (step 2 of the setup), wait a few minutes, then try again.';
  }
  if (reason === 'scope') return 'Google Drive access wasn’t ticked on the Google page. Sign in again and tick it.';
  if (reason === 'rateLimit' || status === 429) return 'Google asked to slow down. Try again in a minute.';
  if (status === 403) return 'Google refused this. Check that the Google Drive API is turned on in your Google project and that your account is a test user.';
  if (status === 413) return 'Your notes are too large to sync in one file (over 5 MB). Large images are the usual cause.';
  return `Google Drive had a problem (${status}). Try again in a minute.`;
}

function explain(error) {
  if (error instanceof DriveError || error instanceof SyncFileError || error instanceof NeedPassphraseError) return error.message;
  return "Couldn't reach Google Drive.";
}

let running = null;
let again = false;
let timer = null;

/** Syncs now if signed in and online. Overlapping calls become one more run afterwards. */
export function syncDrive() {
  if (!driveConfig().on) return Promise.resolve(null);
  if (!hasGoogleToken(DRIVE_SCOPE)) {
    setStatus('signed-out');
    return Promise.resolve(null);
  }
  if (!navigator.onLine) return Promise.resolve(null);
  if (running) {
    again = true;
    return running;
  }
  setStatus('syncing');
  running = syncOnce()
    .then((result) => {
      setStatus('idle');
      return result;
    })
    .catch((error) => {
      if (error instanceof DriveAuthError) {
        forgetGoogleToken();
        setStatus('signed-out');
      } else if (error instanceof NeedPassphraseError) {
        setStatus('passphrase', error.message);
      } else {
        console.warn('Drive sync:', error);
        setStatus('error', explain(error));
      }
      return null;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        schedule();
      }
    });
  return running;
}

function schedule(delay = CHANGE_DELAY_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => syncDrive(), delay);
}

// -- Turning it on and off -----------------------------------------------------------------

/** Signs in if needed. Call from a click. Rejects with a plain-English message. */
export async function signInToDrive(clientId = driveConfig().clientId) {
  if (!hasGoogleToken(DRIVE_SCOPE)) await googleSignIn(clientId, DRIVE_SCOPE, 'Google Drive');
}

/** What's in Drive already: { exists, encrypted }. Needs a sign-in first. */
export async function lookAtDrive() {
  const file = (await drive.list()).find((f) => f.name === SNAPSHOT_NAME);
  if (!file) return { exists: false, encrypted: false };
  const { encrypted, lock } = peekSnapshot(await drive.read(file.id));
  return {
    exists: true, encrypted, lock, fileId: file.id,
  };
}

/**
 * Turns sync on, after a sign-in. With an existing copy in Drive, its passphrase choice is used:
 * the passphrase unlocks it. Otherwise a new encrypted copy is made when a passphrase is given.
 * Throws WrongPasscodeError for a passphrase that doesn't open the existing copy.
 */
export async function turnOnDrive({ clientId, passphrase }) {
  const { db } = app;
  const existing = await lookAtDrive();
  let lock = null;
  let keyText = '';
  if (existing.exists && existing.encrypted) {
    if (!passphrase) throw new NeedPassphraseError('There’s already an encrypted copy in Google Drive. Enter the passphrase you chose for it.');
    const key = await openSyncKey(existing.lock, passphrase);
    lock = existing.lock;
    keyText = await exportKey(key);
  } else if (!existing.exists && passphrase) {
    const made = await createSyncKey(passphrase);
    lock = made.lock;
    keyText = await exportKey(made.key);
  }
  db.batch(() => {
    if (keyText) db.setMeta(KEY_KEY, keyText);
    else db.setMeta(KEY_KEY, null);
    db.setMeta(CONFIG_KEY, {
      on: true, clientId, encrypted: Boolean(keyText), lock, fileId: existing.fileId ?? '', remoteVersion: '', lastSync: 0, since: 0,
    });
  });
  return syncDrive();
}

/** Unlocks an encrypted Drive copy on this device, when sync found one it couldn't open. */
export async function enterPassphrase(passphrase) {
  const existing = await lookAtDrive();
  if (!existing.encrypted) return syncDrive();
  const key = await openSyncKey(existing.lock, passphrase);
  app.db.setMeta(KEY_KEY, await exportKey(key));
  updateConfig({ encrypted: true, lock: existing.lock });
  return syncDrive();
}

/** Turns sync off on this device. It can also delete the copy in Drive, which needs a sign-in. */
export async function turnOffDrive({ deleteCopy }) {
  const { db } = app;
  if (deleteCopy) {
    await signInToDrive();
    for (const file of await drive.list()) await drive.remove(file.id);
  }
  clearTimeout(timer);
  db.batch(() => {
    db.setMeta(KEY_KEY, null);
    db.setMeta(CONFIG_KEY, { ...driveConfig(), on: false, fileId: '', remoteVersion: '', lock: null });
  });
  revokeGoogleUnlessUsed();
  setStatus('signed-out');
}

/** Runs once at startup. Does nothing until sync has been turned on. */
export function startDriveSync() {
  const { db } = app;
  registerGoogleFeature('drive', { scope: DRIVE_SCOPE, isOn: () => driveConfig(db).on });
  if (driveConfig(db).on) {
    loadGoogleLibrary().catch(() => {}); // Ready for the first click.
    setStatus('signed-out');
  }
  // Listening starts now even when sync is off, so turning it on later needs no reload.
  db.on((change) => {
    if (!driveConfig(db).on) return;
    const relevant = SYNC_STORES.some((store) => change.stores.has(store)) || change.ids.has('settings') || change.ids.has('filing');
    if (change.source !== 'local' || !relevant || !hasGoogleToken(DRIVE_SCOPE)) return;
    // A change made while a sync is running gets a sync of its own straight after.
    if (running) again = true;
    else schedule();
  });
  window.addEventListener('online', () => syncDrive());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncDrive();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') syncDrive();
  }, CHECK_EVERY_MS);
}

export { WrongPasscodeError };
