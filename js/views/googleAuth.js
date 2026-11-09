/**
 * googleAuth.js: one Google sign-in for everything that uses Google (Calendar, Drive sync).
 *
 * Google's sign-in library only loads once something Google has been set up. The access token
 * stays in memory, so it's gone after a reload, and Google only allows asking for a new one from
 * a click. Each sign-in asks for every Google feature that's switched on, so one click covers
 * them all. Features say what they need with registerGoogleFeature().
 */
import { h } from '../ui/dom.js';

const LIBRARY_URL = 'https://accounts.google.com/gsi/client';
const EXPIRY_MARGIN_MS = 60000;

let token = '';
let tokenExpires = 0;
let granted = new Set();
let library = null;
const features = new Map();
const listeners = new Set();

/** feature: { scope, isOn(), label }. label names it in messages, such as "Google Drive". */
export function registerGoogleFeature(name, feature) {
  features.set(name, feature);
}

/** Called whenever the sign-in starts or ends. */
export function onGoogleAuth(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const notify = () => listeners.forEach((listener) => listener());

export const googleToken = () => token;

/** Signed in, with the scope given, for at least another minute. */
export function hasGoogleToken(scope) {
  return Boolean(token) && Date.now() < tokenExpires - EXPIRY_MARGIN_MS && (!scope || granted.has(scope));
}

export function forgetGoogleToken() {
  token = '';
  tokenExpires = 0;
  granted = new Set();
  notify();
}

/** Loads Google's library. Doing this ahead of the click keeps the sign-in window from being blocked. */
export function loadGoogleLibrary() {
  library ??= new Promise((resolve, reject) => {
    // Google asks for this on plain http, which in practice means localhost.
    if (location.protocol === 'http:') document.head.append(h('meta', { name: 'referrer', content: 'no-referrer-when-downgrade' }));
    const script = document.createElement('script');
    script.src = LIBRARY_URL;
    script.async = true;
    script.addEventListener('load', () => resolve(window.google));
    script.addEventListener('error', () => {
      library = null;
      script.remove();
      reject(new Error("Couldn't reach Google. Check your connection and try again."));
    });
    document.head.append(script);
  });
  return library;
}

/**
 * Asks Google for a token covering `scope` and every other Google feature that's on. Call this
 * straight from a click. Rejects with a plain-English message.
 */
export async function googleSignIn(clientId, scope, label) {
  const google = await loadGoogleLibrary();
  const scopes = new Set([scope, ...[...features.values()].filter((f) => f.isOn()).map((f) => f.scope)]);
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: [...scopes].join(' '),
      prompt: '',
      callback: (response) => {
        if (!response?.access_token) {
          reject(new Error(response?.error === 'access_denied' ? `${label} access was declined.` : "Google didn't allow the sign-in. Check the steps above."));
        } else if (!google.accounts.oauth2.hasGrantedAllScopes(response, scope)) {
          reject(new Error(`${label} access wasn’t ticked on the Google page. Connect again and tick it.`));
        } else {
          token = response.access_token;
          tokenExpires = Date.now() + Number(response.expires_in ?? 3600) * 1000;
          granted = new Set([...scopes].filter((s) => google.accounts.oauth2.hasGrantedAllScopes(response, s)));
          notify();
          resolve();
        }
      },
      error_callback: (error) => {
        reject(new Error(error?.type === 'popup_failed_to_open'
          ? 'Your browser blocked the Google window. Allow pop-ups for this site, then try again.'
          : 'The Google window closed before signing in finished.'));
      },
    });
    client.requestAccessToken();
  });
}

/** Ends access for this app, unless another Google feature is still on. */
export function revokeGoogleUnlessUsed() {
  const stillUsed = [...features.values()].some((f) => f.isOn());
  if (!stillUsed && token && window.google) window.google.accounts.oauth2.revoke(token, () => {});
  if (!stillUsed) forgetGoogleToken();
}
