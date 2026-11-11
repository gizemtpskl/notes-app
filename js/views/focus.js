/**
 * focus.js: the focus timer. Start a session from a timetable block, a note or the command
 * palette; a small timer floats at the bottom of the screen; when it ends, the session is logged
 * to what it was for (data/focus.js), so Stats and the dashboard can count the hours.
 *
 * The running timer lives in localStorage, not the database: it belongs to this device, survives
 * a reload, and every open tab shows the same one. Only the finished session is synced.
 */
import { app } from '../context.js';
import { toDateStr } from '../data/dates.js';
import { FOCUS_LENGTHS, MAX_FOCUS_MINUTES, focusMinutes, formatMinutes } from '../data/focus.js';
import { uid } from '../data/schema.js';
import { openDialog } from '../ui/dialog.js';
import { h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { notify } from './reminders.js';

const TIMER_KEY = 'personal-notes:focus';
const RING = 2 * Math.PI * 10;

let pill = null;
let ticker = null;
let audio = null;

function readTimer() {
  try {
    const timer = JSON.parse(localStorage.getItem(TIMER_KEY) ?? 'null');
    return timer && typeof timer.id === 'string' && Number.isFinite(timer.startedAt) && timer.minutes >= 1 ? timer : null;
  } catch {
    return null;
  }
}

function writeTimer(timer) {
  try {
    if (timer) localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(TIMER_KEY);
  } catch {
    // Without storage the timer still runs in this tab; it just won't survive a reload.
  }
  memory = timer;
}

// Where localStorage is blocked, the timer is kept here instead.
let memory = null;
const currentTimer = () => readTimer() ?? memory;

/** Milliseconds worked so far, not counting pauses. */
const elapsed = (timer, now = Date.now()) => (timer.pausedAt ?? now) - timer.startedAt - (timer.pausedTotal ?? 0);

const clock = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** What a session is for, from a timetable block. */
export function focusTargetForBlock(block) {
  const { db } = app;
  const noteId = block.noteId ?? block.task?.noteId ?? null;
  const note = noteId ? db.getNote(noteId) : null;
  const collectionId = block.collectionId ?? note?.collectionId ?? null;
  const spaceId = block.spaceId ?? note?.spaceId ?? (collectionId ? db.getCollection(collectionId)?.spaceId : null) ?? null;
  return {
    label: block.title, blockId: block.id, noteId, collectionId, spaceId,
  };
}

/** What a session is for, from a note. */
export function focusTargetForNote(note, title) {
  return {
    label: title, noteId: note.id, collectionId: note.collectionId, spaceId: note.spaceId,
  };
}

/** Where a session's time goes, in words: "DL-FS2026", "School" or nothing. */
function placeName(target) {
  const { db } = app;
  if (target.collectionId) return db.getCollection(target.collectionId)?.name ?? '';
  if (target.spaceId) return db.getSpace(target.spaceId)?.name ?? '';
  return '';
}

function chime() {
  if (!audio) return;
  try {
    const start = audio.currentTime + 0.05;
    [660, 880, 990].forEach((pitch, i) => {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = pitch;
      gain.gain.setValueAtTime(0.0001, start + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.12, start + i * 0.18 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.18 + 0.6);
      tone.connect(gain).connect(audio.destination);
      tone.start(start + i * 0.18);
      tone.stop(start + i * 0.18 + 0.65);
    });
  } catch {
    // Sound is a nicety. The message on screen says the same.
  }
}

function logSession(timer, minutes) {
  const { db } = app;
  return db.addFocusSession({
    id: timer.id,
    label: timer.label,
    start: timer.startedAt,
    date: toDateStr(new Date(timer.startedAt)),
    minutes,
    blockId: timer.blockId,
    noteId: timer.noteId,
    collectionId: timer.collectionId,
    spaceId: timer.spaceId,
  });
}

function finish(timer) {
  writeTimer(null);
  render();
  logSession(timer, timer.minutes);
  const where = placeName(timer);
  const message = `Focus session done: ${formatMinutes(timer.minutes)}${where ? ` on ${where}` : ''}. Time for a break.`;
  chime();
  toast(message, { duration: 8000 });
  if (document.visibilityState !== 'visible') notify('Focus session done', message, `focus-${timer.id}`);
}

function stop() {
  const timer = currentTimer();
  if (!timer) return;
  writeTimer(null);
  render();
  const minutes = Math.floor(elapsed(timer) / 60000);
  if (minutes < 1) {
    toast('Focus session stopped. Under a minute isn’t logged.');
    return;
  }
  const { db } = app;
  const { undo } = db.undoable(() => logSession(timer, minutes));
  toast(`Logged ${formatMinutes(minutes)} of focus`, { undo });
}

function togglePause() {
  const timer = currentTimer();
  if (!timer) return;
  const now = Date.now();
  writeTimer(timer.pausedAt
    ? { ...timer, pausedAt: null, pausedTotal: (timer.pausedTotal ?? 0) + now - timer.pausedAt }
    : { ...timer, pausedAt: now });
  render();
}

/** Builds the floating timer once. Only its text and ring change each second, so clicks never land on a button being replaced. */
function buildPill() {
  const svgNs = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(svgNs, 'svg');
  ring.setAttribute('class', 'focus-pill-ring');
  ring.setAttribute('viewBox', '0 0 26 26');
  ring.setAttribute('aria-hidden', 'true');
  const circle = (cls) => {
    const c = document.createElementNS(svgNs, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '13');
    c.setAttribute('cy', '13');
    c.setAttribute('r', '10');
    ring.append(c);
    return c;
  };
  circle('ring-track');
  const fill = circle('ring-fill');
  fill.setAttribute('stroke-dasharray', String(RING));
  const time = h('span', { class: 'focus-pill-time', role: 'timer' });
  const label = h('span', { class: 'focus-pill-label' });
  const pause = h('button', {
    class: 'icon-btn', type: 'button', dataset: { key: 'pause' }, onClick: togglePause,
  });
  const stopButton = h('button', {
    class: 'icon-btn', type: 'button', dataset: { key: 'stop' }, 'aria-label': 'Stop and log the time so far', title: 'Stop', onClick: stop,
  }, icon('stop', 16));
  const el = h('aside', { class: 'focus-pill', 'aria-label': 'Focus session' },
    ring, h('div', { class: 'focus-pill-text' }, time, label), pause, stopButton);
  document.body.append(el);
  document.body.classList.add('has-focus-pill');
  return {
    el, fill, time, label, pause, paused: null,
  };
}

/** Draws the floating timer, or removes it when nothing runs. */
function render() {
  const timer = currentTimer();
  if (!timer) {
    clearInterval(ticker);
    ticker = null;
    pill?.el.remove();
    pill = null;
    document.body.classList.remove('has-focus-pill');
    return;
  }
  const left = timer.minutes * 60000 - elapsed(timer);
  if (left <= 0 && !timer.pausedAt) {
    finish(timer);
    return;
  }
  pill ??= buildPill();
  const paused = Boolean(timer.pausedAt);
  const ratio = Math.min(1, Math.max(0, 1 - left / (timer.minutes * 60000)));
  pill.fill.setAttribute('stroke-dashoffset', String(RING * (1 - ratio)));
  pill.el.classList.toggle('is-paused', paused);
  pill.time.textContent = clock(left);
  pill.time.setAttribute('aria-label', `${clock(left)} left${paused ? ', paused' : ''}`);
  pill.label.textContent = paused ? `Paused · ${timer.label || 'Focus'}` : timer.label || 'Focus';
  if (pill.paused !== paused) {
    pill.paused = paused;
    pill.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    pill.pause.title = paused ? 'Resume' : 'Pause';
    pill.pause.replaceChildren(icon(paused ? 'play' : 'pause', 16));
  }
  if (!ticker) ticker = setInterval(render, 1000);
}

/** Starts a session now. */
export function startFocus(target, minutes) {
  if (currentTimer()) {
    toast('A focus session is already running. Stop it first to start another.');
    return null;
  }
  try {
    audio ??= new AudioContext();
    audio.resume?.();
  } catch {
    audio = null;
  }
  const timer = {
    id: uid(),
    label: String(target.label ?? '').trim().slice(0, 120),
    minutes: Math.max(1, Math.min(MAX_FOCUS_MINUTES, Math.round(minutes))),
    startedAt: Date.now(),
    pausedAt: null,
    pausedTotal: 0,
    blockId: target.blockId ?? null,
    noteId: target.noteId ?? null,
    collectionId: target.collectionId ?? null,
    spaceId: target.spaceId ?? null,
  };
  writeTimer(timer);
  render();
  return timer;
}

/** Asks how long, then starts. target: { label, blockId, noteId, collectionId, spaceId }, all optional. */
export function startFocusDialog(target = {}) {
  if (currentTimer()) {
    toast('A focus session is already running. Stop it first to start another.');
    return Promise.resolve(null);
  }
  const { db } = app;
  const today = toDateStr();
  const doneToday = focusMinutes(db.listFocusSessions(), today, today);
  return openDialog({
    title: 'Start a focus session',
    build: (close) => {
      let minutes = FOCUS_LENGTHS[0];
      const label = h('input', {
        class: 'input', type: 'text', value: target.label ?? '', maxlength: 120, placeholder: 'What are you working on?', id: 'focus-label',
      });
      const custom = h('input', {
        class: 'input goal-input', type: 'number', min: 1, max: MAX_FOCUS_MINUTES, step: 1, value: '', id: 'focus-custom', placeholder: 'Other',
        'aria-label': 'Other length, in minutes',
        onInput: () => {
          const value = Number(custom.value);
          if (value >= 1) {
            minutes = Math.min(MAX_FOCUS_MINUTES, Math.round(value));
            for (const b of buttons) b.setAttribute('aria-pressed', 'false');
          }
        },
      });
      const buttons = FOCUS_LENGTHS.map((length) => h('button', {
        class: 'chip chip-button choice-chip', type: 'button', 'aria-pressed': String(length === minutes), dataset: { minutes: length },
        onClick: () => {
          minutes = length;
          custom.value = '';
          for (const b of buttons) b.setAttribute('aria-pressed', String(Number(b.dataset.minutes) === length));
        },
      }, `${length} min`));
      const where = placeName(target);
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          close(startFocus({ ...target, label: label.value }, minutes));
        },
      },
      h('label', { class: 'field', for: 'focus-label' }, h('span', { class: 'field-label' }, 'Working on'), label),
      h('div', { class: 'field', role: 'group', 'aria-labelledby': 'focus-length-label' },
        h('span', { class: 'field-label', id: 'focus-length-label' }, 'How long'),
        h('div', { class: 'focus-lengths' }, buttons, custom)),
      h('p', { class: 'field-hint' }, where
        ? `The time counts toward ${where} in Stats.`
        : 'Start it from a timetable block or a note to count the time toward that course or space.'),
      doneToday > 0 && h('p', { class: 'focus-today' }, `${formatMinutes(doneToday)} of focus so far today.`),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, icon('play', 16), 'Start')));
    },
  });
}

/** Shows a timer left running before a reload, and follows timers started in other tabs. */
export function startFocusTimer() {
  render();
  window.addEventListener('storage', (event) => {
    if (event.key === TIMER_KEY || event.key === null) render();
  });
}

/** For Stats: "3 sessions, 1 h 40 min". */
export const sessionsText = (count, minutes) => `${plural(count, 'session')}, ${formatMinutes(minutes)}`;
