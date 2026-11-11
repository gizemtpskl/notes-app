/**
 * agenda.js: what a day and a week hold, across the timetable, tasks, deadlines and calendar
 * events. Pure functions: the dashboard gathers the pieces and passes them in.
 *
 *   occurrences  timetable occurrences (timetable.js)
 *   entries      task and deadline entries ({ item, noteId, isDeadline, isEvent, ... })
 *
 * An agenda item:
 *   { key, kind: 'block' | 'task' | 'deadline' | 'event', date, time, end, title, done, overdue, source }
 * time is "HH:MM" or '' for something with no time of day.
 */
import { addDays } from './dates.js';
import { toMinutes } from './timetable.js';

const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title);

function fromOccurrence(o) {
  return {
    key: `block:${o.key}`, kind: 'block', date: o.date, time: o.start, end: o.end, title: o.title, done: false, overdue: false, source: o,
  };
}

function fromEntry(entry, today) {
  const { item } = entry;
  const kind = entry.isEvent ? 'event' : entry.isDeadline ? 'deadline' : 'task';
  return {
    key: `${kind}:${item.id}`,
    kind,
    date: item.due,
    time: item.time ?? '',
    end: (item.time && item.end) || '',
    title: item.text || (kind === 'task' ? 'Task' : 'Untitled'),
    done: Boolean(item.done),
    overdue: !item.done && item.due < today,
    source: entry,
  };
}

/** A task given a time on the timetable shows once, as its block, not twice. */
function scheduledTaskIds(occurrences) {
  return new Set(occurrences.filter((o) => o.task && !o.cancelled).map((o) => o.task.taskId));
}

/**
 * Today, in order: what has a time, by time, then the rest, overdue first. Each timed item is
 * also marked now, next or past, from `time` ("HH:MM").
 */
export function dayAgenda({ occurrences, entries }, today, time) {
  const live = occurrences.filter((o) => o.date === today && !o.cancelled);
  const scheduled = scheduledTaskIds(live);
  const items = [
    ...live.map(fromOccurrence),
    ...entries
      .filter((entry) => !scheduled.has(entry.item.id))
      .filter((entry) => entry.item.due === today || (entry.item.due && entry.item.due < today && !entry.item.done))
      .map((entry) => fromEntry(entry, today)),
  ];
  const timed = items.filter((i) => i.time && !i.overdue).sort(byTime);
  const untimed = items.filter((i) => !i.time || i.overdue).sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(a.done) - Number(b.done) || byTime(a, b));
  const now = toMinutes(time);
  let nextMarked = false;
  for (const item of timed) {
    const start = toMinutes(item.time);
    const end = item.end ? toMinutes(item.end) : start;
    if (start <= now && now < end) item.when = 'now';
    else if (end <= now && (item.end || start < now)) item.when = 'past';
    else if (!nextMarked && start > now) {
      item.when = 'next';
      nextMarked = true;
    }
  }
  return { timed, untimed, all: [...timed, ...untimed] };
}

/**
 * Seven days from `from`, with their items and totals:
 * { days: [{ date, items, minutes }], totals: { minutes, blocks, tasks, tasksDone, deadlines } }.
 * Tasks count once, on their due day. Open tasks from before the week aren't counted here.
 */
export function weekAgenda({ occurrences, entries }, from, today) {
  const to = addDays(from, 6);
  const live = occurrences.filter((o) => !o.cancelled && o.date >= from && o.date <= to);
  const scheduled = scheduledTaskIds(live);
  const dated = entries.filter((entry) => entry.item.due >= from && entry.item.due <= to && !scheduled.has(entry.item.id));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const items = [
      ...live.filter((o) => o.date === date).map(fromOccurrence),
      ...dated.filter((entry) => entry.item.due === date).map((entry) => fromEntry(entry, today)),
    ].sort(byTime);
    const minutes = live.filter((o) => o.date === date).reduce((sum, o) => sum + toMinutes(o.end) - toMinutes(o.start), 0);
    return { date, items, minutes };
  });
  const tasks = dated.filter((entry) => !entry.isDeadline && !entry.isEvent);
  return {
    days,
    totals: {
      minutes: days.reduce((sum, d) => sum + d.minutes, 0),
      blocks: live.length,
      tasks: tasks.length,
      tasksDone: tasks.filter((entry) => entry.item.done).length,
      deadlines: dated.filter((entry) => entry.isDeadline).length,
    },
  };
}
