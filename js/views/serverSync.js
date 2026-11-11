/**
 * serverSync.js: syncing with your own notes server (the server/ folder), which is also how
 * Claude reaches your notes. It works like Drive sync (see driveSync.js and data/sync.js), with
 * two differences:
 *   - The copy on the server is readable, so Claude can work with it. Private notes are sealed
 *     with your passphrase first, so neither the server nor Claude can read those.
 *   - Claude can change the copy at any time, so the app checks every minute while it's open.
 *     A note Claude changed keeps the version from before in its history.
 *
 * Stored on this device only (never in backups or sync):
 *   serverSync      { on, url, version, lastSync, since }
 *   serverSyncKeys  { access, seal }: the access key, and the key that seals private notes
 */
import { app } from '../context.js';
import { WrongPasscodeError, decryptValue, encryptValue } from '../data/crypto.js';
import { assetIds } from '../data/html.js';
import { cleanRecord } from '../data/porting.js';
import {
  KEEP_DELETIONS_DAYS, SyncFileError, createSyncKey, exportKey, importKey, latestChange, mergeSnapshots, normalizeCopy, openSealed, openSyncKey,
  sealPrivate, snapshotOf,
} from '../data/sync.js';
import { SYNC_STORES } from '../data/syncScope.js';
import { applyMerge, driveConfig, turnOffDrive } from './driveSync.js';

const CONFIG_KEY = 'serverSync';
const KEYS_KEY = 'serverSyncKeys';
const CHANGE_DELAY_MS = 3000;
const CHECK_EVERY_MS = 60000;
const MAX_IMAGE_BYTES = 1.9 * 1024 * 1024;
export const MIN_ACCESS_KEY = 24;
export const MIN_PASSPHRASE = 8;

export class ServerError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}
class Conflict extends Error {}

// -- Settings ------------------------------------------------------------------------------

export function serverConfig(db = app.db) {
  return {
    on: false, url: '', version: -1, lastSync: 0, since: 0, ...db.getMeta(CONFIG_KEY),
  };
}

function updateConfig(patch) {
  app.db.setMeta(CONFIG_KEY, { ...serverConfig(), ...patch });
}

