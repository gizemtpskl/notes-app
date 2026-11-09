/**
 * crypto.js: the optional passcode lock, using the browser's Web Crypto API.
 *
 * HOW IT WORKS
 *   - A random 256-bit data key encrypts every record with AES-GCM.
 *   - The passcode never encrypts data directly and is never stored. PBKDF2 (SHA-256) turns it into
 *     a second key, which only protects ("wraps") the data key. So changing the passcode doesn't
 *     have to re-encrypt everything.
 *   - The only thing stored in the clear is the lock record: salt, iteration count and wrapped key.
 *     Record ids also stay readable, since storage looks records up by id. They are random
 *     for notes, so they reveal nothing about content.
 *
 * Without the passcode the data key can't be recovered, and neither can the notes. There is no
 * back door, on purpose. That is why the lock is opt-in and comes with a clear warning.
 *
 * EncryptedAdapter wraps any storage adapter from storage.js and has the same interface, so nothing
 * else in the app knows whether encryption is on.
 */

const ITERATIONS = 600000;
const LOCK_ID = 'lock';
const LOCK_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class WrongPasscodeError extends Error {
  constructor() {
    super('That passcode is not correct.');
    this.name = 'WrongPasscodeError';
  }
}

/** Web Crypto only exists on https and localhost. */
export function isCryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle);
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function passcodeKey(passcode, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt, iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function wrapDataKey(dataKey, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapper = await passcodeKey(passcode, salt, ITERATIONS);
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, wrapper, { name: 'AES-GCM', iv });
  return {
    id: LOCK_ID,
    version: LOCK_VERSION,
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
}

/** Unwraps the data key. A wrong passcode fails AES-GCM's built-in integrity check. */
export async function openLock(record, passcode, { extractable = false } = {}) {
  const wrapper = await passcodeKey(passcode, fromBase64(record.salt), record.iterations);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      fromBase64(record.wrappedKey),
      wrapper,
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPasscodeError();
  }
}

/** A new data key, and the lock record protecting it. */
export async function createLock(passcode) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { key, record: await wrapDataKey(key, passcode) };
}

/** Protects the same data key with a new passcode. The notes aren't touched. */
export async function changePasscodeRecord(record, oldPasscode, newPasscode) {
  const key = await openLock(record, oldPasscode, { extractable: true });
  return wrapDataKey(key, newPasscode);
}

export async function encryptValue(key, value, { asText = false } = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  const joined = new Uint8Array(iv.length + data.byteLength);
  joined.set(iv);
  joined.set(new Uint8Array(data), iv.length);
  return asText ? toBase64(joined) : joined;
}

export async function decryptValue(key, stored) {
  const joined = typeof stored === 'string' ? fromBase64(stored) : stored;
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: joined.subarray(0, 12) }, key, joined.subarray(12));
  return JSON.parse(decoder.decode(data));
}

const isLockRecord = (store, id) => store === 'meta' && id === LOCK_ID;

export class EncryptedAdapter {
  encrypted = true;

  constructor(inner, key) {
    this.inner = inner;
    this.key = key;
    this.kind = inner.kind;
    // localStorage can only hold text. IndexedDB stores bytes directly, which saves a third of the space.
    this.asText = inner.kind === 'localstorage';
  }

  async open() {}

  async _pack(id, value) {
    return { id, enc: await encryptValue(this.key, value, { asText: this.asText }) };
  }

  async getAll(store) {
    const records = await this.inner.getAll(store);
    const opened = await Promise.all(records
      .filter((record) => !isLockRecord(store, record.id))
      .map(async (record) => {
        try {
          return await decryptValue(this.key, record.enc);
        } catch (error) {
          // A damaged record must not stop the rest of the notes from opening.
          console.warn(`Could not read a record in ${store}:`, error);
          return null;
        }
      }));
    return opened.filter(Boolean);
  }

  async get(store, id) {
    const record = await this.inner.get(store, id);
    if (!record) return undefined;
    if (isLockRecord(store, id)) return record;
    return decryptValue(this.key, record.enc);
  }

  async keys(store) {
    const keys = await this.inner.keys(store);
    return store === 'meta' ? keys.filter((id) => id !== LOCK_ID) : keys;
  }

  async commit(ops) {
    const packed = await Promise.all(ops.map(async (op) => ({
      store: op.store,
      id: op.id,
      value: op.value === null || isLockRecord(op.store, op.id) ? op.value : await this._pack(op.id, op.value),
    })));
    return this.inner.commit(packed);
  }

  clear() {
    return this.inner.clear();
  }

  close() {
    this.inner.close();
  }
}

/** Reads the lock record, if the lock is on. */
export function readLock(storage) {
  return storage.get('meta', LOCK_ID);
}

/**
 * Turns the lock on: encrypts every stored record in one transaction, so a failure part way
 * leaves everything as it was. Returns the adapter to use from now on.
 */
export async function enableLock(plain, stores, passcode) {
  const { key, record } = await createLock(passcode);
  const adapter = new EncryptedAdapter(plain, await crypto.subtle.exportKey('raw', key).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])));
  const ops = [{ store: 'meta', id: LOCK_ID, value: record }];
  for (const store of stores) {
    for (const value of await plain.getAll(store)) {
      ops.push({ store, id: value.id, value: await adapter._pack(value.id, value) });
    }
  }
  await plain.commit(ops);
  return adapter;
}

/** Turns the lock off: decrypts every record in one transaction. Returns the plain adapter. */
export async function disableLock(adapter, stores) {
  const ops = [{ store: 'meta', id: LOCK_ID, value: null }];
  for (const store of stores) {
    for (const value of await adapter.getAll(store)) ops.push({ store, id: value.id, value });
  }
  await adapter.inner.commit(ops);
  return adapter.inner;
}

/** Replaces the passcode. Requires the current one. */
export async function changePasscode(adapter, oldPasscode, newPasscode) {
  const record = await adapter.inner.get('meta', LOCK_ID);
  const next = await changePasscodeRecord(record, oldPasscode, newPasscode);
  await adapter.inner.commit([{ store: 'meta', id: LOCK_ID, value: next }]);
}
