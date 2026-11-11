/**
 * reminders.js: timetable reminders while the app is open.
 *
 * A static site has no server to send notifications when it's closed, so reminders only work
 * while the app is open in a tab. Each one shows inside the app, and as a system notification
 * when the browser allows it. Which ones were shown today is remembered, so a reload doesn't
 * repeat them.
 */
import { app } from '../context.js';
import { toDateStr } from '../data/dates.js';
import { dueReminders } from '../data/reminders.js';
import { toast } from '../ui/toast.js';
import { loadOccurrences } from './timetable.js';

const CHECK_MS = 30000;
const SHOWN_KEY = 'remindersShown';

export function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, tag, icon: 'icons/icon-192.png' };
  // Through the service worker where there is one: some phones only allow it that way.
  const viaWorker = navigator.serviceWorker?.controller
    ? navigator.serviceWorker.ready.then((registration) => registration.showNotification(title, options))
    : Promise.reject(new Error('No service worker'));
  viaWorker.catch(() => {
    try {
      new Notification(title, options); // eslint-disable-line no-new
    } catch {
      // Notifications aren't possible here. The message inside the app is enough.
    }
  });
}

/** Checks now. Exported so tests and the page can run it straight away. */
export function checkReminders(now = new Date()) {
  const { db } = app;
  const blocks = db.listBlocks().filter((b) => b.reminder);
  if (!blocks.length) return [];
  const date = toDateStr(now);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const saved = db.getMeta(SHOWN_KEY);
  const shown = new Set(saved?.day === date ? saved.keys : []);
  const due = dueReminders(loadOccurrences(db, date, date), new Map(blocks.map((b) => [b.id, b])), { date, time }, shown);
  for (const reminder of due) {
    const when = reminder.minutes <= 1 ? 'now' : `in ${reminder.minutes} minutes`;
    const text = `${reminder.title} starts ${when}, at ${reminder.start}${reminder.location ? `, ${reminder.location}` : ''}.`;
    toast(text, { action: { label: 'Open', run: () => app.navigate(`timetable?date=${date}&view=day`) }, duration: 20000 });
    notify(reminder.title, `Starts ${when}, at ${reminder.start}${reminder.location ? ` · ${reminder.location}` : ''}`, reminder.key);
    shown.add(reminder.key);
  }
  if (due.length) db.setMeta(SHOWN_KEY, { day: date, keys: [...shown] });
  return due;
}

export function startReminders() {
  setInterval(() => checkReminders(), CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkReminders();
  });
  checkReminders();
}
