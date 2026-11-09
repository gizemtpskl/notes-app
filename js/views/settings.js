/**
 * settings.js: appearance, data safety, backup and restore, and erase.
 */
import { app } from '../context.js';
import { BACKUP_REMINDER_DAYS } from '../data/schema.js';
import { fill, formatBytes, fullDate, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { canInstall, onInstallChange, promptInstall } from '../pwa.js';
import { calendarConfig } from '../data/googleCalendar.js';
import { calendarSection } from './calendarSettings.js';
import { lockSection } from './lockSettings.js';
import { exportAllMarkdown, exportBackup, importBackup } from './transfer.js';
import { applyTheme } from './theme.js';

const WEEK_STARTS = [
  { value: 'auto', label: 'Match my language' },
  { value: 'mon', label: 'Monday' },
  { value: 'sun', label: 'Sunday' },
  { value: 'sat', label: 'Saturday' },
];

const THEMES = [
  { value: 'system', label: 'Match device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function section(title, ...content) {
  return h('section', { class: 'settings-section' }, h('h2', { class: 'section-title' }, title), content);
}

function eraseDialog() {
  return openDialog({
    title: 'Erase all data?',
    build: (close) => {
      const input = h('input', {
        class: 'input', type: 'text', autocomplete: 'off', placeholder: 'ERASE', 'aria-label': 'Type ERASE to confirm',
      });
      const button = h('button', { class: 'btn btn-danger', type: 'submit', disabled: true }, 'Erase everything');
      input.addEventListener('input', () => {
        button.disabled = input.value.trim() !== 'ERASE';
      });
      return h('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          if (input.value.trim() !== 'ERASE') return;
          await app.db.eraseAll();
          close(true);
          location.hash = '';
          location.reload();
        },
      },
      h('p', { class: 'dialog-text' }, 'Every note, image and setting in this browser will be permanently deleted. This cannot be undone. Type ERASE to confirm.'),
      input,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        button));
    },
  });
}

