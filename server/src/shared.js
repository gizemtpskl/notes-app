/** shared.js: small things the sync API, the sign-in page and the tools all need. */

/** The one NotesStore that holds your notes. */
export function notesStore(env) {
  return env.NOTES.get(env.NOTES.idFromName('notes'));
}

export const MIN_KEY_LENGTH = 24;

/** Whether the access key is set, and long enough to be safe. */
export const keyIsSet = (env) => typeof env.ACCESS_KEY === 'string' && env.ACCESS_KEY.length >= MIN_KEY_LENGTH;

/** Compares a given key with the real one in constant time, so timing reveals nothing. */
export function keyMatches(given, real) {
  if (typeof given !== 'string' || typeof real !== 'string' || real.length < MIN_KEY_LENGTH) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(real);
  if (a.byteLength !== b.byteLength) {
    crypto.subtle.timingSafeEqual(b, b);
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
