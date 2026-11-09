/**
 * calendarConnection.js: keeping Google Calendar in step. The sign-in itself is shared with
 * Drive sync, in googleAuth.js. An expired sign-in shows a button rather than popping up by
 * itself, since Google only allows asking from a click.
 */
import { app } from '../context.js';
import { toDateStr } from '../data/dates.js';
import {
  CALENDAR_SCOPE, CalendarAuthError, calendarConfig, createCalendarApi, removeAllEvents, runSync, saveEvents,
  updateCalendarConfig,
} from '../data/googleCalendar.js';
import {
  forgetGoogleToken, googleSignIn, googleToken, hasGoogleToken, loadGoogleLibrary, registerGoogleFeature, revokeGoogleUnlessUsed,
} from './googleAuth.js';

const SYNC_DELAY_MS = 3000;
const EVENTS_REFRESH_MS = 10 * 60000;

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

const hasToken = () => hasGoogleToken(CALENDAR_SCOPE);
const api = () => createCalendarApi(googleToken);
const signIn = (clientId) => googleSignIn(clientId, CALENDAR_SCOPE, 'Google Calendar');

export { loadGoogleLibrary };

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
        forgetGoogleToken();
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
  clearTimeout(timer);
  updateCalendarConfig(db, { on: false });
  revokeGoogleUnlessUsed();
  setStatus('signed-out');
  return failed;
}

/** Runs once at startup. Does nothing at all until the calendar has been set up. */
export function startCalendarSync() {
  const { db } = app;
  registerGoogleFeature('calendar', { scope: CALENDAR_SCOPE, isOn: () => calendarConfig(db).on });
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