/** A server address as typed, cleaned up, or '' when it can't be one. */
export function cleanServerUrl(text) {
  let url;
  try {
    url = new URL(String(text).trim().replace(/\/+(mcp)?\/*$/, ''));
  } catch {
    return '';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return '';
  return url.origin;
}

// -- Status --------------------------------------------------------------------------------

/** idle, syncing, error or off. */
const status = { state: 'off', message: '' };
const listeners = new Set();

function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  listeners.forEach((listener) => listener());
}

export const serverStatus = () => status;
export function onServerStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// -- Talking to the server -----------------------------------------------------------------

async function call(method, path, { body, url = serverConfig().url, access = app.db.getMeta(KEYS_KEY)?.access, raw = false } = {}) {
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${access}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ServerError('Couldn’t reach your server. Check the address, and that you’re online.');
  }
  if (response.status === 409) throw new Conflict();
  if (!response.ok) {
    let message = '';
    try {
      message = (await response.json()).error ?? '';
    } catch {
      // Not one of the server's own answers.
    }
    if (response.status === 401) throw new ServerError('The access key isn’t right. It’s the ACCESS_KEY you set on the server.', 401);
    if (response.status === 404 && !message) throw new ServerError('That address doesn’t look like your notes server.', 404);
    throw new ServerError(message || `Your server had a problem (${response.status}). Try again in a minute.`, response.status);
  }
  return raw ? response.text() : response.json();
}

async function sealKey() {
  const text = app.db.getMeta(KEYS_KEY)?.seal;
  return text ? importKey(text) : null;
}

// -- Syncing -------------------------------------------------------------------------------

/** Images: each one on its own, sent once and fetched when a note here needs it. */
async function syncImages(key) {
  const { db } = app;
  // An image in any private note is sealed, like the note.
  const wanted = new Map();
  for (const note of db.data.notes.values()) {
    for (const id of assetIds(note.body)) wanted.set(id, wanted.get(id) === true || note.private === true);
  }
  const remote = new Set((await call('GET', '/sync/assets')).ids);
  const local = new Map((await db.storage.getAll('assets')).map((a) => [a.id, a]));
  for (const [id, sealed] of wanted) {
    if (local.has(id) && !remote.has(id)) {
      const body = sealed ? { id, sealed: await encryptValue(key, local.get(id), { asText: true }) } : local.get(id);
      const text = JSON.stringify(body);
      if (new Blob([text]).size <= MAX_IMAGE_BYTES) await call('PUT', `/sync/assets/${encodeURIComponent(id)}`, { body: text });
    } else if (!local.has(id) && remote.has(id)) {
      const parsed = JSON.parse(await call('GET', `/sync/assets/${encodeURIComponent(id)}`, { raw: true }));
      const asset = typeof parsed?.sealed === 'string' ? await decryptValue(key, parsed.sealed) : parsed;
      const clean = cleanRecord('assets', asset);
      if (clean) await db.storage.commit([{ store: 'assets', id: clean.id, value: clean }]);
    }
  }
  for (const id of remote) if (!wanted.has(id)) await call('DELETE', `/sync/assets/${encodeURIComponent(id)}`);
}

async function syncOnce() {
  const { db } = app;
  const config = serverConfig();
  const key = await sealKey();
  const started = Date.now();
  const info = await call('GET', '/sync/info');
  const local = snapshotOf(db);
  const changedHere = latestChange(local) > config.since;
  if (info.version === config.version && !changedHere) {
    updateConfig({ lastSync: Date.now() });
    return { changed: false };
  }

  let base = config.version;
  let result = null;
  if (info.version !== config.version) {
    const copy = await call('GET', '/sync/copy');
    const remote = normalizeCopy(await openSealed({ records: copy.records ?? {}, deleted: copy.deleted ?? {} }, key));
    result = mergeSnapshots(local, remote, { since: config.since, now: started });
    applyMerge(result, { keepReplaced: true });
    base = copy.version;
  }

  let version = base;
  if (changedHere || result?.remoteChanged || config.version < 0) {
    db.pruneTombstones(started - KEEP_DELETIONS_DAYS * 86400000);
    const out = await sealPrivate(snapshotOf(db), key);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    ({ version } = await call('PUT', '/sync/copy', { body: { baseVersion: base, ...out, timeZone } }));
  }
  await syncImages(key);
  updateConfig({ version, lastSync: Date.now(), since: started });
  return { changed: Boolean(result?.puts.length || result?.removes.length), received: result ? result.puts.length + result.removes.length : 0 };
}

let running = null;
let again = false;
let timer = null;

/** Syncs now if connected and online. Overlapping calls become one more run afterwards. */
export function syncServer() {
  if (!serverConfig().on || !navigator.onLine) return Promise.resolve(null);
  if (running) {
    again = true;
    return running;
  }
  setStatus('syncing');
  running = (async () => {
    // Something changed on the server between reading and sending (Claude, or another device):
    // read again and merge that too.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await syncOnce();
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    throw new ServerError('Your notes kept changing on the server while syncing. Try again in a minute.');
  })()
    .then((result) => {
      setStatus('idle');
      return result;
    })
    .catch((error) => {
      if (!(error instanceof ServerError || error instanceof SyncFileError)) console.warn('Server sync:', error);
      setStatus('error', error instanceof ServerError || error instanceof SyncFileError ? error.message : 'Sync with your server had a problem.');
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
  timer = setTimeout(() => syncServer(), delay);
}

// -- Connecting ----------------------------------------------------------------------------

/**
 * Connects this device to your server, then syncs. The first device sets the passphrase for
 * private notes; the others must use the same one. Rejects with a plain-English message, or
 * WrongPasscodeError for a passphrase that doesn't match.
 */
export async function connectServer({ url: typed, access, passphrase }) {
  const { db } = app;
  const url = cleanServerUrl(typed);
  if (!url) throw new ServerError('That doesn’t look like a server address. It starts with https://, like https://notes-app-server.yourname.workers.dev');
  if (String(access).length < MIN_ACCESS_KEY) throw new ServerError(`The access key is at least ${MIN_ACCESS_KEY} characters long.`);
  if (String(passphrase).length < MIN_PASSPHRASE) throw new ServerError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const info = await call('GET', '/sync/info', { url, access });
  let key;
  if (info.lock) {
    key = await openSyncKey(info.lock, passphrase);
  } else {
    const made = await createSyncKey(passphrase);
    const saved = await call('POST', '/sync/lock', { url, access, body: { lock: made.lock } });
    // Another device set it a moment ago: its passphrase is the one.
    key = saved.ok ? made.key : await openSyncKey(saved.lock, passphrase);
  }
  if (driveConfig(db).on) await turnOffDrive({ deleteCopy: false });
  const seal = await exportKey(key);
  db.batch(() => {
    db.setMeta(KEYS_KEY, { access, seal });
    db.setMeta(CONFIG_KEY, {
      on: true, url, version: -1, lastSync: 0, since: 0,
    });
  });
  setStatus('idle');
  return syncServer();
}

/** Stops syncing on this device. The notes here and on the server stay as they are. */
export function disconnectServer() {
  const { db } = app;
  clearTimeout(timer);
  db.batch(() => {
    db.setMeta(KEYS_KEY, null);
    db.setMeta(CONFIG_KEY, { ...serverConfig(), on: false, version: -1 });
  });
  setStatus('off');
}

/** Runs once at startup. Does nothing until a server is connected. */
export function startServerSync() {
  const { db } = app;
  if (serverConfig(db).on) {
    setStatus('idle');
    syncServer();
  }
  db.on((change) => {
    if (!serverConfig(db).on || change.source !== 'local') return;
    const relevant = SYNC_STORES.some((store) => change.stores.has(store)) || change.ids.has('settings') || change.ids.has('filing');
    if (!relevant) return;
    if (running) again = true;
    else schedule();
  });
  window.addEventListener('online', () => syncServer());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncServer();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') syncServer();
  }, CHECK_EVERY_MS);
}

export { WrongPasscodeError };
