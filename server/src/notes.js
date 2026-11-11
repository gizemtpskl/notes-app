/**
 * notes.js: the app's own data layer, run on the server. A copy of your notes is loaded into a
 * NotesDb exactly as the app keeps it, changed with the same rules the app uses (deadlines, dates
 * that fill themselves in, timetable checks), and turned back into a copy.
 *
 * Private notes arrive sealed (see js/data/sync.js) and are never loaded: they pass through as
 * they are.
 */
import './dom.js';
import { NotesDb } from '../../js/data/db.js';
import { MemoryAdapter } from '../../js/data/storage.js';
import { STORES } from '../../js/data/schema.js';
import { isSealed, snapshotOf } from '../../js/data/sync.js';

const TOMBSTONES_KEY = 'syncDeleted';

/** { db, sealed } for a copy { records, deleted }. */
export async function openCopy(copy, { now = Date.now() } = {}) {
  const adapter = new MemoryAdapter();
  const sealed = {};
  for (const [key, record] of Object.entries(copy.records ?? {})) {
    const at = key.indexOf(':');
    const store = key.slice(0, at);
    if (isSealed(record) || record?.private === true) {
      sealed[key] = record;
    } else if (STORES.includes(store) && store !== 'assets' && store !== 'versions') {
      adapter.stores.get(store).set(record.id, record);
    }
  }
  adapter.stores.get('meta').set(TOMBSTONES_KEY, { id: TOMBSTONES_KEY, value: { ...copy.deleted } });
  // linksIndexed: the links between notes are worked out from scratch each time, not kept here.
  const db = new NotesDb(adapter, { channelName: `server-${now}` });
  await db.open({ now });
  return { db, sealed };
}

/** The copy a NotesDb holds now, with the sealed records put back. */
export function copyOf(db, sealed) {
  const { records, deleted } = snapshotOf(db);
  for (const [key, record] of Object.entries(sealed)) {
    if (!(key in deleted)) records[key] = record;
  }
  return { records, deleted };
}

/** Whether two copies hold different records or deletions, whatever order they're listed in. */
export function differs(a, b) {
  const same = (x = {}, y = {}) => {
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    return keys.every((key) => key in y && JSON.stringify(x[key]) === JSON.stringify(y[key]));
  };
  return !same(a.records, b.records) || !same(a.deleted, b.deleted);
}

/** Runs fn(db) on a copy and returns { result, copy, changed }. */
export async function withCopy(copy, fn, { now = Date.now() } = {}) {
  const { db, sealed } = await openCopy(copy, { now });
  try {
    const result = await fn(db);
    const next = copyOf(db, sealed);
    return { result, copy: next, changed: differs(copy, next) };
  } finally {
    db.close();
  }
}
