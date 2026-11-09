/**
 * gridDrag.js: dragging on the timetable grid, snapped to 15 minutes.
 *   - drag on an empty part of a day to draw a new block
 *   - drag a block to move it, to another time or day
 *   - drag a block's bottom edge to make it longer or shorter
 *   - drag a task from the task list onto a day to give it a time
 *
 * Blocks move with a mouse or pen. On a touch screen a finger scrolls the grid instead, so
 * blocks are moved in their editor there; tasks have a handle that works with a finger too.
 * Everything here can also be done without dragging, from the block editor.
 */
import { toMinutes } from '../data/timetable.js';
import { pointerDrag } from '../ui/pointerDrag.js';
import { h } from '../ui/dom.js';

export const SNAP = 15;
const THRESHOLD = 4;
const LAST = 24 * 60 - 1;

const snap = (minutes) => Math.round(minutes / SNAP) * SNAP;
export const clockOf = (total) => {
  const minutes = Math.max(0, Math.min(LAST, total));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

function columnAt(x, y) {
  return document.elementsFromPoint(x, y).find((el) => el.classList?.contains('tt-column')) ?? null;
}

/**
 * Turns on dragging inside root, which holds the grid. Read fresh on every drag:
 *   geometry()                        { pxPerMinute, firstMinute }
 *   find(key)                         the occurrence a block shows
 *   onCreate(date, start, end)        a block was drawn
 *   onChange(occurrence, { date, start, end })   a block was moved or resized
 *   onCancel()                        Esc was pressed: put everything back
 */
export function attachGridDrag(root, {
  geometry, find, onCreate, onChange, onCancel,
}) {
  root.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || down.pointerType === 'touch') return;
    if (down.target.closest('input, a')) return;
    const column = down.target.closest('.tt-column');
    if (!column) return;
    const blockEl = down.target.closest('.tt-block');
    const resizing = Boolean(down.target.closest('.tt-resize'));
    const mode = blockEl ? (resizing ? 'resize' : 'move') : down.target === column ? 'create' : null;
    if (!mode) return;
    const occurrence = blockEl ? find(blockEl.dataset.key) : null;
    if (blockEl && !occurrence) return;
    const { pxPerMinute, firstMinute } = geometry();
    const minuteAt = (col, y) => (y - col.getBoundingClientRect().top) / pxPerMinute + firstMinute;

    let active = false;
    let result = null;
    let ghost = null;

    const place = (el, start, end) => {
      el.style.setProperty('--top', `${(start - firstMinute) * pxPerMinute}px`);
      el.style.setProperty('--height', `${Math.max(18, (end - start) * pxPerMinute - 2)}px`);
    };

    const update = (event) => {
      const target = columnAt(event.clientX, event.clientY) ?? column;
      if (mode === 'create') {
        const from = snap(minuteAt(column, down.clientY));
        const to = snap(minuteAt(column, event.clientY));
        const start = Math.max(0, Math.min(from, to));
        const end = Math.min(LAST, Math.max(from, to, start + SNAP));
        result = { date: column.dataset.date, start: clockOf(start), end: clockOf(end) };
        place(ghost, start, end);
        ghost.textContent = `${result.start}–${result.end}`;
        return;
      }
      const start0 = toMinutes(occurrence.start);
      const end0 = toMinutes(occurrence.end);
      const delta = snap((event.clientY - down.clientY) / pxPerMinute);
      if (mode === 'resize') {
        const end = Math.min(LAST, Math.max(start0 + SNAP, end0 + delta));
        result = { date: occurrence.date, start: occurrence.start, end: clockOf(end) };
        place(blockEl, start0, end);
      } else {
        const length = end0 - start0;
        const start = Math.max(0, Math.min(LAST - length, start0 + delta));
        result = { date: target.dataset.date, start: clockOf(start), end: clockOf(start + length) };
        if (blockEl.parentElement !== target) target.append(blockEl);
        place(blockEl, start, start + length);
      }
      blockEl.dataset.dragTime = `${result.start}–${result.end}`;
    };

    const onMove = (event) => {
      if (!active) {
        if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < THRESHOLD) return;
        active = true;
        root.classList.add('is-dragging');
        if (mode === 'create') {
          ghost = h('div', { class: 'tt-ghost', 'aria-hidden': 'true' });
          column.append(ghost);
        } else {
          blockEl.classList.add('is-dragged');
          blockEl.style.setProperty('--lane', 0);
          blockEl.style.setProperty('--lanes', 1);
        }
      }
      event.preventDefault();
      update(event);
    };

    const stop = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onAbort);
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('is-dragging');
      ghost?.remove();
    };

    // The click that ends a drag mustn't also open the editor.
    const swallowClick = () => {
      const block = (event) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener('click', block, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', block, { capture: true }), 0);
    };

    const onUp = () => {
      stop();
      if (!active || !result) return;
      swallowClick();
      if (mode === 'create') onCreate(result.date, result.start, result.end);
      else if (result.date === occurrence.date && result.start === occurrence.start && result.end === occurrence.end) onCancel();
      else onChange(occurrence, result);
    };
    const onAbort = () => {
      stop();
      if (active) onCancel();
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && active) {
        event.preventDefault();
        event.stopPropagation();
        onAbort();
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onAbort);
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * Lets a task be dragged by its handle and dropped on a day of the grid.
 * onDrop(date, start) gets the day and the time under the pointer.
 */
export function taskHandleDrag(handle, label, { geometry, onDrop }) {
  let ghost = null;
  const follow = (event) => {
    ghost.style.setProperty('--x', `${event.clientX}px`);
    ghost.style.setProperty('--y', `${event.clientY}px`);
    for (const col of document.querySelectorAll('.tt-column.is-drop')) col.classList.remove('is-drop');
    columnAt(event.clientX, event.clientY)?.classList.add('is-drop');
  };
  pointerDrag(handle, {
    start: (event) => {
      ghost = h('div', { class: 'tt-task-ghost', 'aria-hidden': 'true' }, label);
      document.body.append(ghost);
      document.body.classList.add('is-dragging-task');
      follow(event);
    },
    move: follow,
    drop: (event) => {
      const column = columnAt(event.clientX, event.clientY);
      ghost.remove();
      document.body.classList.remove('is-dragging-task');
      for (const col of document.querySelectorAll('.tt-column.is-drop')) col.classList.remove('is-drop');
      if (!column) return;
      const { pxPerMinute, firstMinute } = geometry();
      const minute = snap((event.clientY - column.getBoundingClientRect().top) / pxPerMinute + firstMinute);
      onDrop(column.dataset.date, clockOf(Math.max(0, Math.min(LAST - 60, minute))));
    },
    cancel: () => {
      ghost?.remove();
      document.body.classList.remove('is-dragging-task');
      for (const col of document.querySelectorAll('.tt-column.is-drop')) col.classList.remove('is-drop');
    },
  });
}
