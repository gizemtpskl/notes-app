/**
 * lockScreen.js: asks for the passcode before anything else opens. Nothing of the app or its data
 * is available until the passcode is right. Resolves with an unlocked storage adapter.
 */
import { EncryptedAdapter, WrongPasscodeError, openLock } from '../data/crypto.js';
import { h } from '../ui/dom.js';
import { confirmDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';

export function runLockScreen(storage, lockRecord) {
  return new Promise((resolve) => {
    const error = h('p', { class: 'lock-error', role: 'alert' });
    const input = h('input', {
      class: 'input lock-input',
      type: 'password',
      id: 'lock-passcode',
      autocomplete: 'current-password',
      required: true,
      autofocus: true,
    });
    const button = h('button', { class: 'btn btn-primary btn-large', type: 'submit' }, 'Unlock');

    const eraseLink = h('button', {
      class: 'btn-link lock-forgot',
      type: 'button',
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Erase everything on this device?',
          message: 'A forgotten passcode can\'t be recovered, so the only way back in is to start over. Every note here will be permanently deleted. You can then import a backup file, if you have one.',
          confirmLabel: 'Erase everything',
          danger: true,
        });
        if (ok) {
          await storage.clear();
          location.reload();
        }
      },
    }, 'Forgot the passcode?');

    const screen = h('main', { class: 'lock' },
      h('form', {
        class: 'lock-box',
        onSubmit: async (event) => {
          event.preventDefault();
          if (!input.value) return;
          button.disabled = true;
          button.textContent = 'Unlocking…';
          error.textContent = '';
          try {
            const key = await openLock(lockRecord, input.value);
            input.value = '';
            screen.remove();
            resolve(new EncryptedAdapter(storage, key));
          } catch (problem) {
            button.disabled = false;
            button.textContent = 'Unlock';
            error.textContent = problem instanceof WrongPasscodeError ? problem.message : 'The notes could not be opened.';
            if (!(problem instanceof WrongPasscodeError)) console.error(problem);
            input.select();
          }
        },
      },
      h('div', { class: 'lock-icon' }, icon('lock', 26)),
      h('h1', { class: 'lock-title' }, 'Your notes are locked'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Passcode'), input),
      error,
      button,
      eraseLink));

    document.body.append(screen);
    input.focus();
  });
}
