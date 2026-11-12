/**
 * capture.js: the fastest path into the app. A tiny box: type, press Enter, done.
 * Everything lands in the Inbox with no decisions needed.
 */
import { app } from '../context.js';
import { addDailyTask } from '../data/daily.js';
import { relativeDay, toDateStr } from '../data/dates.js';
import { textToHtml } from '../data/html.js';
import { taskTimeLabel } from '../data/tasks.js';
import { splitCapture } from '../data/text.js';
import { parseBlockText } from '../data/timetable.js';
import { fill, h, modKey, modName } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { openBlockDialog } from './blockDialog.js';

const DRAFT_KEY = 'personal-notes:capture-draft';

function readDraft() {
  try {
    return app.db.storage.encrypted ? '' : localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Drafts sit outside the database. With the lock on they'd be readable, so they aren't kept. */
function writeDraft(value) {
  try {
    if (value && !app.db.storage.encrypted) localStorage.setItem(DRAFT_KEY, value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Without storage the draft just isn't kept. Saving the note itself is unaffected.
  }
}

/** Saves text to the Inbox and shows an Undo toast. Returns the new note, or null if the text is blank. */
export function saveCapture(text) {
  const { title, bodyText } = splitCapture(text);
  if (!title) return null;
  const { result: note, undo } = app.db.undoable(() => app.db.createNote({ title, body: textToHtml(bodyText) }));
  toast('Saved to Inbox', { undo });
  return note;
}

function autoGrow(area) {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, 260)}px`;
}

function captureArea({ onSave, onOpen, value = '', placeholder, label }) {
  const area = h('textarea', {
    class: 'capture-input',
    rows: 1,
    value,
    placeholder,
    'aria-label': label,
    onInput: () => autoGrow(area),
    onKeydown: (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (modKey(event)) onOpen?.(area);
      else onSave(area);
    },
  });
  return area;
}

/** Opens the quick capture box. Text left in it when closed is kept for next time. */
export function openCaptureDialog() {
  if (document.querySelector('dialog.dialog-capture')) return;
  openDialog({
    title: null,
    ariaLabel: 'Quick capture',
    className: 'dialog-capture',
    build: (close) => {
      const finish = (area, openAfter) => {
        const note = saveCapture(area.value);
        if (!note) return;
        area.value = '';
        writeDraft('');
        close();
        if (openAfter) app.navigate(`note/${note.id}`);
      };
      const area = captureArea({
        value: readDraft(),
        placeholder: "What's on your mind?",
        label: 'Quick capture to Inbox',
        onSave: (a) => finish(a, false),
        onOpen: (a) => finish(a, true),
      });
      area.addEventListener('input', () => writeDraft(area.value));
      area.autofocus = true;
      queueMicrotask(() => autoGrow(area));
      return h('div', { class: 'capture-box' },
        area,
        h('div', { class: 'capture-foot' },
          h('p', { class: 'capture-hint' },
            h('span', null, h('kbd', null, 'Enter'), ' save to Inbox'),
            h('span', null, h('kbd', null, 'Shift'), ' ', h('kbd', null, 'Enter'), ' new line'),
            h('span', { class: 'capture-hint-wide' }, h('kbd', null, modName), ' ', h('kbd', null, 'Enter'), ' save and open')),
          h('button', { class: 'btn btn-primary btn-small capture-save', type: 'button', onClick: () => finish(area, false) }, 'Save')));
    },
  });
}

/** The same behaviour, inline on a page. */
export function captureField() {
  const onSave = (a) => {
    if (saveCapture(a.value)) {
      a.value = '';
      autoGrow(a);
    }
  };
  const area = captureArea({
    placeholder: 'Capture a thought and press Enter…',
    label: 'Quick capture to Inbox',
    onSave,
    onOpen: (a) => {
      const note = saveCapture(a.value);
      if (note) app.navigate(`note/${note.id}`);
    },
  });
  return h('div', { class: 'capture-field' }, area,
    h('button', { class: 'btn btn-primary btn-small capture-save', type: 'button', onClick: () => { onSave(area); area.focus(); } }, 'Save'));
}

// -- The dashboard's box: the Inbox, today's to-dos, or the timetable --------------------------

const DASH_MODE_KEY = 'personal-notes:dash-capture';
const DASH_MODES = {
  inbox: {
    label: 'Inbox', button: 'Save', placeholder: 'Capture a thought and press Enter…', aria: 'Quick capture to Inbox',
  },
  todo: {
    label: 'To-do', button: 'Add', placeholder: 'Add a to-do, like 10:00-11:00 study', aria: 'Add a to-do for today. A time, a time range or a day in the text is picked up.',
  },
  timetable: {
    label: 'Timetable', button: 'Add', placeholder: 'Add a block, like Dentist Thu 10:00-11:00', aria: 'Add a timetable block. Days and times in the text are picked up, and you can check them before saving.',
  },
};

function readMode() {
  try {
    const mode = localStorage.getItem(DASH_MODE_KEY);
    return mode in DASH_MODES ? mode : 'inbox';
  } catch {
    return 'inbox';
  }
}

function writeMode(mode) {
  try {
    localStorage.setItem(DASH_MODE_KEY, mode);
  } catch {
    // Not remembered, which only means the Inbox is chosen next time.
  }
}

let dashCapture = null;

/** Moves to the dashboard's box with a destination chosen, for the + buttons on Your day and Your week. */
export function focusDashCapture(mode) {
  dashCapture?.choose(mode, { focus: true });
}

/** A to-do for today, read the way the Today page reads it. Returns the task, or null for blank text. */
function addTodo(text) {
  const today = toDateStr();
  const { result: task, undo } = app.db.undoable(() => addDailyTask(app.db, text, today));
  if (!task) return null;
  const where = task.due === today ? 'Added to today’s to-dos' : `Added for ${relativeDay(task.due, today)}`;
  toast(`${where}${task.time ? `, ${taskTimeLabel(task)}` : ''}`, { undo });
  return task;
}

/** A block, checked in the editor first, as on the timetable. Resolves true once saved. */
async function addBlock(text) {
  const draft = parseBlockText(text, toDateStr());
  if (!draft.start) {
    draft.start = '09:00';
    draft.end = '10:00';
  }
  return Boolean(await openBlockDialog({ draft }));
}

/** The dashboard's quick capture: the same box, with a choice of where the line goes. */
export function dashboardCaptureField() {
  let mode = readMode();
  const clear = (a) => {
    a.value = '';
    autoGrow(a);
  };
  async function submit(a, openAfter = false) {
    const text = a.value;
    if (!text.trim()) return;
    if (mode === 'todo') {
      if (addTodo(text)) clear(a);
    } else if (mode === 'timetable') {
      if (await addBlock(text)) clear(a);
      a.focus();
    } else {
      const note = saveCapture(text);
      if (!note) return;
      clear(a);
      if (openAfter) app.navigate(`note/${note.id}`);
    }
  }
  const area = captureArea({ onSave: (a) => submit(a), onOpen: (a) => submit(a, mode === 'inbox') });
  const button = h('button', { class: 'btn btn-primary btn-small capture-save', type: 'button', onClick: () => { submit(area); area.focus(); } });
  const switcher = h('div', { class: 'view-switcher capture-modes', role: 'group', 'aria-label': 'Add to' });

  function choose(next, { focus = false } = {}) {
    if (!(next in DASH_MODES)) return;
    mode = next;
    writeMode(mode);
    const m = DASH_MODES[mode];
    area.placeholder = m.placeholder;
    area.setAttribute('aria-label', m.aria);
    button.textContent = m.button;
    fill(switcher, Object.entries(DASH_MODES).map(([key, value]) => h('button', {
      class: 'view-btn',
      type: 'button',
      'aria-pressed': String(key === mode),
      dataset: { mode: key },
      onClick: () => {
        choose(key);
        area.focus();
      },
    }, value.label)));
    if (focus) {
      area.scrollIntoView({ block: 'nearest' });
      area.focus();
    }
  }
  choose(mode);
  const el = h('div', { class: 'capture-field capture-field-modes' }, h('div', { class: 'capture-field-row' }, area, button), switcher);
  dashCapture = { choose };
  return el;
}