export function settingsView() {
  const { db } = app;
  const storageInfo = h('p', { class: 'settings-text', role: 'status' });
  const lastBackup = h('p', { class: 'settings-text' });

  function renderLastBackup() {
    const last = db.getMeta('lastExportAt');
    lastBackup.textContent = last
      ? `Last backup: ${fullDate(last)}.`
      : 'You have not made a backup yet.';
  }

  async function refreshStorage() {
    const parts = [`Saved with ${{ indexeddb: 'IndexedDB', localstorage: 'localStorage', memory: 'temporary memory only' }[db.storage.kind]}.`];
    parts.unshift(`${plural(db.data.notes.size, 'note')} in total.`);
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.usage !== undefined) parts.push(`Using about ${formatBytes(estimate.usage)}.`);
      const persisted = await navigator.storage?.persisted?.();
      if (persisted === true) parts.push('The browser has agreed not to clear this data automatically.');
      else if (persisted === false) parts.push('The browser may clear this data if the device runs low on space, so keep backups.');
    } catch {
      // Storage details are informational only.
    }
    storageInfo.textContent = parts.join(' ');
  }

  const themeSelect = h('select', {
    class: 'select',
    id: 'theme-select',
    onChange: () => {
      db.updateSettings({ theme: themeSelect.value });
      applyTheme(themeSelect.value);
    },
  }, THEMES.map((theme) => h('option', { value: theme.value, selected: db.getSettings().theme === theme.value }, theme.label)));

  const weekSelect = h('select', {
    class: 'select',
    id: 'week-select',
    onChange: () => db.updateSettings({ weekStart: weekSelect.value }),
  }, WEEK_STARTS.map((week) => h('option', { value: week.value, selected: (db.getSettings().weekStart ?? 'auto') === week.value }, week.label)));

  const startSelect = h('select', {
    class: 'select',
    id: 'start-select',
    onChange: () => db.updateSettings({ startScreen: startSelect.value }),
  }, [['dashboard', 'Dashboard'], ['inbox', 'Inbox'], ['last', 'The last note I opened']].map(([value, text]) => h('option', { value, selected: (db.getSettings().startScreen ?? 'dashboard') === value }, text)));

  const offline = h('div');
  function renderOffline() {
    const works = 'serviceWorker' in navigator;
    fill(offline,
      h('p', { class: 'settings-text' }, works
        ? 'This app works without a connection once it has been opened. You can also install it, so it opens in its own window.'
        : 'This browser can\'t keep the app available offline.'),
      canInstall()
        ? h('div', { class: 'settings-actions' }, h('button', { class: 'btn', type: 'button', onClick: promptInstall }, icon('download', 16), 'Install this app'))
        : works && h('p', { class: 'settings-text' }, 'To install it: in Chrome or Edge, use the install icon in the address bar. In Safari on iPhone, use Share, then Add to Home Screen. In Safari on a Mac, use File, then Add to Dock.'));
  }
  renderOffline();
  const stopWatchingInstall = onInstallChange(renderOffline);

  const calendar = calendarSection();

  renderLastBackup();
  refreshStorage();

  return {
    title: 'Settings',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' }, h('h1', { class: 'page-title', tabindex: '-1' }, 'Settings')),

      section('Appearance',
        h('div', { class: 'settings-row' },
          h('label', { for: 'theme-select' }, 'Theme'),
          themeSelect),
        h('div', { class: 'settings-row' },
          h('label', { for: 'week-select' }, 'Week starts on'),
          weekSelect),
        h('div', { class: 'settings-row' },
          h('label', { for: 'start-select' }, 'Open the app on'),
          startSelect),
        h('div', { class: 'settings-row' },
          h('span', null, 'Keyboard shortcuts'),
          h('button', { class: 'btn', type: 'button', onClick: () => app.showShortcuts() }, icon('keyboard', 16), 'Show shortcuts'))),

      section('Organizing',
        h('div', { class: 'settings-row' },
          h('span', null, 'Note types and custom fields'),
          h('a', { class: 'btn', href: '#/types' }, icon('edit', 16), 'Manage types')),
        h('div', { class: 'settings-row' },
          h('span', null, 'Templates for new notes'),
          h('a', { class: 'btn', href: '#/templates' }, icon('template', 16), 'Templates')),
        h('div', { class: 'settings-row' },
          h('span', null, 'Find duplicates, empty notes, unused tags and old notes'),
          h('a', { class: 'btn', href: '#/tidy' }, icon('broom', 16), 'Tidy up')),
        h('div', { class: 'settings-row' },
          h('span', null, 'Notes per space, tasks, journal streak, mood and more'),
          h('a', { class: 'btn', href: '#/stats' }, icon('chart', 16), 'Statistics')),
        h('div', { class: 'settings-row' },
          h('label', { for: 'private-home' }, 'Show private notes, such as journal entries, on Home. Search has its own switch.'),
          h('input', {
            id: 'private-home',
            type: 'checkbox',
            checked: db.getSettings().showPrivateOnHome === true,
            onChange: (event) => db.updateSettings({ showPrivateOnHome: event.target.checked }),
          }))),

      section('Your data',
        h('div', { class: 'data-warning' },
          h('p', null, h('strong', null, 'Your notes live only in this browser, on this device.')),
          h('p', null, calendarConfig(db).on
            ? 'Nothing is uploaded except for the tasks you send to Google Calendar, which is on below. There is no account here, and no copy of your notes anywhere else. If you clear your browser data or lose this device, your notes are gone unless you have a backup file.'
            : 'Nothing is uploaded and there is no account, so nobody else can read them. It also means there is no copy anywhere else. If you clear your browser data or lose this device, your notes are gone unless you have a backup file.')),
        storageInfo),

      section('Passcode lock', lockSection()),

      section('Google Calendar', calendar.el),

      section('Use it offline', offline),

      section('Backup',
        h('p', { class: 'settings-text' }, `A JSON backup contains everything and can be imported again. You'll get a reminder after ${BACKUP_REMINDER_DAYS} days without one. Store the file somewhere safe, such as a cloud drive.`),
        lastBackup,
        h('div', { class: 'settings-actions' },
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onClick: async () => {
              await exportBackup();
              renderLastBackup();
            },
          }, icon('download', 16), 'Download backup (JSON)'),
          h('button', {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              await importBackup();
              refreshStorage();
            },
          }, icon('upload', 16), 'Import backup')),
        h('p', { class: 'settings-text' }, 'To use your notes on another device, download a backup here and import it there with Merge. The two devices do not sync by themselves.')),

      section('Markdown export',
        h('p', { class: 'settings-text' }, 'Readable files for any other app, in folders by space and collection. To export one note or collection, use its menu. Markdown is for reading elsewhere. To restore notes here, use the JSON backup.'),
        h('div', { class: 'settings-actions' },
          h('button', {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              await exportAllMarkdown();
              renderLastBackup();
            },
          }, icon('download', 16), 'Export everything (zip)'))),

      section('Danger zone',
        h('p', { class: 'settings-text' }, 'Permanently delete every note and setting from this browser.'),
        h('div', { class: 'settings-actions' },
          h('button', { class: 'btn btn-danger-quiet', type: 'button', onClick: eraseDialog }, icon('trash', 16), 'Erase all data')))),
    update: () => refreshStorage(),
    destroy: () => {
      stopWatchingInstall();
      calendar.destroy();
    },
  };
}
