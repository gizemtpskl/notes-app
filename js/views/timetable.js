/**
 * timetable.js: the weekly timetable page: a week grid, a single day, a month, and an agenda list.
 *
 * Keyboard: Tab reaches the blocks. The arrow keys move between them (up and down within a day,
 * left and right to the nearest block on another day), and Enter opens one.
 * On a phone the page opens on one day, and swiping sideways moves between days (or months).
 * The month shows each day's items as short lines, or as coloured dots on a phone; a date opens
 * that day. Nothing is dragged there: the week and day grids are for that.
 * With a mouse, blocks can be drawn, moved and resized on the grid (see gridDrag.js), and tasks
 * from the task list dropped onto it.
 *
 * Besides blocks, the grid shows two other things, each as itself rather than a copy:
 *   - tasks with a date and a time, from any note. Ticking or dragging one here changes the task.
 *   - Google Calendar events, when the calendar is connected. They're only read: clicking one opens
 *     it in Google Calendar. The copy from the last look is shown while offline or signed out.
 */
import { app } from '../context.js';
import { weekEvents } from '../data/calendarTimetable.js';
import {
  addDays, addMonths, daysBetween, firstDayOfWeek, formatDay, isDateStr, monthGrid, toDateStr,
} from '../data/dates.js';
import { calendarConfig } from '../data/googleCalendar.js';
import { toggleTask, updateTask } from '../data/tasks.js';
import {
  blockMinutes, changeFromSeries, conflictsWith, findConflicts, isoWeek, layoutDay, occurrencesBetween, parseBlockText,
  shiftSeriesDay, startOfWeek, toMinutes, weekday,
} from '../data/timetable.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import {
  askScope, openBlockDialog, openTimetableSettings, typeLabel, weekdayName,
} from './blockDialog.js';
import { onCalendarStatus, refreshWeekEvents } from './calendarConnection.js';
import { calendarStatusLine } from './calendarSettings.js';
import { attachGridDrag, clockOf, taskHandleDrag } from './gridDrag.js';
import { emptyState } from './noteList.js';
import { allTaskNotes, collectTasks } from './tasksAgenda.js';
import {
  TASK_LIMIT, exportIcs, findTask, importIcs, openFreeTimeDialog, tasksToSchedule, weekSummaryView,
} from './timetableTools.js';

const HOUR_PX = 48;
/** How long a task with a time looks on the grid. The same length its calendar event gets. */
const TASK_MINUTES = 30;
const SNAP = 15;
const VIEWS = [['week', 'Week'], ['day', 'Day'], ['month', 'Month'], ['agenda', 'Agenda']];
/** Items a day shows in the month before "+ more". */
const MONTH_ITEMS = 4;
const narrow = () => window.matchMedia('(max-width: 720px)').matches;

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function lookups(db) {
  return {
    semesters: new Map(db.listSemesters().map((s) => [s.id, s])),
    spaces: new Map(db.listSpaces().map((s) => [s.id, s])),
  };
}

/** Every occurrence between two dates, as the page shows them. */
export function loadOccurrences(db, from, to) {
  return occurrencesBetween(db.listBlocks(), from, to, lookups(db));
}

/**
 * Tasks with a date and a time between two dates, as grid items:
 *   { kind: 'task', key, date, start, end, title, done, color, ref: { noteId, fieldId, taskId }, noteTitle }
 * A task that has a block among `occurrences` shows as that block instead.
 */
export function timedTaskItems(db, from, to, occurrences = []) {
  const withBlocks = new Set(occurrences.filter((o) => o.task && !o.cancelled).map((o) => o.task.taskId));
  return collectTasks(allTaskNotes())
    .filter(({ item }) => item.time && item.due >= from && item.due <= to && !withBlocks.has(item.id))
    .map((entry) => ({
      kind: 'task',
      key: `task:${entry.item.id}`,
      date: entry.item.due,
      start: entry.item.time,
      end: clockOf(Math.min(toMinutes(entry.item.time) + TASK_MINUTES, 24 * 60 - 1)),
      title: entry.item.text || 'Task',
      done: Boolean(entry.item.done),
      color: db.getSpace(db.getNote(entry.noteId)?.spaceId)?.color ?? 'slate',
      ref: { noteId: entry.noteId, fieldId: entry.fieldId, taskId: entry.item.id },
      noteTitle: entry.noteTitle,
    }));
}

/** Google Calendar's events between two dates, as last read: { kind: 'event', allDay, ... }. */
export function calendarEventItems(db, from, to) {
  const config = calendarConfig(db);
  if (!config.on || !config.showEvents) return [];
  return weekEvents(db, from, to).map((piece) => ({ ...piece, kind: 'event' }));
}

/** Everything with a time between two dates: blocks, tasks and events. For free time and clashes. */
export function busyBetween(db, from, to) {
  const occurrences = loadOccurrences(db, from, to);
  return [...occurrences, ...timedTaskItems(db, from, to, occurrences), ...calendarEventItems(db, from, to).filter((e) => !e.allDay)];
}

function parseQuery(query) {
  const params = new URLSearchParams(query ?? '');
  const date = params.get('date');
  const view = params.get('view');
  return {
    date: isDateStr(date) ? date : null,
    view: VIEWS.some(([id]) => id === view) ? view : null,
  };
}

