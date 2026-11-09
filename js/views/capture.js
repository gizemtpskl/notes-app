/**
 * capture.js: the fastest path into the app. A tiny box: type, press Enter, done.
 * Everything lands in the Inbox with no decisions needed.
 */
import { app } from '../context.js';
import { textToHtml } from '../data/html.js';
import { splitCapture } from '../data/text.js';
import { h, modKey, modName } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';

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
        h('p', { class: 'capture-hint' },
          h('span', null, h('kbd', null, 'Enter'), ' save to Inbox'),
          h('span', null, h('kbd', null, 'Shift'), ' ', h('kbd', null, 'Enter'), ' new line'),
          h('span', { class: 'capture-hint-wide' }, h('kbd', null, modName), ' ', h('kbd', null, 'Enter'), ' save and open')));
    },
  });
}

/** The same behaviour, inline on a page. */
export function captureField() {
  const area = captureArea({
    placeholder: 'Capture a thought and press Enter…',
    label: 'Quick capture to Inbox',
    onSave: (a) => {
      if (saveCapture(a.value)) {
        a.value = '';
        autoGrow(a);
      }
    },
    onOpen: (a) => {
      const note = saveCapture(a.value);
      if (note) app.navigate(`note/${note.id}`);
    },
  });
  return h('div', { class: 'capture-field' }, area);
}
