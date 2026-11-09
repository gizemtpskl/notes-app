/**
 * lockSettings.js: turning the passcode lock on and off, changing it, locking now and auto-lock.
 */
import { app } from '../context.js';
import {
  WrongPasscodeError, changePasscode, disableLock, enableLock, isCryptoAvailable, openLock,
} from '../data/crypto.js';
import { STORES } from '../data/schema.js';
import { fill, h } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const MIN_LENGTH = 6;
const AUTO_LOCK = [
  { value: 0, label: 'Never' },
  { value: 5, label: 'After 5 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 60, label: 'After 1 hour' },
];

const passwordInput = (label, autocomplete = 'new-password', extra = {}) => h('label', { class: 'field' },
  h('span', { class: 'field-label' }, label),
  h('input', {
    class: 'input', type: 'password', autocomplete, required: true, ...extra,
  }));

function problemFor(first, second) {
  if (first.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. Longer is much safer.`;
  if (first !== second) return 'The two passcodes are not the same.';
  return '';
}

function turnOnDialog() {
  return openDialog({
    title: 'Lock with a passcode',
    build: (close) => {
      const first = passwordInput('New passcode', 'new-password', { autofocus: true });
      const second = passwordInput('Type it again');
      const agree = h('input', { type: 'checkbox', required: true });
      const error = h('p', { class: 'field-error', role: 'alert' });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Encrypt and lock');
      return h('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          const a = first.querySelector('input').value;
          const problem = problemFor(a, second.querySelector('input').value);
          if (problem) {
            error.textContent = problem;
            return;
          }
          submit.disabled = true;
          submit.textContent = 'Encrypting…';
          try {
            const { db } = app;
            await db.flush();
            db.storage = await enableLock(db.storage, STORES, a);
            db.broadcastReload();
            close(true);
          } catch (failure) {
            console.error(failure);
            submit.disabled = false;
            submit.textContent = 'Encrypt and lock';
            error.textContent = 'Encrypting failed, so nothing was changed. Device storage may be full.';
          }
        },
      },
      h('div', { class: 'data-warning' },
        h('p', null, h('strong', null, 'A forgotten passcode cannot be recovered.')),
        h('p', null, 'Your notes are encrypted with it, and it is not stored anywhere. Nobody can reset it, including whoever made this app. If you forget it, your notes are gone unless you have a backup file.')),
      h('p', { class: 'settings-text lock-note' }, 'Backup files are not encrypted. Keep them somewhere safe.'),
      first,
      second,
      h('label', { class: 'check-field lock-agree' }, agree, 'I understand that a forgotten passcode means losing my notes'),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
        submit));
    },
  });
}

function currentPasscodeDialog({ title, confirmLabel, run, withNew = false }) {
  return openDialog({
    title,
    build: (close) => {
      const current = passwordInput('Current passcode', 'current-password', { autofocus: true });
      const first = withNew ? passwordInput('New passcode') : null;
      const second = withNew ? passwordInput('Type the new one again') : null;
      const error = h('p', { class: 'field-error', role: 'alert' });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel);
      return h('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          if (withNew) {
            const problem = problemFor(first.querySelector('input').value, second.querySelector('input').value);
            if (problem) {
              error.textContent = problem;
              return;
            }
          }
          submit.disabled = true;
          error.textContent = '';
          try {
            await run(current.querySelector('input').value, first?.querySelector('input').value);
            close(true);
          } catch (failure) {
            submit.disabled = false;
            if (failure instanceof WrongPasscodeError) {
              error.textContent = failure.message;
            } else {
              console.error(failure);
              error.textContent = 'That did not work, so nothing was changed.';
            }
          }
        },
      },
      current, first, second, error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
        submit));
    },
  });
}

/** Locks right away: everything decrypted is only in memory, so reloading forgets it. */
export async function lockNow() {
  const { db } = app;
  await db.flush();
  db.broadcastReload();
  location.reload();
}

let idleTimer = null;
let idleWatching = false;

function resetIdle() {
  clearTimeout(idleTimer);
  const minutes = app.db?.getSettings().lockAfterMinutes ?? 0;
  if (minutes > 0 && app.db.storage.encrypted) {
    idleTimer = setTimeout(lockNow, minutes * 60000);
  }
}

/** Starts the auto-lock timer. Any use of the app restarts it. */
export function startAutoLock() {
  if (idleWatching) return;
  idleWatching = true;
  for (const type of ['pointerdown', 'keydown', 'scroll']) {
    window.addEventListener(type, resetIdle, { passive: true, capture: true });
  }
  resetIdle();
}

/** The Lock section of Settings. */
export function lockSection() {
  const { db } = app;
  const el = h('div');

  function render() {
    if (!isCryptoAvailable()) {
      fill(el, h('p', { class: 'settings-text' }, 'The lock needs a secure connection. It works on GitHub Pages and on localhost, but not over plain http.'));
      return;
    }
    if (!db.storage.encrypted) {
      fill(el,
        h('p', { class: 'settings-text' }, 'Asks for a passcode when the app opens, and encrypts your notes on this device. It\'s off by default. A forgotten passcode cannot be recovered.'),
        h('div', { class: 'settings-actions' },
          h('button', {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              if (await turnOnDialog()) {
                toast('Your notes are now encrypted.');
                render();
                startAutoLock();
              }
            },
          }, icon('lock', 16), 'Set a passcode')));
      return;
    }
    const auto = h('select', {
      class: 'select',
      id: 'auto-lock',
      onChange: () => {
        db.updateSettings({ lockAfterMinutes: Number(auto.value) });
        resetIdle();
      },
    }, AUTO_LOCK.map((choice) => h('option', { value: choice.value, selected: choice.value === (db.getSettings().lockAfterMinutes ?? 0) }, choice.label)));
    fill(el,
      h('p', { class: 'settings-text' }, 'On. Your notes are encrypted on this device, and a passcode is needed to open them. Backup files are not encrypted.'),
      h('div', { class: 'settings-row' }, h('label', { for: 'auto-lock' }, 'Lock by itself when idle'), auto),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onClick: lockNow }, icon('lock', 16), 'Lock now'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            const done = await currentPasscodeDialog({
              title: 'Change passcode',
              confirmLabel: 'Change passcode',
              withNew: true,
              run: (oldCode, newCode) => changePasscode(db.storage, oldCode, newCode),
            });
            if (done) toast('Passcode changed.');
          },
        }, 'Change passcode'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            const done = await currentPasscodeDialog({
              title: 'Turn off the lock',
              confirmLabel: 'Decrypt and turn off',
              run: async (code) => {
                await openLock(await db.storage.inner.get('meta', 'lock'), code);
                await db.flush();
                db.storage = await disableLock(db.storage, STORES);
                db.broadcastReload();
              },
            });
            if (done) {
              toast('The lock is off. Your notes are no longer encrypted.');
              render();
            }
          },
        }, 'Turn off')));
  }

  render();
  return el;
}
