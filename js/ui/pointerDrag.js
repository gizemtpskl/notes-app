/**
 * pointerDrag.js: dragging with pointer events, so it works the same with mouse, touch and pen.
 * (HTML5 drag and drop doesn't fire on touch screens.) Attach it to a small handle element;
 * the handle has touch-action: none so a drag on it doesn't scroll the page.
 *
 *   pointerDrag(handle, { start(event), move(event), drop(event), cancel() });
 */
const DRAG_THRESHOLD_PX = 4;

export function pointerDrag(handle, { start, move, drop, cancel }) {
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    let active = false;

    const finish = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
    };
    const onMove = (event) => {
      if (!active && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) >= DRAG_THRESHOLD_PX) {
        active = true;
        start?.(event);
      }
      if (active) move?.(event);
    };
    const onUp = (event) => {
      finish();
      if (active) drop?.(event);
    };
    const onCancel = () => {
      finish();
      if (active) cancel?.();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}
