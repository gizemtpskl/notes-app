/**
 * store.js: the one place your notes live on the server, a Durable Object with its own SQLite
 * database. Devices read and replace the copy through the sync API; Claude's tools change it
 * through runTool. Everything runs here, one request at a time, so a tool and a device can't
 * overwrite each other: a device that read an older version gets a conflict and syncs again.
 *
 *   records  key "store:id" -> record JSON (private notes only as sealed records)
 *   deleted  key -> when it was deleted
 *   assets   image id -> image JSON (sealed for images of private notes)
 *   kv       version, the passphrase lock, the time zone, failed sign-ins
 */
import { DurableObject } from 'cloudflare:workers';
import { withCopy } from './notes.js';
import { OPERATIONS } from './operations.js';
import { ToolError } from './ops.js';

const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 60 * 60000;

export class NotesStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  _get(name, fallback = null) {
    const row = this.sql.exec('SELECT value FROM kv WHERE name = ?', name).toArray()[0];
    return row ? JSON.parse(row.value) : fallback;
  }

  _set(name, value) {
    this.sql.exec('INSERT INTO kv (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', name, JSON.stringify(value));
  }

  version() {
    return this._get('version', 0);
  }

  info() {
    return { version: this.version(), lock: this._get('lock'), timeZone: this._get('timeZone', 'UTC') };
  }

  copy() {
    const records = {};
    for (const row of this.sql.exec('SELECT key, json FROM records')) records[row.key] = JSON.parse(row.json);
    const deleted = {};
    for (const row of this.sql.exec('SELECT key, at FROM deleted')) deleted[row.key] = row.at;
    return { version: this.version(), records, deleted };
  }

  /** Writes only what differs from what's stored, and moves the version on when anything did. */
  _write(next) {
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const stored = new Map();
      for (const row of this.sql.exec('SELECT key, json FROM records')) stored.set(row.key, row.json);
      for (const [key, record] of Object.entries(next.records)) {
        const json = JSON.stringify(record);
        if (stored.get(key) !== json) {
          this.sql.exec('INSERT INTO records (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json', key, json);
          changed = true;
        }
        stored.delete(key);
      }
      for (const key of stored.keys()) {
        this.sql.exec('DELETE FROM records WHERE key = ?', key);
        changed = true;
      }
      const before = new Map(this.sql.exec('SELECT key, at FROM deleted').toArray().map((row) => [row.key, row.at]));
      const after = Object.entries(next.deleted ?? {});
      if (after.length !== before.size || after.some(([key, at]) => before.get(key) !== at)) {
        this.sql.exec('DELETE FROM deleted');
        for (const [key, at] of after) this.sql.exec('INSERT INTO deleted (key, at) VALUES (?, ?)', key, at);
        changed = true;
      }
      if (changed) this._set('version', this.version() + 1);
    });
    return changed;
  }

  /**
   * A device's merged copy. Refused when the device merged with an older version than the one
   * stored: something changed meanwhile, so it reads again and merges that too.
   */
  replace({ baseVersion, records, deleted, timeZone }) {
    if (baseVersion !== this.version()) return { ok: false, version: this.version() };
    if (typeof timeZone === 'string' && timeZone.length < 64) this._set('timeZone', timeZone);
    this._write({ records, deleted });
    return { ok: true, version: this.version() };
  }

  /** The passphrase lock for private notes. The first device sets it; the rest open it. */
  setLock(lock) {
    if (this._get('lock')) return { ok: false, lock: this._get('lock') };
    this._set('lock', lock);
    return { ok: true, lock };
  }

  // -- Images ------------------------------------------------------------------------------

  assetIds() {
    return this.sql.exec('SELECT id FROM assets').toArray().map((row) => row.id);
  }

  asset(id) {
    const row = this.sql.exec('SELECT json FROM assets WHERE id = ?', id).toArray()[0];
    return row ? row.json : null;
  }

  putAsset(id, json) {
    this.sql.exec('INSERT INTO assets (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', id, json);
  }

  removeAsset(id) {
    this.sql.exec('DELETE FROM assets WHERE id = ?', id);
  }

  // -- Claude --------------------------------------------------------------------------------

  /** Today's date where you are, from the time zone your devices report. */
  today(now = Date.now()) {
    const zone = this._get('timeZone', 'UTC');
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    } catch {
      return new Date(now).toISOString().slice(0, 10);
    }
  }

  /** Runs one of Claude's operations. Returns { ok, result } or { ok: false, error }. */
  async runTool(name, args, { canWrite }) {
    const operation = OPERATIONS[name];
    if (!operation) return { ok: false, error: `Unknown tool ${name}.` };
    if (operation.writes && !canWrite) return { ok: false, error: 'This connection can only read your notes. Connect Claude again and allow changes to make them.' };
    const { version: _version, ...copy } = this.copy();
    try {
      const { result, copy: next, changed } = await withCopy(copy, (db) => operation.run(db, args, { today: this.today() }));
      if (operation.writes && changed) this._write(next);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, error: error.message };
      console.error('Tool failed:', name, error?.stack ?? error);
      return { ok: false, error: 'Something went wrong on the server. Nothing was changed.' };
    }
  }

  // -- Signing in ------------------------------------------------------------------------------

  /** Whether sign-in is paused after too many wrong keys. */
  locked(now = Date.now()) {
    const failures = this._get('failures', { count: 0, since: 0 });
    return failures.count >= MAX_ATTEMPTS && now - failures.since < LOCKOUT_MS;
  }

  failed(now = Date.now()) {
    const failures = this._get('failures', { count: 0, since: now });
    const fresh = now - failures.since > LOCKOUT_MS ? { count: 0, since: now } : failures;
    this._set('failures', { count: fresh.count + 1, since: fresh.since });
  }

  succeeded() {
    this._set('failures', { count: 0, since: 0 });
  }
}
