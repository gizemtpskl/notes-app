/**
 * serverSettings.js: connecting to your own notes server in Settings, which syncs your devices
 * and lets Claude use your notes as a connector. Setting the server up is in server/README.md.
 */
import { app } from '../context.js';
import { fill, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import {
  MIN_ACCESS_KEY, MIN_PASSPHRASE, WrongPasscodeError, cleanServerUrl, connectServer, disconnectServer, onServerStatus, serverConfig, serverStatus, syncServer,
} from './serverSync.js';
import { syncedText } from './syncSettings.js';

const REPO = 'https://github.com/gizemtpskl/notes-app/blob/main/server/README.md';

function setupSteps() {
  return h('details', { class: 'calendar-steps' },
    h('summary', null, 'How to set up the server (free, about 15 minutes, once)'),
    h('ol', null,
      h('li', null, 'Make a free Cloudflare account.'),
      h('li', null, 'Follow ', h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, 'the steps in server/README.md'), ': a few commands in a terminal, in the app’s folder. You choose an access key there.'),
      h('li', null, 'Paste the server’s address and the access key below, and choose a passphrase for your private notes.'),
      h('li', null, 'In Claude, add a custom connector with the address shown here once you’re connected.'),
      h('li', null, 'On your other devices, choose Start empty when the app first opens, then connect here with the same address, access key and passphrase.')));
}

function copyButton(text, label) {
  return h('button', {
    class: 'btn btn-small',
    type: 'button',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied');
      } catch {
        toast('Couldn’t copy. Select the address and copy it yourself.', { error: true });
      }
    },
  }, icon('copy', 14), label);
}

export function serverSection() {
  const { db } = app;
  const el = h('div');

  function render() {
    const hadFocus = el.contains(document.activeElement);
    const config = serverConfig();
    const { state, message } = serverStatus();
    const problem = h('p', { class: 'field-error', role: 'alert' }, state === 'error' ? message : '');

    if (!config.on) {
      const url = h('input', {
        class: 'input', type: 'url', value: config.url, autocomplete: 'off', spellcheck: 'false', placeholder: 'https://notes-app-server.yourname.workers.dev', id: 'server-url',
      });
      const access = h('input', {
        class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'server-key', minlength: MIN_ACCESS_KEY,
      });
      const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'server-pass' });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('repeat', 16), 'Connect');
      fill(el,
        h('p', { class: 'settings-text' }, 'Not connected. Your own server keeps a copy of your notes, so the same notes are on every device where you connect it, and Claude can search, read and update them when you add it as a connector.'),
        h('p', { class: 'settings-text' }, 'The server is yours, on your own free Cloudflare account. Private notes, such as journal entries, are encrypted with your passphrase before they leave this device: neither the server nor Claude can read them.'),
        setupSteps(),
        h('form', {
          class: 'sync-form',
          onSubmit: async (event) => {
            event.preventDefault();
            problem.textContent = '';
            if (!cleanServerUrl(url.value)) {
              problem.textContent = 'That doesn’t look like a server address. It starts with https://.';
              url.focus();
              return;
            }
            submit.disabled = true;
            try {
              await connectServer({ url: url.value, access: access.value.trim(), passphrase: pass.value });
              const { state: after, message: why } = serverStatus();
              toast(after === 'error' ? `Connected, but the first sync had a problem: ${why}` : 'Connected to your server', { error: after === 'error' });
            } catch (error) {
              problem.textContent = error instanceof WrongPasscodeError
                ? 'That passphrase doesn’t match the one your other devices use for private notes.'
                : error.message;
              submit.disabled = false;
            }
          },
        },
        h('label', { class: 'field', for: 'server-url' }, h('span', { class: 'field-label' }, 'Server address'), url),
        h('label', { class: 'field', for: 'server-key' }, h('span', { class: 'field-label' }, 'Access key'), access),
        h('label', { class: 'field', for: 'server-pass' }, h('span', { class: 'field-label' }, 'Passphrase for private notes'), pass),
        h('p', { class: 'field-hint' }, `At least ${MIN_PASSPHRASE} characters. The first device you connect sets it; use the same one on the others. If you forget it, private notes can’t be opened on a new device, but they stay safe on the devices that have them.`),
        problem,
        submit));
      return;
    }

    const mcp = `${config.url}/mcp`;
    fill(el,
      h('p', { class: 'settings-text' }, 'Connected to ', h('code', null, config.url), '. Changes reach your other devices and Claude within a minute while the app is open. Private notes go encrypted.'),
      h('p', { class: 'settings-text', role: 'status' }, {
        syncing: 'Syncing…', error: 'Sync had a problem.', idle: `${syncedText(config.lastSync)}.`, off: '',
      }[state]),
      problem,
      h('div', { class: 'settings-actions' },
        h('button', {
          class: 'btn btn-primary', type: 'button', disabled: state === 'syncing', onClick: () => syncServer(),
        }, icon('repeat', 16), 'Sync now'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: () => {
            disconnectServer();
            toast('This device no longer syncs with your server');
          },
        }, 'Disconnect')),
      h('h3', { class: 'settings-subtitle' }, 'Use your notes in Claude'),
      h('p', { class: 'settings-text' }, 'In Claude, open Settings → Connectors → Add custom connector, and use this address. Claude then shows a page from your server: type your access key there to allow it.'),
      h('div', { class: 'server-mcp' }, h('code', { class: 'server-mcp-url' }, mcp), copyButton(mcp, 'Copy')),
      h('p', { class: 'field-hint' }, 'Claude can search and read your notes, tasks, deadlines and timetable, and, if you allow it, add and change them. It can’t delete anything, and a note it changes keeps its earlier version in the note’s history.'));
    if (hadFocus) el.querySelector('button:not(:disabled)')?.focus();
  }

  render();
  const stop = onServerStatus(render);
  const off = db.on((change) => {
    if (change.ids.has('serverSync') && !el.contains(document.activeElement)) render();
  });
  return { el, destroy: () => { stop(); off(); } };
}
