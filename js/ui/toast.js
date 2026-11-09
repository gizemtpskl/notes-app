/**
 * toast.js: short messages with an optional Undo or other action. Announced to screen readers.
 */
import { h } from './dom.js';
import { icon } from './icons.js';

const TOAST_MS = 7000;
let region = null;

function ensureRegion() {
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  // A modal <dialog> sits in the top layer and would cover the toast, so toasts move into it.
  const parent = document.querySelector('dialog[open]') ?? document.body;
  if (region.parentElement !== parent) parent.append(region);
  return region;
}

export function toast(message, { undo, action, error = false, duration = TOAST_MS } = {}) {
  const box = ensureRegion();
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h('div', { class: `toast${error ? ' toast-error' : ''}` },
    h('span', { class: 'toast-text' }, message),
    undo && h('button', {
      class: 'toast-action',
      type: 'button',
      onClick: () => {
        dismiss();
        undo();
      },
    }, 'Undo'),
    action && h('button', {
      class: 'toast-action',
      type: 'button',
      onClick: () => {
        dismiss();
        action.run();
      },
    }, action.label),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onClick: dismiss }, icon('close', 14)));
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.append(el);
  timer = setTimeout(dismiss, error ? duration * 2 : duration);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => {
    timer = setTimeout(dismiss, 3000);
  });
  return dismiss;
}
