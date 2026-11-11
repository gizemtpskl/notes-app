/**
 * calendarConnection.js: keeping Google Calendar in step. The sign-in itself is shared with
 * Drive sync, in googleAuth.js. An expired sign-in shows a button rather than popping up by
 * itself, since Google only allows asking from a click.
 */
import { app } from '../context.js';
import {
  WEEK_EVENTS_FRESH_MS, blockWindow, clearWeekEvents, readRangeEvents, removeAllBlockEvents, runBlockSync, saveWeekEvents,
  stopsTheRun, weekEventsAt,
} from '../data/calendarTimetable.js';
import { addDays, toDateStr } from '../data/dates.js';
import { fieldValue } from '../data/fieldKinds.js';
import {
  CALENDAR_SCOPE, CalendarAuthError, calendarConfig, createCalendarApi, removeAllEvents, runSync, saveEvents,
  updateCalendarConfig,
} from '../data/googleCalendar.js';
import { locate } from '../data/tasks.js';
import {
  forgetGoogleToken, googleSignIn, googleToken, hasGoogleToken, loadGoogleLibrary, registerGoogleFeature, revokeGoogleUnlessUsed,
} from './googleAuth.js';

const SYNC_DELAY_MS = 3000;
const RETRY_MS = 5 * 60000;
const SLOW_DOWN_MS = 60000;
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
  if (error?.reason === 'apiOff') return 'The Google Calendar API isn’t turned on in your Google project. Turn it on, wait a few minutes, then try again.';
  if (error?.reason === 'scope') return 'Google Calendar access wasn’t ticked on the Google page. Connect again and tick it.';
  if (error?.reason === 'rateLimit' || error?.status === 429) return 'Google asked to slow down. It’ll try again soon.';
  if (error?.status === 403) return 'Google refused this. Check that the Google Calendar API is turned on in your Google project and that your account is a test user.';
  if (error?.status) return 'Google Calendar had a problem. It’ll try again soon.';
  return "Couldn't reach Google Calendar.";
}

/**
 * What a block that's a task says in the calendar: the task as it is now. A task in a private note
 * only ever shows as "Busy", so its words stay on this device.
 */
function blockTitle(o) {
  if (!o.task) return o.title;
  const { db } = app;
  const note = db.getNote(o.task.noteId);
  if (!note || note.trashedAt) return o.title;
  if (note.private) return 'Busy';
  const field = db.getType(note.typeId).fields.find((f) => f.id === o.task.fieldId);
  const found = field ? locate(fieldValue(note, field), o.task.taskId) : null;
  return found ? `${found.item.done ? '✓ ' : ''}${found.item.text || 'Task'}` : o.title;
}

/** Tasks that have a block on the timetable: when blocks go to the calendar, the block stands for them. */
function tasksWithBlocks(db, today) {
  const { from } = blockWindow(today);
  return new Set(db.listBlocks().filter((b) => b.task && (b.repeat || b.date >= from)).map((b) => b.task.taskId));
}

async function syncOnce({ refreshEvents }) {
  const { db } = app;
  const today = toDateStr();
  const config = calendarConfig(db);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tasks = await runSync(db, api(), { today, timeZone, skip: config.blocks ? tasksWithBlocks(db, today) : new Set() });
  const blocks = await runBlockSync(db, api(), {
    today, timeZone, send: config.blocks, titleFor: blockTitle,
  });
  if (refreshEvents) {
    saveEvents(db, today, await api().listDay(today));
    lastEvents = Date.now();
  }
  updateCalendarConfig(db, { lastSync: Date.now() });
  return Object.fromEntries(Object.keys(tasks).map((count) => [count, tasks[count] + blocks[count]]));
}

const loadingWeeks = new Set();

/**
 * Reads one week of events for the timetable, unless it was read in the last few minutes. Quietly
 * does nothing when signed out or offline: the copy from last time is shown meanwhile.
 */
export async function refreshWeekEvents(weekFrom, { force = false } = {}) {
  const { db } = app;
  const config = calendarConfig(db);
  if (!config.on || !config.showEvents || !hasToken() || !navigator.onLine || loadingWeeks.has(weekFrom)) return;
  if (!force && Date.now() - weekEventsAt(db, weekFrom) < WEEK_EVENTS_FRESH_MS) return;
  loadingWeeks.add(weekFrom);
  try {
    const to = addDays(weekFrom, 6);
    saveWeekEvents(db, weekFrom, readRangeEvents(await api().listRange(weekFrom, to), weekFrom, to));
  } catch (error) {
    if (error instanceof CalendarAuthError) {
      forgetGoogleToken();
      setStatus('signed-out');
    } else {
      console.warn('Calendar events:', error);
      setStatus('error', explain(error));
    }
  } finally {
    loadingWeeks.delete(weekFrom);
  }
}

/** Turns showing the calendar's events on the timetable on or off. */
export function setShowEvents(on) {
  updateCalendarConfig(app.db, { showEvents: on });
  if (!on) clearWeekEvents(app.db);
}

/** Turns sending timetable blocks on or off. Off removes the ones already sent, at the next sync. */
export function setSendBlocks(on) {
  updateCalendarConfig(app.db, { blocks: on });
  syncCalendar({ refreshEvents: false });
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
      if (result.failed) scheduleSync(RETRY_MS);
      return result;
    })
    .catch((error) => {
      if (error instanceof CalendarAuthError) {
        forgetGoogleToken();
        setStatus('signed-out');
      } else {
        console.warn('Calendar sync:', error);
        setStatus('error', explain(error));
        // Lots of new events at once can make Google ask to slow down. What's done so far is kept.
        if (stopsTheRun(error)) scheduleSync(SLOW_DOWN_MS);
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

function scheduleSync(delay = SYNC_DELAY_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => syncCalendar({ refreshEvents: false }), delay);
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
    failed += await removeAllBlockEvents(db, api());
  }
  clearTimeout(timer);
  updateCalendarConfig(db, { on: false });
  clearWeekEvents(db);
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
    if ((change.stores.has('notes') || change.stores.has('timeBlocks') || change.stores.has('semesters')) && hasToken()) scheduleSync();
  });
  window.addEventListener('online', () => {
    if (hasToken()) syncCalendar();
  });
  // Coming back to the app is when events are most likely to be out of date.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hasToken() && Date.now() - lastEvents > EVENTS_REFRESH_MS) syncCalendar();
  });
}
