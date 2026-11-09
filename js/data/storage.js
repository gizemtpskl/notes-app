/**
 * storage.js: persistence adapters.
 *
 * Every adapter exposes the same small interface, so the rest of the app never touches
 * IndexedDB directly, and the optional encryption (crypto.js) can wrap any of them in one place:
 *
 *   kind                         'indexeddb' | 'localstorage' | 'memory'
 *   open()                       Promise<void>
 *   getAll(store)                Promise<record[]>
 *   get(store, id)               Promise<record | undefined>
 *   keys(store)                  Promise<string[]>
 *   commit(ops)                  Promise<void>, atomic where the backend allows it
 *                                ops: [{ store, id, value }], where value === null deletes
 *   clear()                      Promise<void>, empties every store
 *   close()                      void
 */
import { STORES } from './schema.js';

/** Bump when STORES gains an entry. onupgradeneeded creates whatever is missing. */
const DB_VERSION = 4;

export class IndexedDbAdapter {
  kind = 'indexeddb';

  constructor(name) {
    this.name = name;
    this.idb = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(this.name, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The notes database is blocked by another tab'));
      request.onsuccess = () => {
        this.idb = request.result;
        // Let a future version upgrade in another tab proceed instead of hanging.
        this.idb.onversionchange = () => this.idb.close();
        resolve();
      };
    });
  }

  _read(store, call) {
    return new Promise((resolve, reject) => {
      const request = call(this.idb.transaction(store, 'readonly').objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  getAll(store) {
    return this._read(store, (s) => s.getAll());
  }

  get(store, id) {
    return this._read(store, (s) => s.get(id));
  }

  keys(store) {
    return this._read(store, (s) => s.getAllKeys());
  }

  commit(ops) {
    if (!ops.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const names = [...new Set(ops.map((op) => op.store))];
      const tx = this.idb.transaction(names, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Save was aborted'));
      for (const op of ops) {
        const store = tx.objectStore(op.store);
        if (op.value === null) store.delete(op.id);
        else store.put(op.value);
      }
      // Without an explicit commit, the browser aborts an unfinished transaction when the page
      // closes, which would lose the last edits made just before closing or reloading.
      tx.commit?.();
    });
  }

  clear() {
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(STORES, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const store of STORES) tx.objectStore(store).clear();
    });
  }

  close() {
    this.idb?.close();
    this.idb = null;
  }
}

/** Fallback for browsers that block IndexedDB. Limited to about 5 MB, so images may not fit. */
export class LocalStorageAdapter {
  kind = 'localstorage';

  constructor(name) {
    this.prefix = `${name}:`;
  }

  async open() {
    const probe = `${this.prefix}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
  }

  _key(store, id) {
    return `${this.prefix}${store}:${id}`;
  }

  _storeKeys(store) {
    const start = `${this.prefix}${store}:`;
    const found = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key.startsWith(start)) found.push(key);
    }
    return found;
  }

  async getAll(store) {
    const records = [];
    for (const key of this._storeKeys(store)) {
      try {
        records.push(JSON.parse(localStorage.getItem(key)));
      } catch {
        // A corrupted entry must not stop the rest of the notes from loading.
      }
    }
    return records;
  }

  async get(store, id) {
    const raw = localStorage.getItem(this._key(store, id));
    return raw === null ? undefined : JSON.parse(raw);
  }

  async keys(store) {
    const start = `${this.prefix}${store}:`.length;
    return this._storeKeys(store).map((key) => key.slice(start));
  }

  async commit(ops) {
    // Roll back on failure (usually quota), matching the all-or-nothing IndexedDB behaviour.
    const undo = [];
    try {
      for (const op of ops) {
        const key = this._key(op.store, op.id);
        undo.push([key, localStorage.getItem(key)]);
        if (op.value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(op.value));
      }
    } catch (error) {
      for (const [key, old] of undo.reverse()) {
        try {
          if (old === null) localStorage.removeItem(key);
          else localStorage.setItem(key, old);
        } catch {
          // Restoring smaller previous data should not fail. If it does, the original error wins.
        }
      }
      throw error;
    }
  }

  async clear() {
    for (const store of STORES) {
      for (const key of this._storeKeys(store)) localStorage.removeItem(key);
    }
  }

  close() {}
}

/** Last resort when the browser allows no storage at all, and also used by tests. Nothing survives a reload. */
export class MemoryAdapter {
  kind = 'memory';

  stores = new Map(STORES.map((s) => [s, new Map()]));

  async open() {}

  async getAll(store) {
    return [...this.stores.get(store).values()];
  }

  async get(store, id) {
    return this.stores.get(store).get(id);
  }

  async keys(store) {
    return [...this.stores.get(store).keys()];
  }

  async commit(ops) {
    for (const op of ops) {
      if (op.value === null) this.stores.get(op.store).delete(op.id);
      else this.stores.get(op.store).set(op.id, op.value);
    }
  }

  async clear() {
    for (const map of this.stores.values()) map.clear();
  }

  close() {}
}

/** Opens the best available backend: IndexedDB, then localStorage, then memory. */
export async function openStorage(name = 'personal-notes') {
  for (const make of [() => new IndexedDbAdapter(name), () => new LocalStorageAdapter(name)]) {
    try {
      const adapter = make();
      await adapter.open();
      return adapter;
    } catch (error) {
      console.warn('Storage backend unavailable:', error);
    }
  }
  const memory = new MemoryAdapter();
  await memory.open();
  return memory;
}
