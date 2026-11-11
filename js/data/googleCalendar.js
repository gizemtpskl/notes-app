/**
 * googleCalendar.js: the optional link with Google Calendar, with no user interface. It's off until
 * it's set up in Settings, and nothing here contacts Google before then.
 *
 * Two things happen, and they stay separate so that neither can feed the other:
 *   - Tasks with a date and a time become events, and so do timetable blocks (calendarTimetable.js).
 *     This app decides what they say, so a task changed here updates its event. Changing the event
 *     in Google Calendar doesn't change the task.
 *   - The calendar's other events are copied in, to show on the Today page and the timetable. They
 *     are only ever read. Events this app made carry a private mark and are never copied in.
 *
 * An event's id is worked out from its task's id. Creating the same task twice therefore finds the
 * event from the first time instead of making a copy, even after a crash or a restored backup.
 *
 * Tasks in notes marked private never leave this device. All of this is stored in `meta`, which
 * backups leave out, and the access token is never stored at all.
 */
import { addDays, parseDate } from './dates.js';
import { fieldValue } from './fieldKinds.js';
import { readGoogleErrorReason } from './googleErrors.js';
import { flatten } from './tasks.js';
import { tasksFields } from './types.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CONFIG_KEY = 'gcalConfig';
const LINKS_KEY = 'gcalLinks';
const EVENTS_KEY = 'gcalEvents';
const EVENT_MINUTES = 30;
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

/** The token has expired or was refused, so someone has to sign in again. */
export class CalendarAuthError extends Error {}

