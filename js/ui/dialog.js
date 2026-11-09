/**
 * dialog.js: modal dialogs on the native <dialog> element, which traps focus, closes on Esc
 * and returns focus to the opener. openDialog() resolves with the value passed to close().
 */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * build(close) returns the dialog's content.
 * Options: title, ariaLabel (when there is no visible title), className, hideClose.
 */
export function openDialog({ title, ariaLabel, className = '', hideClose = false, build }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    let result;
    const dialog = h('dialog', { class: `dialog ${className}`, 'aria-label': title ?? ariaLabel });
    const close = (value) => {
      result = value;
      dialog.close();
    };
    dialog.append(h('div', { class: 'dialog-inner' },
      title && h('header', { class: 'dialog-head' },
        h('h2', { class: 'dialog-title' }, title),
        !hideClose && h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close() }, icon('close'))),
      build(close)));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });
    dialog.addEventListener('close', () => {
      // Toasts shown while a dialog is open live inside it. Keep them when it closes.
      const toasts = dialog.querySelector('.toasts');
      if (toasts) document.body.append(toasts);
      dialog.remove();
      if (opener?.isConnected) opener.focus?.();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    // Browsers focus the first button, which would be Close. The content is a better place to start.
    if (document.activeElement?.closest('.dialog-head')) {
      dialog.querySelector('.dialog-inner > :not(.dialog-head) :is(input, select, textarea, button, a[href])')?.focus();
    }
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openDialog({
    title,
    build: (close) => h('div', null,
      h('p', { class: 'dialog-text' }, message),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
        h('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', autofocus: true, onClick: () => close(true),
        }, confirmLabel))),
  }).then(Boolean);
}

/** Asks for one line of text. Resolves with the trimmed text, or null if cancelled. */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', validate }) {
  return openDialog({
    title,
    build: (close) => {
      const input = h('input', { class: 'input', type: 'text', value, placeholder, autofocus: true, 'aria-describedby': 'prompt-error' });
      const error = h('p', { class: 'field-error', id: 'prompt-error', role: 'alert' });
      return h('form', {
        method: 'dialog',
        onSubmit: (event) => {
          event.preventDefault();
          const text = input.value.trim();
          const problem = validate?.(text);
          if (problem) {
            error.textContent = problem;
            input.focus();
          } else {
            close(text);
          }
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel)));
    },
  }).then((text) => text ?? null);
}
