/**
 * syncSettings.js: turning Google Drive sync on and off in Settings, the passphrase prompt, and
 * the sync line at the bottom of the sidebar, which is also where signing in happens each session.
 */
import { app } from '../context.js';
import { calendarConfig, isClientId } from '../data/googleCalendar.js';
import { openDialog } from '../ui/dialog.js';
import { fill, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import {
  NeedPassphraseError, WrongPasscodeError, driveConfig, driveStatus, enterPassphrase, onDriveStatus, signInToDrive, syncDrive, turnOffDrive,
  turnOnDrive,
} from './driveSync.js';
import { loadGoogleLibrary } from './googleAuth.js';

const MIN_PASSPHRASE = 8;

export const syncedText = (lastSync) => {
  if (!lastSync) return 'Not synced yet';
  const minutes = Math.round((Date.now() - lastSync) / 60000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} min ago`;
  return `Synced at ${new Date(lastSync).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

/** Signs in and syncs, from a click. Problems become a toast. */
export async function signInAndSync() {
  try {
    await signInToDrive();
    await syncDrive();
  } catch (error) {
    toast(error.message, { error: true });
  }
}

/** Asks for the passphrase of an encrypted copy that this device can't open yet. */
export function passphraseDialog() {
  return openDialog({
    title: 'Sync passphrase',
    build: (close) => {
      const input = h('input', {
        class: 'input', type: 'password', autocomplete: 'current-password', autofocus: true, 'aria-describedby': 'sync-pass-error',
      });
      const error = h('p', { class: 'field-error', id: 'sync-pass-error', role: 'alert' });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock');
      return h('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          error.textContent = '';
          try {
            await enterPassphrase(input.value);
            close(true);
          } catch (problem) {
            error.textContent = problem instanceof WrongPasscodeError ? 'That passphrase doesn’t open the copy in Google Drive.' : problem.message;
            submit.disabled = false;
            input.focus();
          }
        },
      },
      h('p', { class: 'dialog-text' }, 'The copy in your Google Drive is encrypted. Enter the passphrase you chose when you turned sync on.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Passphrase'), input),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
        submit));
    },
  });
}

function setupSteps() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  return h('details', { class: 'calendar-steps' },
    h('summary', null, 'How to set it up (free, about 10 minutes, less if Google Calendar is set up)'),
    h('ol', null,
      h('li', null, 'Use the same Google project as for Google Calendar, or make one as its steps describe, with this address as an Authorized JavaScript origin: ', h('code', null, location.origin)),
      h('li', null, 'Turn on the ', link('https://console.cloud.google.com/apis/library/drive.googleapis.com', 'Google Drive API'), ' for that project.'),
      h('li', null, 'Paste the project’s Client ID below, choose a passphrase, and turn sync on.'),
      h('li', null, 'On your other devices, choose Start empty when the app first opens, then turn sync on here with the same Client ID and passphrase.')));
}