/** Any other answer from Google. `reason` is Google's own short code, when it gave one. */
export class CalendarError extends Error {
  constructor(message, status, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// -- What's stored -------------------------------------------------------------------------

export const isClientId = (value) => CLIENT_ID.test(value);

/**
 * { clientId, on, lastSync, blocks, showEvents }. blocks: timetable blocks go to the calendar.
 * showEvents: the calendar's events show on the timetable. Both start on.
 */
export function calendarConfig(db) {
  return {
    clientId: '', on: false, lastSync: 0, blocks: true, showEvents: true, ...db.getMeta(CONFIG_KEY),
  };
}

export function updateCalendarConfig(db, patch) {
  db.setMeta(CONFIG_KEY, { ...calendarConfig(db), ...patch });
}

export const syncLinks = (db) => db.getMeta(LINKS_KEY) ?? {};

// -- Tasks to events -----------------------------------------------------------------------

const TEXT = new TextEncoder();

/** Task id to event id. Google allows only a-v and 0-9, which hex always fits. */
export function eventIdFor(taskId) {
  return `n${[...TEXT.encode(taskId)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Every task that can go to the calendar: it has a date and a time, and its note isn't private.
 * Tasks in `skip` are left out: those given a block on the timetable, when blocks go as events.
 */
export function syncableTasks(db, skip = new Set()) {
  const tasks = [];
  for (const note of db.listNotes()) {
    if (!note.private) {
      const type = db.getType(note.typeId);
      for (const field of tasksFields(type)) {
        for (const { item } of flatten(fieldValue(note, field))) {
          if (item.due && item.time && !skip.has(item.id)) tasks.push(item);
        }
      }
    }
  }
  return tasks;
}

// The end joins only when set, so tasks synced before ends existed aren't all sent again.
const fingerprint = (task) => JSON.stringify([task.text, task.due, task.time, task.done, ...(task.end ? [task.end] : [])]);

/**
 * What needs doing to bring the calendar up to date: { create, update, remove }. links holds each
 * synced task's fingerprint. Old or finished tasks aren't added for the first time, because a first
 * sync shouldn't fill the past with events, but a task that's already there is kept up to date.
 */
export function planSync(tasks, links, today) {
  const create = [];
  const update = [];
  for (const task of tasks) {
    if (!(task.id in links)) {
      if (!task.done && task.due >= today) create.push(task);
    } else if (links[task.id] !== fingerprint(task)) {
      update.push(task);
    }
  }
  const present = new Set(tasks.map((task) => task.id));
  return { create, update, remove: Object.keys(links).filter((id) => !present.has(id)) };
}

function endOf(due, time) {
  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute + EVENT_MINUTES;
  const clock = `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return { date: total >= 1440 ? addDays(due, 1) : due, clock };
}

export function eventBody(task, timeZone) {
  const end = task.end > task.time ? { date: task.due, clock: task.end } : endOf(task.due, task.time);
  return {
    summary: `${task.done ? '✓ ' : ''}${task.text || 'Task'}`,
    start: { dateTime: `${task.due}T${task.time}:00`, timeZone },
    end: { dateTime: `${end.date}T${end.clock}:00`, timeZone },
    status: 'confirmed',
    extendedProperties: { private: { notesApp: '1' } },
  };
}

/** Brings the calendar up to date. Returns { created, updated, removed, failed }. */
export async function runSync(db, api, { today, timeZone, skip }) {
  const links = { ...syncLinks(db) };
  const plan = planSync(syncableTasks(db, skip), links, today);
  const result = {
    created: 0, updated: 0, removed: 0, failed: 0,
  };
  // One failure shouldn't stop the rest, but an expired sign-in stops everything.
  const attempt = async (work, count) => {
    try {
      await work();
      result[count] += 1;
    } catch (error) {
      // A sign-in that ran out, or Google asking to slow down, ends the run. It's tried again later.
      if (error instanceof CalendarAuthError || error?.reason === 'rateLimit' || error?.status === 429) throw error;
      console.warn('Calendar sync:', error);
      result.failed += 1;
    }
  };
  try {
    for (const task of plan.create) {
      await attempt(async () => {
        await api.put(eventIdFor(task.id), eventBody(task, timeZone));
        links[task.id] = fingerprint(task);
      }, 'created');
    }
    for (const task of plan.update) {
      await attempt(async () => {
        await api.update(eventIdFor(task.id), eventBody(task, timeZone));
        links[task.id] = fingerprint(task);
      }, 'updated');
    }
    for (const id of plan.remove) {
      await attempt(async () => {
        await api.remove(eventIdFor(id));
        delete links[id];
      }, 'removed');
    }
  } finally {
    // Whatever got done stays recorded, even if a sign-in ran out halfway.
    if (result.created || result.updated || result.removed) db.setMeta(LINKS_KEY, links);
  }
  return result;
}

/** Removes every event this app has added. Returns how many failed. */
export async function removeAllEvents(db, api) {
  const links = { ...syncLinks(db) };
  let failed = 0;
  try {
    for (const id of Object.keys(links)) {
      try {
        await api.remove(eventIdFor(id));
        delete links[id];
      } catch (error) {
        if (error instanceof CalendarAuthError) throw error;
        console.warn('Calendar removal:', error);
        failed += 1;
      }
    }
  } finally {
    db.setMeta(LINKS_KEY, links);
  }
  return failed;
}

// -- Events to the Today page --------------------------------------------------------------

/** One event from Google, as a row for the Today page, or null if it shouldn't be shown. */
export function readEvent(raw, today) {
  if (raw.status === 'cancelled' || raw.eventType === 'workingLocation') return null;
  if (raw.extendedProperties?.private?.notesApp) return null; // One of ours: it's already a task.
  if (raw.attendees?.some((person) => person.self && person.responseStatus === 'declined')) return null;
  const started = raw.start?.dateTime ? new Date(raw.start.dateTime) : null;
  const startsToday = started && !Number.isNaN(started.getTime())
    && started.getFullYear() === parseDate(today).getFullYear()
    && started.getMonth() === parseDate(today).getMonth()
    && started.getDate() === parseDate(today).getDate();
  return {
    id: String(raw.id),
    text: raw.summary?.trim() || 'Busy',
    // All day, or carried over from yesterday: there's no time today to show.
    time: startsToday ? `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}` : '',
    url: typeof raw.htmlLink === 'string' && raw.htmlLink.startsWith('https://') ? raw.htmlLink : '',
  };
}

/** Keeps today's events, along with which of them are ticked off, so a refresh doesn't undo a tick. */
export function saveEvents(db, today, items) {
  const saved = db.getMeta(EVENTS_KEY);
  const previous = saved?.day === today ? saved.doneAt : {};
  const doneAt = {};
  for (const item of items) if (previous[item.id]) doneAt[item.id] = previous[item.id];
  db.setMeta(EVENTS_KEY, { day: today, items, doneAt });
}

export function clearEvents(db) {
  db.setMeta(EVENTS_KEY, null);
}

/** Today's events, shaped like tasks for the agenda. Yesterday's copy is never shown. */
export function eventEntries(db, today) {
  const saved = db.getMeta(EVENTS_KEY);
  if (saved?.day !== today) return [];
  return saved.items.map((event) => ({
    item: {
      id: event.id,
      text: event.text,
      due: today,
      time: event.time,
      done: Boolean(saved.doneAt[event.id]),
      doneAt: saved.doneAt[event.id] ?? null,
      priority: 0,
      children: [],
    },
    parent: null,
    noteTitle: 'Google Calendar',
    url: event.url,
    isEvent: true,
  }));
}

/** Ticks an event off here only. The calendar is never changed by it. */
export function toggleEventDone(db, id, now = Date.now()) {
  const saved = db.getMeta(EVENTS_KEY);
  if (!saved) return;
  const doneAt = { ...saved.doneAt };
  if (doneAt[id]) delete doneAt[id];
  else doneAt[id] = now;
  db.setMeta(EVENTS_KEY, { ...saved, doneAt });
}

// -- Talking to Google ---------------------------------------------------------------------

/** The Calendar API. getToken returns the current token. fetchFn is replaceable for tests. */
export function createCalendarApi(getToken, fetchFn = (...args) => fetch(...args)) {
  async function send(url, options = {}) {
    const response = await fetchFn(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.ok) return response.status === 204 ? null : response.json();
    if (response.status === 401) throw new CalendarAuthError('Sign in again.');
    const reason = await readGoogleErrorReason(response);
    throw new CalendarError(`Google Calendar answered ${response.status}`, response.status, reason);
  }

  const patch = (id, body) => send(`${EVENTS_URL}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  return {
    /** Creates the event, or updates it if this id already exists. Also brings back a deleted one. */
    async put(id, body) {
      try {
        await send(EVENTS_URL, { method: 'POST', body: JSON.stringify({ ...body, id }) });
      } catch (error) {
        if (error.status === 409) await patch(id, body);
        else throw error;
      }
    },

    /** Changes an event made before. If it's gone from the calendar altogether, it's made again. */
    async update(id, body) {
      try {
        await patch(id, body);
      } catch (error) {
        if (error.status === 404 || error.status === 410) await send(EVENTS_URL, { method: 'POST', body: JSON.stringify({ ...body, id }) });
        else throw error;
      }
    },

    /** Removes an event. One that's already gone counts as done. */
    async remove(id) {
      try {
        await send(`${EVENTS_URL}/${id}`, { method: 'DELETE' });
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error;
      }
    },

    /** The events on one day, as rows for the Today page. */
    async listDay(today) {
      const params = new URLSearchParams({
        timeMin: parseDate(today).toISOString(),
        timeMax: parseDate(addDays(today, 1)).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '100',
        fields: 'items(id,status,summary,htmlLink,start,eventType,extendedProperties/private,attendees(self,responseStatus))',
      });
      const data = await send(`${EVENTS_URL}?${params}`);
      return (data.items ?? []).map((raw) => readEvent(raw, today)).filter(Boolean);
    },

    /** Every event from the start of `from` to the end of `to`, as Google sends them. */
    async listRange(from, to) {
      const items = [];
      let pageToken = '';
      do {
        const params = new URLSearchParams({
          timeMin: parseDate(from).toISOString(),
          timeMax: parseDate(addDays(to, 1)).toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
          fields: 'nextPageToken,items(id,status,summary,htmlLink,start,end,eventType,extendedProperties/private,attendees(self,responseStatus))',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await send(`${EVENTS_URL}?${params}`);
        items.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? '';
      } while (pageToken);
      return items;
    },
  };
}