export function timetableView({ query } = {}) {
  const { db } = app;
  const asked = parseQuery(query);
  let anchor = asked.date ?? toDateStr();
  let mode = asked.view ?? (narrow() ? 'day' : db.getSettings().timetableView ?? 'week');
  let clock = null;
  let showTasks = db.getSettings().timetableTasks === true;
  let shown = new Map();
  let eventsShown = false;
  let geom = { pxPerMinute: HOUR_PX / 60, firstMinute: 0 };
  const hoursSetting = () => ({ start: 7, end: 22, ...db.getSettings().timetableHours });

  const rangeLabel = h('p', { class: 'page-eyebrow', 'aria-live': 'polite' });
  const body = h('div', { class: 'tt-body' });
  const switcher = h('div', { class: 'view-switcher', role: 'group', 'aria-label': 'Timetable view' });

  // Monday to Sunday, unless Settings names another first day.
  const weekStart = () => {
    const setting = db.getSettings().weekStart;
    return !setting || setting === 'auto' ? 1 : firstDayOfWeek(setting);
  };
  const span = () => {
    if (mode === 'day') return [anchor, anchor];
    if (mode === 'month') {
      const [year, month] = anchor.split('-').map(Number);
      const weeks = monthGrid(year, month - 1, weekStart());
      return [weeks[0][0], weeks.at(-1)[6]];
    }
    const first = startOfWeek(anchor, weekStart());
    return [first, addDays(first, 6)];
  };

  function remember() {
    history.replaceState(null, '', `#/timetable?date=${anchor}&view=${mode}`);
  }

  function go(next, focusSelector) {
    anchor = next;
    remember();
    render(focusSelector);
  }

  function step(direction) {
    if (mode === 'month') go(addMonths(anchor, direction));
    else go(addDays(anchor, direction * (mode === 'day' ? 1 : 7)));
  }

  /** Opens one day, from the month. */
  function openDay(date) {
    mode = 'day';
    go(date, '.page-title');
  }

  // -- Quick add -------------------------------------------------------------------------

  const quickAdd = h('input', {
    class: 'task-add',
    type: 'text',
    placeholder: 'Add a block, like German Tue 18:15-20:00',
    'aria-label': 'Add a block. Days and times in the text are picked up, and you can check them before saving.',
    autocomplete: 'off',
    enterkeyhint: 'done',
    onKeydown: async (event) => {
      if (event.key !== 'Enter' || event.isComposing || !quickAdd.value.trim()) return;
      event.preventDefault();
      const draft = parseBlockText(quickAdd.value, toDateStr());
      if (!draft.start) {
        draft.start = '09:00';
        draft.end = '10:00';
      }
      const saved = await openBlockDialog({ draft });
      if (saved) {
        quickAdd.value = '';
        // Show where it went.
        go(draft.date);
      }
    },
  });

  // -- Rendering -------------------------------------------------------------------------

  function blockButton(o, { positioned, conflicted }) {
    const minutes = blockMinutes(o);
    const kind = typeLabel(o.type);
    // A block for a task shows the task as it is now, with its checkbox.
    const task = o.task ? findTask(db, o.task) : null;
    const title = task ? task.item.text || 'Task' : o.title;
    const done = Boolean(task?.item.done);
    // The name comes from the text, so what's read out matches what's shown: "Deep Learning,
    // Tuesday 14:00 to 16:00". The day and the word "to" are for screen readers only.
    const notes = [o.changed && 'changed', conflicted && 'overlaps', o.sessionNoteId && 'has a note'].filter(Boolean);
    const classes = `tt-type-${o.type}${o.cancelled ? ' is-cancelled' : ''}${minutes < 45 ? ' is-short' : ''}${done ? ' is-done' : ''}`;
    const content = [
      h('span', { class: 'tt-block-title' }, o.cancelled && [h('span', { class: 'tt-tag' }, 'Cancelled'), ' '], done && [h('span', { class: 'tt-tag' }, 'Done'), ' '], title),
      h('span', { class: 'sr-only' }, `, ${weekdayName(o.date)}`),
      h('span', { class: 'tt-block-meta' }, ` ${o.start}`, timeTo(), o.end, o.location && ` · ${o.location}`),
      minutes >= 90 && (o.type !== 'other' || notes.length > 0)
        ? h('span', { class: 'tt-block-kind' }, h('span', { class: 'sr-only' }, ', '), [o.type !== 'other' && kind, ...notes].filter(Boolean).join(' · '))
        : notes.length > 0 && h('span', { class: 'sr-only' }, notes.map((n) => `, ${n}`)),
    ];
    const resize = !o.cancelled && h('span', { class: 'tt-resize', 'aria-hidden': 'true', title: 'Drag to change the end time' });
    const focusable = {
      type: 'button',
      dataset: { key: o.key, date: o.date, start: o.start },
      title: `${title} · ${o.start}–${o.end}${o.location ? ` · ${o.location}` : ''}`,
      onClick: () => openBlockDialog({ blockId: o.blockId, originalDate: o.originalDate }),
      onKeydown: (event) => moveFocus(event, o),
    };
    if (!task) {
      return h('button', {
        ...focusable, class: `tt-block tt-focus ${classes}`, dataset: { ...focusable.dataset, color: o.color }, cssVars: positioned,
      }, content, resize);
    }
    return h('div', { class: `tt-block is-task ${classes}`, dataset: { key: o.key, color: o.color }, cssVars: positioned },
      h('input', {
        class: 'tt-task-check',
        type: 'checkbox',
        checked: done,
        'aria-label': `${done ? 'Mark not done' : 'Mark done'}: ${title}`,
        onChange: () => db.updateTasks(o.task.noteId, o.task.fieldId, (items) => toggleTask(items, o.task.taskId, { today: toDateStr() })),
      }),
      h('button', { ...focusable, class: 'tt-block-open tt-focus' }, content),
      resize);
  }

  /** A task with a time: its checkbox, and a button that opens its note. It can be dragged to move it. */
  function taskItemView(t, positioned) {
    const short = blockMinutes(t) < 45;
    const content = [
      h('span', { class: 'tt-block-title' }, t.done && [h('span', { class: 'tt-tag' }, 'Done'), ' '], t.title),
      h('span', { class: 'sr-only' }, `, ${weekdayName(t.date)}`),
      h('span', { class: 'tt-block-meta' }, ` ${t.start}`, h('span', { class: 'sr-only' }, `, task in ${t.noteTitle}`)),
    ];
    return h('div', {
      class: `tt-block is-task is-timed-task${short ? ' is-short' : ''}${t.done ? ' is-done' : ''}`, dataset: { key: t.key, color: t.color }, cssVars: positioned,
    },
    h('input', {
      class: 'tt-task-check',
      type: 'checkbox',
      checked: t.done,
      'aria-label': `${t.done ? 'Mark not done' : 'Mark done'}: ${t.title}`,
      onChange: () => db.updateTasks(t.ref.noteId, t.ref.fieldId, (items) => toggleTask(items, t.ref.taskId, { today: toDateStr() })),
    }),
    h('button', {
      class: 'tt-block-open tt-focus',
      type: 'button',
      dataset: { key: t.key, date: t.date, start: t.start },
      title: `${t.title} · ${t.start} · task in ${t.noteTitle}`,
      onClick: () => {
        location.hash = `#/note/${encodeURIComponent(t.ref.noteId)}`;
      },
      onKeydown: (event) => moveFocus(event, t),
    }, content));
  }

  /** An event from Google Calendar. Clicking it opens it there, in a new tab. */
  function eventView(e, positioned) {
    const short = blockMinutes(e) < 45;
    const content = [
      h('span', { class: 'tt-block-title' }, e.title),
      h('span', { class: 'sr-only' }, `, ${weekdayName(e.date)}`),
      h('span', { class: 'tt-block-meta' }, ` ${e.start}`, timeTo(), e.end, h('span', { class: 'sr-only' }, ', Google Calendar')),
    ];
    const props = {
      class: `tt-block tt-focus is-event${short ? ' is-short' : ''}`,
      dataset: { key: e.key, date: e.date, start: e.start },
      cssVars: positioned,
      title: `${e.title} · ${e.start}–${e.end} · Google Calendar`,
      onKeydown: (event) => moveFocus(event, e),
    };
    return e.url
      ? h('a', {
        ...props, href: e.url, target: '_blank', rel: 'noopener noreferrer',
      }, content)
      : h('div', { ...props, tabindex: '0' }, content);
  }

  /** All-day events, under the day's name. */
  function allDayList(events) {
    if (!events.length) return null;
    return h('ul', { class: 'tt-allday', 'aria-label': 'All day' }, events.map((e) => h('li', null,
      e.url
        ? h('a', {
          class: 'tt-allday-item', href: e.url, target: '_blank', rel: 'noopener noreferrer', title: `${e.title} · all day · Google Calendar`,
        }, e.title, h('span', { class: 'sr-only' }, ', all day, Google Calendar'))
        : h('span', { class: 'tt-allday-item' }, e.title, h('span', { class: 'sr-only' }, ', all day, Google Calendar')))));
  }

  /** Arrow keys between blocks: up and down within a day, left and right to the nearest on another day. */
  function moveFocus(event, o) {
    const keys = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const move = keys[event.key];
    if (!move) return;
    event.preventDefault();
    const all = [...body.querySelectorAll('.tt-column .tt-focus')];
    const byDay = new Map();
    for (const button of all) {
      if (!byDay.has(button.dataset.date)) byDay.set(button.dataset.date, []);
      byDay.get(button.dataset.date).push(button);
    }
    const days = [...byDay.keys()].sort();
    const dayIndex = days.indexOf(o.date);
    let target = null;
    if (move[1]) {
      const list = byDay.get(o.date);
      target = list[list.findIndex((b) => b.dataset.key === o.key) + move[1]];
    } else {
      const list = byDay.get(days[dayIndex + move[0]]);
      if (list) {
        const at = toMinutes(o.start);
        target = list.reduce((best, b) => (Math.abs(toMinutes(b.dataset.start) - at) < Math.abs(toMinutes(best.dataset.start) - at) ? b : best));
      }
    }
    target?.focus();
  }

  function dayHeader(date, today, allDay) {
    const isToday = date === today;
    return h('div', { class: `tt-day-head${isToday ? ' is-today' : ''}` },
      h('span', { class: 'tt-day-name' }, formatDay(date, { weekday: 'short' })),
      h('span', { class: 'tt-day-date' }, formatDay(date, { day: 'numeric' })),
      isToday && h('span', { class: 'tt-today-tag' }, 'Today'),
      allDayList(allDay.filter((e) => e.date === date)));
  }

  function itemView(item, positioned, conflicted) {
    if (item.kind === 'task') return taskItemView(item, positioned);
    if (item.kind === 'event') return eventView(item, positioned);
    return blockButton(item, { positioned, conflicted });
  }

  function grid(days, items, allDay, today) {
    const settings = db.getSettings();
    const hours = { start: 7, end: 22, ...settings.timetableHours };
    const live = items;
    // Stretch to fit anything outside the chosen hours, so nothing is ever hidden.
    const earliest = Math.min(hours.start * 60, ...live.map((o) => toMinutes(o.start)));
    const latest = Math.max(hours.end * 60, ...live.map((o) => toMinutes(o.end)));
    const first = Math.floor(earliest / 60);
    const last = Math.ceil(latest / 60);
    const pxPerMinute = HOUR_PX / 60;
    geom = { pxPerMinute, firstMinute: first * 60 };
    const conflicted = new Set(findConflicts(live).flat().map((o) => o.key));

    const labels = h('div', { class: 'tt-hours', 'aria-hidden': 'true' },
      Array.from({ length: last - first }, (_, i) => h('span', { class: 'tt-hour', cssVars: { '--row': i } }, `${String(first + i).padStart(2, '0')}:00`)));

    const columns = days.map((date) => {
      const mine = live.filter((o) => o.date === date);
      const layout = layoutDay(mine);
      const blocks = mine.map((o) => {
        const lane = layout.get(o.key) ?? { lane: 0, lanes: 1 };
        return itemView(o, {
          '--top': `${(toMinutes(o.start) - first * 60) * pxPerMinute}px`,
          '--height': `${Math.max(18, blockMinutes(o) * pxPerMinute - 2)}px`,
          '--lane': lane.lane,
          '--lanes': lane.lanes,
        }, conflicted.has(o.key));
      });
      const nowMinutes = toMinutes(nowTime());
      const showNow = date === today && nowMinutes >= first * 60 && nowMinutes <= last * 60;
      return h('div', {
        class: `tt-column${date === today ? ' is-today' : ''}`,
        dataset: { date },
        onClick: (event) => {
          if (event.target !== event.currentTarget) return;
          const offset = event.offsetY / pxPerMinute + first * 60;
          const start = Math.max(first * 60, Math.floor(offset / SNAP) * SNAP);
          const end = Math.min(start + 60, 24 * 60 - 1);
          openBlockDialog({ draft: { date, start: clockOf(start), end: clockOf(end) } });
        },
      },
      showNow && h('div', { class: 'tt-now', cssVars: { '--top': `${(nowMinutes - first * 60) * pxPerMinute}px` } },
        h('span', { class: 'sr-only' }, `Now, ${nowTime()}`)),
      blocks);
    });

    // Sideways swipes are left to the page in day view, so they can change the day.
    return h('div', {
      class: `tt-scroll${days.length === 1 ? ' is-day' : ''}`, tabindex: '-1', role: 'region', 'aria-label': mode === 'day' ? 'Day' : 'Week',
    },
    h('div', { class: `tt-grid tt-days-${days.length}`, cssVars: { '--rows': last - first, '--hour': `${HOUR_PX}px` } },
    h('div', { class: 'tt-head' }, h('div', { class: 'tt-corner' }), days.map((date) => dayHeader(date, today, allDay))),
    h('div', { class: 'tt-main' }, labels, columns)));
  }

  function agendaRow(item) {
    if (item.kind === 'task') {
      return h('li', { class: 'tt-agenda-item' },
        h('input', {
          class: 'tt-agenda-check',
          type: 'checkbox',
          checked: item.done,
          'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
          onChange: () => db.updateTasks(item.ref.noteId, item.ref.fieldId, (items) => toggleTask(items, item.ref.taskId, { today: toDateStr() })),
        }),
        h('a', {
          class: `tt-agenda-row is-task${item.done ? ' is-done' : ''}`, href: `#/note/${encodeURIComponent(item.ref.noteId)}`, dataset: { color: item.color, key: item.key },
        },
        h('span', { class: 'tt-agenda-time' }, item.start),
        h('span', { class: 'tt-agenda-main' },
          h('span', { class: 'tt-agenda-title' }, item.title),
          h('span', { class: 'tt-agenda-meta' }, `Task · ${item.noteTitle}`))));
    }
    if (item.kind === 'event') {
      const inner = [
        h('span', { class: 'tt-agenda-time' }, item.allDay ? 'All day' : [item.start, timeTo(), item.end]),
        h('span', { class: 'tt-agenda-main' },
          h('span', { class: 'tt-agenda-title' }, item.title),
          h('span', { class: 'tt-agenda-meta' }, 'Google Calendar'))];
      return h('li', null, item.url
        ? h('a', {
          class: 'tt-agenda-row is-event', href: item.url, target: '_blank', rel: 'noopener noreferrer', dataset: { key: item.key },
        }, inner)
        : h('div', { class: 'tt-agenda-row is-event', dataset: { key: item.key } }, inner));
    }
    const o = item;
    return h('li', null,
      h('button', {
        class: `tt-agenda-row${o.cancelled ? ' is-cancelled' : ''}`,
        type: 'button',
        dataset: { color: o.color, key: o.key },
        onClick: () => openBlockDialog({ blockId: o.blockId, originalDate: o.originalDate }),
      },
      h('span', { class: 'tt-agenda-time' }, o.start, timeTo(), o.end),
      h('span', { class: 'tt-agenda-main' },
        h('span', { class: 'tt-agenda-title' }, o.cancelled && [h('span', { class: 'tt-tag' }, 'Cancelled'), ' '], o.title),
        h('span', { class: 'tt-agenda-meta' }, [o.type !== 'other' && typeLabel(o.type), o.location].filter(Boolean).join(' · ')))));
  }

  function agenda(days, items, allDay, today) {
    const all = [...allDay, ...items];
    const withItems = days.filter((date) => all.some((o) => o.date === date));
    if (!withItems.length) {
      return emptyState({
        emoji: '🗓️',
        title: 'Nothing this week',
        text: 'Type a block above, like “German Tue 18:15-20:00”, or use New block.',
      });
    }
    const order = (a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    return h('div', { class: 'tt-agenda' }, withItems.map((date) => h('section', { class: 'tt-agenda-day' },
      h('h2', { class: `section-title${date === today ? ' is-today' : ''}` }, formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' }), date === today && ' · Today'),
      h('ul', { class: 'tt-agenda-list' }, all.filter((o) => o.date === date).sort(order).map(agendaRow)))));
  }

  // -- Month ---------------------------------------------------------------------------------

  /** One item in a month's day: its time and name. Each opens what it opens elsewhere. */
  function monthItem(item) {
    const isTask = item.kind === 'task';
    const isEvent = item.kind === 'event';
    const blockTask = !isTask && !isEvent && item.task ? findTask(db, item.task) : null;
    const title = blockTask ? blockTask.item.text || 'Task' : item.title;
    const done = isTask ? item.done : Boolean(blockTask?.item.done);
    let when = item.allDay ? 'all day' : `${item.start} to ${item.end}`;
    if (isTask) when = item.start;
    const source = [isTask && `task in ${item.noteTitle}`, isEvent && 'Google Calendar', item.cancelled && 'cancelled', done && 'done'].filter(Boolean);
    const classes = `tt-month-item${isEvent ? ' is-event' : ''}${isTask ? ' is-task' : ''}${item.cancelled ? ' is-cancelled' : ''}${done ? ' is-done' : ''}`;
    const content = [
      h('span', { class: 'tt-month-dot', 'aria-hidden': 'true' }),
      !item.allDay && h('span', { class: 'tt-month-time' }, item.start),
      h('span', { class: 'tt-month-title' }, title),
      h('span', { class: 'sr-only' }, `, ${[when, ...source].join(', ')}`),
    ];
    const props = {
      class: classes,
      dataset: isEvent ? { key: item.key } : { key: item.key, color: item.color ?? 'slate' },
      title: `${title} · ${item.allDay ? 'all day' : `${item.start}${isTask ? '' : `–${item.end}`}`}${source.length ? ` · ${source.join(' · ')}` : ''}`,
    };
    if (isEvent) {
      return item.url
        ? h('a', {
          ...props, href: item.url, target: '_blank', rel: 'noopener noreferrer',
        }, content)
        : h('span', { ...props, tabindex: '0' }, content);
    }
    if (isTask) return h('a', { ...props, href: `#/note/${encodeURIComponent(item.ref.noteId)}` }, content);
    return h('button', {
      ...props, type: 'button', onClick: () => openBlockDialog({ blockId: item.blockId, originalDate: item.originalDate }),
    }, content);
  }

  function month(days, items, allDay, today) {
    const inMonth = anchor.slice(0, 7);
    const order = (a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title);
    const all = [...allDay, ...items];
    const byDay = new Map(days.map((date) => [date, []]));
    for (const item of all) byDay.get(item.date)?.push(item);
    return h('div', { class: 'tt-month', role: 'region', 'aria-label': formatDay(anchor, { month: 'long', year: 'numeric' }) },
      h('div', { class: 'tt-month-head', 'aria-hidden': 'true' }, days.slice(0, 7).map((date) => h('span', null, formatDay(date, { weekday: 'short' })))),
      h('ol', { class: 'tt-month-grid' }, days.map((date) => {
        const list = byDay.get(date).sort(order);
        const extra = list.length - MONTH_ITEMS;
        const shown = extra > 0 ? list.slice(0, MONTH_ITEMS - 1) : list;
        const isToday = date === today;
        return h('li', { class: `tt-month-day${date.slice(0, 7) === inMonth ? '' : ' is-outside'}${isToday ? ' is-today' : ''}`, dataset: { date } },
          h('button', {
            class: 'tt-month-date',
            type: 'button',
            'aria-label': `${formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' })}${isToday ? ', today' : ''}, ${list.length ? plural(list.length, 'item') : 'nothing planned'}. Open the day.`,
            onClick: () => openDay(date),
          }, formatDay(date, { day: 'numeric' })),
          list.length > 0 && h('ul', { class: 'tt-month-list' },
            shown.map((item) => h('li', null, monthItem(item))),
            extra > 0 && h('li', null, h('button', {
              class: 'tt-month-more', type: 'button', onClick: () => openDay(date), 'aria-label': `${extra + 1} more on ${formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' })}`,
            }, `+${extra + 1}`, h('span', { class: 'tt-month-more-word' }, ' more')))));
      })));
  }

  function render(focusSelector) {
    const today = toDateStr();
    const [from, to] = span();
    const days = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
    const occurrences = loadOccurrences(db, from, to);
    const tasks = timedTaskItems(db, from, to, occurrences);
    const events = calendarEventItems(db, from, to);
    const allDay = events.filter((e) => e.allDay);
    const items = [...occurrences, ...tasks, ...events.filter((e) => !e.allDay)];
    eventsShown = calendarConfig(db).on && calendarConfig(db).showEvents;
    // Blocks and tasks can be dragged; events belong to Google Calendar and stay put.
    shown = new Map([...occurrences, ...tasks].map((o) => [o.key, o]));
    // The month reads each of its weeks; a week that was read a few minutes ago isn't read again.
    for (let week = startOfWeek(from, weekStart()); week <= to; week = addDays(week, 7)) refreshWeekEvents(week);
    const active = body.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.closest('[data-key]')?.dataset.key ?? null;
    const focusCheck = Boolean(active?.classList.contains('tt-task-check'));
    const focusTask = active?.closest('[data-task-id]')?.dataset.taskId ?? null;

    if (mode === 'day') rangeLabel.textContent = `${formatDay(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · Week ${isoWeek(anchor)}`;
    else if (mode === 'month') rangeLabel.textContent = formatDay(anchor, { month: 'long', year: 'numeric' });
    else rangeLabel.textContent = `${formatDay(from, { month: 'short', day: 'numeric' })} – ${formatDay(to)} · Week ${isoWeek(addDays(from, 3))}`;
    const unit = { day: 'day', month: 'month' }[mode] ?? 'week';
    prevButton.setAttribute('aria-label', `Previous ${unit}`);
    nextButton.setAttribute('aria-label', `Next ${unit}`);

    fill(switcher, VIEWS.map(([id, label]) => h('button', {
      class: 'view-btn',
      type: 'button',
      'aria-pressed': String(mode === id),
      onClick: () => {
        mode = id;
        if (!narrow()) db.updateSettings({ timetableView: id });
        remember();
        render(`.view-btn[aria-pressed="true"]`);
      },
    }, label)));

    // The month counts its own days, not the days of other months around them.
    const live = occurrences.filter((o) => !o.cancelled && (mode !== 'month' || o.date.slice(0, 7) === anchor.slice(0, 7)));
    const hoursBooked = live.reduce((sum, o) => sum + blockMinutes(o), 0) / 60;
    const summary = mode !== 'day' && live.length > 0
      && h('p', { class: 'tt-summary' }, `${plural(live.length, 'block')}, ${hoursBooked.toLocaleString(undefined, { maximumFractionDigits: 1 })} hours this ${mode === 'month' ? 'month' : 'week'}`);

    tasksButton.setAttribute('aria-pressed', String(showTasks));
    let view;
    if (mode === 'agenda') view = agenda(days, items, allDay, today);
    else if (mode === 'month') view = month(days, items, allDay, today);
    else view = grid(days, items, allDay, today);
    const main = [
      view,
      onGrid() && !db.listBlocks().length && h('p', { class: 'empty-line tt-hint' }, 'Click or drag on an empty part of the grid, type a block above, or use New block.'),
    ];
    fill(body,
      summary,
      showTasks ? h('div', { class: 'tt-layout' }, h('div', { class: 'tt-layout-main' }, main), taskPanel(today, from, to)) : main,
      mode === 'week' && weekSummaryView(occurrences, { from, to, hours: hoursSetting() }));

    if (focusTask) body.querySelector(`[data-task-id="${CSS.escape(focusTask)}"] button`)?.focus();
    else if (focusKey && focusCheck) body.querySelector(`.tt-block[data-key="${CSS.escape(focusKey)}"] .tt-task-check`)?.focus();
    else if (focusKey) body.querySelector(`.tt-focus[data-key="${CSS.escape(focusKey)}"], .tt-agenda-row[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    else if (focusSelector) el.querySelector(focusSelector)?.focus();

    // Today in view: scroll the grid near the current time, not to midnight.
    const scroller = body.querySelector('.tt-scroll');
    const now = body.querySelector('.tt-now');
    if (scroller && now && !focusKey) scroller.scrollTop = Math.max(0, now.offsetTop - 120);
  }

  // -- Tasks to give a time ----------------------------------------------------------------

  /** The week and day grids, where things can be drawn and dragged. */
  function onGrid() {
    return mode === 'week' || mode === 'day';
  }

  function defaultDay(today, from, to) {
    return today >= from && today <= to ? today : from;
  }

  function nextQuarter() {
    const d = new Date();
    return Math.min(22 * 60, Math.ceil((d.getHours() * 60 + d.getMinutes() + 1) / 15) * 15);
  }

  function scheduleTask(entry, date, start) {
    const startMinutes = toMinutes(start);
    const { undo } = db.undoable(() => db.createBlock({
      title: entry.item.text || 'Task',
      type: 'personal',
      date,
      start,
      end: clockOf(Math.min(startMinutes + 60, 24 * 60 - 1)),
      task: { noteId: entry.noteId, fieldId: entry.fieldId, taskId: entry.item.id },
    }));
    toast(`Scheduled for ${formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${start}`, { undo });
  }

  function taskPanel(today, from, to) {
    const tasks = tasksToSchedule(db, today);
    const rows = tasks.slice(0, TASK_LIMIT).map((entry) => {
      const grip = h('span', { class: 'tt-task-grip', 'aria-hidden': 'true', title: 'Drag onto the timetable' }, icon('grip', 14));
      if (onGrid()) {
        taskHandleDrag(grip, entry.item.text || 'Task', {
          geometry: () => geom,
          onDrop: (date, start) => scheduleTask(entry, date, start),
        });
      }
      return h('li', { class: 'tt-task-row', dataset: { taskId: entry.item.id } },
        onGrid() && grip,
        h('span', { class: 'tt-task-main' },
          h('span', { class: 'tt-task-text' }, entry.item.text || 'Task'),
          h('span', { class: 'tt-task-from' }, entry.noteTitle, entry.item.due && ` · due ${formatDay(entry.item.due, { month: 'short', day: 'numeric' })}`)),
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          'aria-label': `Schedule: ${entry.item.text || 'task'}`,
          onClick: () => {
            const start = nextQuarter();
            openBlockDialog({
              draft: {
                title: entry.item.text || 'Task',
                type: 'personal',
                date: defaultDay(today, from, to),
                start: clockOf(start),
                end: clockOf(Math.min(start + 60, 24 * 60 - 1)),
                task: { noteId: entry.noteId, fieldId: entry.fieldId, taskId: entry.item.id },
              },
            });
          },
        }, 'Schedule'));
    });
    return h('aside', { class: 'tt-tasks', 'aria-labelledby': 'tt-tasks-title' },
      h('h2', { class: 'section-title', id: 'tt-tasks-title' }, 'Tasks to schedule'),
      tasks.length
        ? [
          h('p', { class: 'field-hint' }, !onGrid() ? 'Use Schedule to give a task a time.' : 'Drag a task onto a day, or use Schedule. Unscheduling a block puts its task back here.'),
          h('ul', { class: 'tt-task-list' }, rows),
          tasks.length > TASK_LIMIT && h('p', { class: 'field-hint' }, `and ${tasks.length - TASK_LIMIT} more, due later or with no date.`)]
        : h('p', { class: 'empty-line' }, 'No open tasks to schedule.'));
  }

  // -- Dragging on the grid --------------------------------------------------------------

  /** A task dragged on the grid gets the new day and time. */
  function moveTask(t, next) {
    const { undo } = db.undoable(() => db.updateTasks(t.ref.noteId, t.ref.fieldId, (items) => updateTask(items, t.ref.taskId, { due: next.date, time: next.start })));
    toast(`Moved to ${formatDay(next.date, { weekday: 'short' })} ${next.start}`, { undo });
  }

  async function applyChange(o, next) {
    if (o.kind === 'task') {
      moveTask(o, next);
      return;
    }
    const block = db.getBlock(o.blockId);
    if (!block) {
      render();
      return;
    }
    try {
      let undo;
      if (!block.repeat) {
        ({ undo } = db.undoable(() => db.updateBlock(block.id, next)));
      } else {
        const scope = await askScope(o.title, o.date);
        if (!scope) {
          render();
          return;
        }
        if (scope === 'one') {
          const current = {
            date: o.date, start: o.start, end: o.end, title: o.title, type: o.type, location: o.location, notes: o.notes,
          };
          const change = changeFromSeries(block, o.originalDate, { ...current, ...next });
          ({ undo } = db.undoable(() => db.setOccurrence(block.id, o.originalDate, Object.keys(change).length ? change : null)));
        } else {
          // Moving one week of a series to another weekday moves that weekday for all of them.
          const delta = daysBetween(o.date, next.date);
          const patch = {
            start: next.start, end: next.end, ...(delta ? shiftSeriesDay(block, weekday(o.originalDate), delta) : {}),
          };
          ({ undo } = db.undoable(() => db.updateBlock(block.id, patch)));
        }
      }
      const sameDay = loadOccurrences(db, next.date, next.date);
      const mine = sameDay.filter((x) => x.blockId === o.blockId && x.start === next.start);
      const clash = conflictsWith(mine, sameDay);
      toast(clash.length ? `Moved. It overlaps ${clash.map((c) => c.title).join(', ')}.` : `Moved to ${formatDay(next.date, { weekday: 'short' })} ${next.start}–${next.end}`, { undo });
    } catch (problem) {
      toast(problem.message, { error: true });
      render();
    }
  }

  attachGridDrag(body, {
    geometry: () => geom,
    find: (key) => shown.get(key),
    onCreate: (date, start, end) => openBlockDialog({ draft: { date, start, end } }),
    onChange: applyChange,
    onCancel: () => render(),
  });

  // -- More ------------------------------------------------------------------------------

  function printWeek() {
    if (mode !== 'week') {
      mode = 'week';
      remember();
      render();
    }
    window.print();
  }

  const tasksButton = h('button', {
    class: 'btn btn-small',
    type: 'button',
    'aria-pressed': String(showTasks),
    onClick: () => {
      showTasks = !showTasks;
      db.updateSettings({ timetableTasks: showTasks });
      render();
      tasksButton.focus();
    },
  }, icon('listCheck', 15), 'Tasks');

  const moreButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'More timetable actions',
    title: 'More',
    onClick: (event) => openMenu(event.currentTarget, [
      {
        label: 'Find free time',
        icon: 'search',
        onSelect: () => {
          const [from] = mode === 'week' ? span() : [anchor];
          openFreeTimeDialog({
            from,
            hours: hoursSetting(),
            occurrencesFor: (a, b) => busyBetween(db, a, b),
            onPick: (slot) => openBlockDialog({ draft: { date: slot.date, start: slot.start, end: clockOf(Math.min(toMinutes(slot.start) + 60, toMinutes(slot.end))) } }),
          });
        },
      },
      { label: 'Print this week', icon: 'note', onSelect: printWeek },
      'separator',
      { label: 'Export as .ics', icon: 'download', onSelect: exportIcs },
      { label: 'Import an .ics file…', icon: 'upload', onSelect: importIcs },
    ], { label: 'Timetable actions' }),
  }, icon('more', 18));

  // -- Swiping between days --------------------------------------------------------------

  let swipe = null;
  body.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' && (mode === 'day' || mode === 'month')) swipe = { x: event.clientX, y: event.clientY };
  });
  body.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) step(dx < 0 ? 1 : -1);
  });
  body.addEventListener('pointercancel', () => {
    swipe = null;
  });

  const prevButton = h('button', { class: 'icon-btn', type: 'button', onClick: () => step(-1) }, icon('chevronLeft', 18));
  const nextButton = h('button', { class: 'icon-btn', type: 'button', onClick: () => step(1) }, icon('chevronRight', 18));

  const jump = h('input', {
    class: 'input input-small tt-jump',
    type: 'date',
    'aria-label': 'Go to a date',
    onChange: (event) => {
      if (isDateStr(event.target.value)) go(event.target.value);
    },
  });

  // Signed out or a problem with Google Calendar: said here too, with a button to sign in.
  const calendarLine = calendarStatusLine();
  // Once signed in, the week on screen is read from Google.
  const stopCalendar = onCalendarStatus(() => refreshWeekEvents(startOfWeek(anchor, weekStart())));

  const el = h('div', { class: 'page page-wide timetable' },
    h('header', { class: 'page-head' },
      rangeLabel,
      h('div', { class: 'page-title-row' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Timetable'),
        h('div', { class: 'page-actions' },
          h('button', {
            class: 'btn', type: 'button', onClick: openTimetableSettings, 'aria-label': 'Hours and semesters', title: 'Hours and semesters',
          }, icon('settings', 16), h('span', { class: 'tt-label-wide', 'aria-hidden': 'true' }, 'Hours and semesters')),
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onClick: () => openBlockDialog({ draft: { date: mode === 'day' ? anchor : (anchor >= span()[0] ? anchor : span()[0]), start: '09:00', end: '10:00' } }),
          }, icon('plus', 16), 'New block')))),
    h('div', { class: 'task-add-row tt-quick' }, icon('plus', 16), quickAdd),
    calendarLine.el,
    h('div', { class: 'tt-toolbar' },
      h('div', { class: 'tt-nav' },
        prevButton,
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => go(toDateStr()) }, 'Today'),
        nextButton,
        jump),
      h('div', { class: 'tt-nav' }, tasksButton, switcher, moreButton)),
    body);

  render();
  remember();

  return {
    title: 'Timetable',
    el,
    mounted: () => {
      // The now line moves, and a new day can start while the page is open.
      clock = setInterval(() => {
        if (!document.querySelector('dialog[open]') && !body.contains(document.activeElement)) render();
      }, 60000);
    },
    update: (change) => {
      // A drag in progress redraws when it ends.
      if (body.classList.contains('is-dragging')) return;
      const config = calendarConfig(db);
      const eventsChanged = change.ids.has('gcalWeeks') || (change.ids.has('gcalConfig') && (config.on && config.showEvents) !== eventsShown);
      if (change.stores.has('timeBlocks') || change.stores.has('semesters') || change.stores.has('spaces') || change.ids.has('settings')
        || change.stores.has('notes') || eventsChanged) render();
    },
    destroy: () => {
      clearInterval(clock);
      calendarLine.destroy();
      stopCalendar();
    },
  };
}

/** A dash on screen, "to" when read out. */
function timeTo() {
  return [h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, ' to ')];
}