export function driveSection() {
  const { db } = app;
  const el = h('div');

  function render() {
    const hadFocus = el.contains(document.activeElement);
    const config = driveConfig();
    const { state, message } = driveStatus();
    const problem = h('p', { class: 'field-error', role: 'alert' }, state === 'error' || state === 'passphrase' ? message : '');

    if (!config.on) {
      const clientId = h('input', {
        class: 'input', type: 'text', value: config.clientId || calendarConfig(db).clientId, autocomplete: 'off', spellcheck: 'false', placeholder: '123456-abc.apps.googleusercontent.com',
      });
      const encrypt = h('input', { type: 'checkbox', checked: true });
      const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      const passFields = h('div', { class: 'field-row sync-pass' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sync passphrase'), pass),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type it again'), again));
      encrypt.addEventListener('change', () => {
        passFields.hidden = !encrypt.checked;
      });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('repeat', 16), 'Turn on sync');
      fill(el,
        h('p', { class: 'settings-text' }, 'Off. Turn it on to keep a copy of your notes in your own Google Drive, and to have the same notes on every device where you turn it on. Changes made on one device reach the others the next time they sync.'),
        h('p', { class: 'settings-text' }, 'The copy sits in a hidden folder that only this app can see. With a passphrase it’s encrypted before it leaves the device, so Google can’t read it.'),
        setupSteps(),
        h('form', {
          class: 'sync-form',
          onSubmit: async (event) => {
            event.preventDefault();
            problem.textContent = '';
            const id = clientId.value.trim();
            if (!isClientId(id)) {
              problem.textContent = 'That doesn’t look like a Client ID. It ends in .apps.googleusercontent.com.';
              return;
            }
            const passphrase = encrypt.checked ? pass.value : '';
            if (encrypt.checked && passphrase.length < MIN_PASSPHRASE) {
              problem.textContent = `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`;
              return;
            }
            if (encrypt.checked && passphrase !== again.value) {
              problem.textContent = 'The two passphrases are not the same.';
              return;
            }
            submit.disabled = true;
            try {
              await signInToDrive(id);
              await turnOnDrive({ clientId: id, passphrase });
              toast('Sync is on');
            } catch (error) {
              problem.textContent = error instanceof WrongPasscodeError
                ? 'That passphrase doesn’t open the copy already in your Google Drive. Use the one you chose on your other device.'
                : error.message;
              submit.disabled = false;
            }
          },
        },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Client ID'), clientId),
        h('label', { class: 'check-field' }, encrypt, 'Encrypt with a passphrase (recommended)'),
        passFields,
        h('p', { class: 'field-hint' }, 'Use the same passphrase on every device. If you forget it, the copy in Google Drive can’t be read, but the notes on your devices stay safe. If a copy is already in your Drive, its choice is used.'),
        problem,
        submit));
      clientId.addEventListener('input', () => {
        if (isClientId(clientId.value.trim())) loadGoogleLibrary().catch(() => {});
      });
      if (isClientId(clientId.value.trim())) loadGoogleLibrary().catch(() => {});
      return;
    }

    fill(el,
      h('p', { class: 'settings-text' }, `On. ${config.encrypted ? 'Your notes are encrypted with your passphrase before they go to your Google Drive.' : 'Your notes go to your Google Drive without encryption.'} Edits made on two devices before they sync are both kept: the newer one wins, and the other goes into the note’s version history.`),
      h('p', { class: 'settings-text', role: 'status' }, {
        'signed-out': 'Sign in to sync. Google asks for this once each time the app opens.',
        syncing: 'Syncing…',
        passphrase: 'This device needs the sync passphrase.',
        error: 'Sync had a problem.',
        idle: `${syncedText(config.lastSync)}.`,
      }[state]),
      problem,
      h('div', { class: 'settings-actions' },
        state === 'passphrase'
          ? h('button', { class: 'btn btn-primary', type: 'button', onClick: () => passphraseDialog() }, 'Enter passphrase')
          : h('button', {
            class: 'btn btn-primary',
            type: 'button',
            disabled: state === 'syncing',
            onClick: () => signInAndSync(),
          }, icon('repeat', 16), state === 'signed-out' ? 'Sign in and sync' : 'Sync now'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            const result = await turnOffDialog();
            if (result) toast(result.deleted ? 'Sync is off, and the copy in Google Drive is deleted' : 'Sync is off on this device');
          },
        }, 'Turn off')));
    if (hadFocus) el.querySelector('button:not(:disabled)')?.focus();
  }

  render();
  const stop = onDriveStatus(render);
  const off = db.on((change) => {
    if ((change.ids.has('driveSync')) && !el.contains(document.activeElement)) render();
  });
  return { el, destroy: () => { stop(); off(); } };
}

function turnOffDialog() {
  return openDialog({
    title: 'Turn off sync?',
    build: (close) => {
      const remove = h('input', { type: 'checkbox' });
      const error = h('p', { class: 'field-error', role: 'alert' });
      const confirm = h('button', {
        class: 'btn btn-primary',
        type: 'button',
        autofocus: true,
        onClick: async () => {
          confirm.disabled = true;
          try {
            await turnOffDrive({ deleteCopy: remove.checked });
            close({ deleted: remove.checked });
          } catch (problem) {
            error.textContent = problem.message;
            confirm.disabled = false;
          }
        },
      }, 'Turn off');
      return h('div', null,
        h('p', { class: 'dialog-text' }, 'This device stops syncing. Its notes stay as they are, and so do your other devices.'),
        h('label', { class: 'check-field' }, remove, 'Also delete the copy in Google Drive'),
        h('p', { class: 'field-hint' }, 'Another device that still has sync on puts its copy back the next time it syncs, so turn sync off there too.'),
        error,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
          confirm));
    },
  });
}

/**
 * The sync line in the sidebar. One element for the app's lifetime, so the sidebar can redraw
 * around it. It's empty while sync is off.
 */
let navItem = null;
export function syncNavItem() {
  if (navItem) return navItem;
  navItem = h('li', { class: 'sync-nav' });
  const render = () => {
    const config = driveConfig();
    if (!config.on) {
      fill(navItem);
      return;
    }
    const { state } = driveStatus();
    const text = {
      'signed-out': 'Sign in to sync', syncing: 'Syncing…', passphrase: 'Enter sync passphrase', error: 'Sync problem, try again', idle: syncedText(config.lastSync),
    }[state];
    fill(navItem, h('div', { class: 'nav-row' },
      h('button', {
        class: `nav-link nav-button sync-button is-${state}`,
        type: 'button',
        dataset: { focusKey: 'sync' },
        title: state === 'error' ? `${driveStatus().message} Click to try again.` : null,
        onClick: () => {
          if (state === 'passphrase') passphraseDialog();
          else signInAndSync();
        },
      }, icon('repeat'), h('span', { class: 'nav-label' }, text),
      state === 'error' && h('span', { class: 'sr-only' }, `: ${driveStatus().message} Click to try again.`))));
  };
  render();
  onDriveStatus(render);
  app.db.on((change) => {
    if (change.ids.has('driveSync')) render();
  });
  setInterval(render, 60000);
  return navItem;
}

export { NeedPassphraseError };
