/**
 * drag.js: what is being dragged right now. dataTransfer contents can't be read during dragover,
 * so the sidebar's drop targets check this shared state instead.
 *   { kind: 'space' | 'collection' | 'note', id }
 */
let current = null;

export function startDrag(event, payload) {
  current = payload;
  event.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag without data.
  event.dataTransfer.setData('text/plain', payload.label ?? '');
}

export function endDrag() {
  current = null;
}

export function dragging() {
  return current;
}
