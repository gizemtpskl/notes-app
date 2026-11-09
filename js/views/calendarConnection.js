/**
 * calendarConnection.js: signing in to Google and keeping the calendar in step.
 *
 * Google's sign-in library only loads once Google Calendar has been set up in Settings, and the
 * access token stays in memory, so it's gone after a reload. Google only allows asking for a new
 * one from a click, so an expired sign-in shows a button rather than popping up by itself.
 */
import { app } from '../context.js';
import { toDateStr } from '../data/dates.js';
import {
  CALENDAR_SCOPE, CalendarAuthError, calendarConfig, createCalendarApi, removeAllEvents, runSync, saveEvents,
  updateCalendarConfig,
} from '../data/googleCalendar.js';
import { h } from '../ui/dom.js';

const LIBRARY_URL = 'https://accounts.google.com/gsi/client';
const SYNC_DELAY_MS = 3000;
const EVENTS_REFRESH_MS = 10 * 60000;
const EXPIRY_MARGIN_MS = 60000;

let token = '';
let tokenExpires = 0;
let library = null;
let timer = null;
let running = null;
let again = false;
let lastEvents = 0;
const listeners = new Set();

/** idle, syncing, signed-out or error. message explains an error. */
const status = { state: 'signed-out', message: '' };

function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  for (const listener of listeners) listener();
}

export function onCalendarStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const calendarStatus = () => status;

const hasToken = () => Boolean(token) && Date.now() < tokenExpires - EXPIRY_MARGIN_MS;

function forgetToken() {
  token = '';
  tokenExpires = 0;
}

const api = () => createCalendarApi(() => token);

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

/** Asks Google for a token. Call this straight from a click. */
async function signIn(clientId) {
  const google = await loadGoogleLibrary();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CALENDAR_SCOPE,
      prompt: '',
      callback: (response) => {
        if (!response?.access_token) {
          reject(new Error(response?.error === 'access_denied' ? 'Google Calendar access was declined.' : "Google didn't allow the sign-in. Check the steps above."));
        } else if (!google.accounts.oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE)) {
          reject(new Error('Google Calendar access wasn’t ticked on the Google page. Connect again and tick it.'));
        } else {
          token = response.access_token;
          tokenExpires = Date.now() + Number(response.expires_in ?? 3600) * 1000;
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

function explain(error) {
  if (error?.reason === 'accessNotConfigured') return 'The Google Calendar API isn’t turned on in your Google project yet.';
  if (error?.status === 403) return 'Google refused this. Check that your account is listed as a test user.';
  if (error?.status === 429) return 'Google asked to slow down. It’ll try again soon.';
  if (error?.status) return 'Google Calendar had a problem. It’ll try again soon.';
  return "Couldn't reach Google Calendar.";
}

async function syncOnce({ refreshEvents }) {
  const { db } = app;
  const today = toDateStr();
  const result = await runSync(db, api(), { today, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (refreshEvents) {
    saveEvents(db, today, await api().listDay(today));
    lastEvents = Date.now();
  }
  updateCalendarConfig(db, { lastSync: Date.now() });
  return result;
}

/** Syncs now if signed in and online. Overlapping calls are merged into one more run afterwards. */
export function syncCalendar({ refreshEvents = true } = {}) {
  if (!hasToken()) {
    if (calendarConfig(app.db).on) setStatus('signed-out');
    return Promise.resolve(null);
  }
  if (!navigator.onLine) return Promise.resolve(null);
  if (running) {
    again = true;
    return running;
  }
  setStatus('syncing');
  running = syncOnce({ refreshEvents })
    .then((result) => {
      setStatus(result.failed ? 'error' : 'idle', result.failed ? `${result.failed} couldn’t be sent. It’ll try again.` : '');
      return result;
    })
    .catch((error) => {
      if (error instanceof CalendarAuthError) {
        forgetToken();
        setStatus('signed-out');
      } else {
        console.warn('Calendar sync:', error);
        setStatus('error', explain(error));
      }
      return null;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        scheduleSync();
      }
    });
  return running;
}

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => syncCalendar({ refreshEvents: false }), SYNC_DELAY_MS);
}

/** Signs in if needed, then syncs. For buttons. On success, the calendar link counts as on. */
export async function connectCalendar(clientId) {
  try {
    if (!hasToken()) await signIn(clientId);
    updateCalendarConfig(app.db, { clientId, on: true });
    return await syncCalendar();
  } catch (error) {
    setStatus(calendarConfig(app.db).on ? 'signed-out' : 'error', error.message);
    return null;
  }
}

/**
 * Turns the link off. It can also remove the events added so far, which needs a sign-in. Returns how
 * many couldn't be removed. Throws if signing in was needed and didn't work.
 */
export async function disconnectCalendar({ removeEvents }) {
  const { db } = app;
  let failed = 0;
  if (removeEvents) {
    if (!hasToken()) await signIn(calendarConfig(db).clientId);
    failed = await removeAllEvents(db, api());
  }
  if (token && window.google) window.google.accounts.oauth2.revoke(token, () => {});
  forgetToken();
  clearTimeout(timer);
  updateCalendarConfig(db, { on: false });
  setStatus('signed-out');
  return failed;
}

/** Runs once at startup. Does nothing at all until the calendar has been set up. */
export function startCalendarSync() {
  const { db } = app;
  if (calendarConfig(db).on) loadGoogleLibrary().catch(() => {}); // Ready for the first click.
  db.on((change) => {
    if (change.stores.has('notes') && hasToken()) scheduleSync();
  });
  window.addEventListener('online', () => {
    if (hasToken()) syncCalendar();
  });
  // Coming back to the app is when events are most likely to be out of date.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hasToken() && Date.now() - lastEvents > EVENTS_REFRESH_MS) syncCalendar();
  });
}
