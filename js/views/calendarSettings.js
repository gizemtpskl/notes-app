/**
 * calendarSettings.js: setting up Google Calendar in Settings, and the small status line on Today.
 */
import { app } from '../context.js';
import { WEEKS_AHEAD, blockLinks } from '../data/calendarTimetable.js';
import { calendarConfig, clearEvents, isClientId, syncLinks, updateCalendarConfig } from '../data/googleCalendar.js';
import { openDialog } from '../ui/dialog.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import {
  calendarStatus, connectCalendar, disconnectCalendar, loadGoogleLibrary, onCalendarStatus, setSendBlocks, setShowEvents, syncCalendar,
} from './calendarConnection.js';

const lastSyncText = (lastSync) => (lastSync
  ? `Last synced at ${new Date(lastSync).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
  : 'Not synced yet.');

function setupSteps() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  return h('details', { class: 'calendar-steps' },
    h('summary', null, 'How to get a Client ID (free, about 15 minutes)'),
    h('ol', null,
      h('li', null, 'In the ', link('https://console.cloud.google.com/projectcreate', 'Google Cloud Console'), ', create a project. You don’t need to add a payment method.'),
      h('li', null, 'Turn on the ', link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'), ' for that project.'),
      h('li', null, 'Open ', link('https://console.cloud.google.com/auth/overview', 'Google Auth Platform'), ' and fill in the app name and your email. Choose External as the audience.'),
      h('li', null, 'Under Audience, add your own Google address as a test user.'),
      h('li', null, 'Under Clients, create a client of type Web application. Add this to Authorized JavaScript origins: ', h('code', null, location.origin),
        location.hostname === 'localhost' && [' and also ', h('code', null, 'http://localhost')]),
      h('li', null, 'Copy the Client ID and paste it below. It isn’t a password.')));
}

function disconnectDialog() {
  const count = Object.keys(syncLinks(app.db)).length + Object.keys(blockLinks(app.db)).length;
  return openDialog({
    title: 'Turn off Google Calendar?',
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
            const failed = await disconnectCalendar({ removeEvents: remove.checked });
            clearEvents(app.db);
            close({ failed });
          } catch (problem) {
            error.textContent = problem.message;
            confirm.disabled = false;
          }
        },
      }, 'Turn off');
      return h('div', null,
        h('p', { class: 'dialog-text' }, 'Tasks and your timetable stop going to your calendar, and its events leave the Today page and the timetable. Your tasks and timetable stay as they are.'),
        count > 0 && h('label', { class: 'check-field' }, remove, `Also remove the ${plural(count, 'event')} this app added to your calendar`),
        error,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
          confirm));
    },
  });
}

export function calendarSection() {
  const { db } = app;
  const el = h('div');

  function render() {
    const hadFocus = el.contains(document.activeElement);
    const config = calendarConfig(db);
    const { state, message } = calendarStatus();
    const problem = h('p', { class: 'field-error', role: 'alert' }, message);

    if (!config.on) {
      const input = h('input', {
        class: 'input', type: 'text', value: config.clientId, autocomplete: 'off', spellcheck: 'false', placeholder: '123456-abc.apps.googleusercontent.com',
      });
      fill(el,
        h('p', { class: 'settings-text' }, 'Off. If you turn this on, tasks with a date and a time and your timetable go to your main Google calendar, and its events appear on your Today page and your timetable.'),
        h('p', { class: 'settings-text' }, 'Google gets the text, date and time of those tasks, and the name, time, place and reminder of your timetable blocks, and nothing else. Tasks in private notes are never sent. It needs a free Google project of your own.'),
        setupSteps(),
        h('form', {
          class: 'calendar-form',
          onSubmit: async (event) => {
            event.preventDefault();
            const clientId = input.value.trim();
            problem.textContent = '';
            if (!isClientId(clientId)) {
              problem.textContent = 'That doesn’t look like a Client ID. It ends in .apps.googleusercontent.com.';
              return;
            }
            updateCalendarConfig(db, { clientId });
            await connectCalendar(clientId);
          },
        },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Client ID'), input),
        h('button', { class: 'btn btn-primary', type: 'submit' }, icon('calendar', 16), 'Connect')),
        problem);
      // Loaded on the way to the click, once there's an ID, so the sign-in window isn't blocked.
      input.addEventListener('input', () => {
        if (isClientId(input.value.trim())) loadGoogleLibrary().catch(() => {});
      });
      if (isClientId(config.clientId)) loadGoogleLibrary().catch(() => {});
      return;
    }

    const option = (checked, label, hint, onChange) => {
      const box = h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) });
      return h('div', { class: 'calendar-option' }, h('label', { class: 'check-field' }, box, label), h('p', { class: 'field-hint' }, hint));
    };
    fill(el,
      h('p', { class: 'settings-text' }, 'On. Tasks with a date and a time go to your main Google calendar, and today’s events appear on your Today page. Tasks in private notes are never sent. Changing something in Google Calendar doesn’t change your tasks or your timetable: change them here.'),
      option(config.blocks, 'Send my timetable to Google Calendar',
        `Each class or block becomes an event, from this week to ${WEEKS_AHEAD} weeks ahead, and more are added as the weeks go by. Changes and cancellations follow. Turning this off removes them from the calendar again.`,
        (on) => setSendBlocks(on)),
      option(config.showEvents, 'Show Google Calendar events on the timetable',
        'Your own events appear on the timetable, outlined, so you can see everything in one place. Clicking one opens it in Google Calendar.',
        (on) => setShowEvents(on)),
      h('p', { class: 'settings-text' }, state === 'signed-out' ? 'Sign in again to keep syncing.' : lastSyncText(config.lastSync)),
      problem,
      h('div', { class: 'settings-actions' },
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: state === 'syncing',
          onClick: () => connectCalendar(config.clientId),
        }, icon('repeat', 16), state === 'signed-out' ? 'Sign in and sync' : 'Sync now'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            const result = await disconnectDialog();
            if (result) toast(result.failed ? `Turned off. ${plural(result.failed, 'event')} couldn’t be removed.` : 'Google Calendar is off');
          },
        }, 'Turn off')));
    if (hadFocus) el.querySelector('button:not(:disabled)')?.focus();
  }

  render();
  const stop = onCalendarStatus(render);
  const offChange = db.on((change) => {
    if (change.stores.has('meta') && !el.contains(document.activeElement)) render();
  });
  return { el, destroy: () => { stop(); offChange(); } };
}

/** The line on the Today page. Empty unless Google Calendar is on. */
export function calendarStatusLine() {
  const { db } = app;
  const el = h('div', { class: 'today-calendar' });

  function render() {
    const hadFocus = el.contains(document.activeElement);
    const config = calendarConfig(db);
    if (!config.on) {
      fill(el);
      return;
    }
    const { state, message } = calendarStatus();
    const text = {
      'signed-out': message || 'Google Calendar needs you to sign in again.',
      syncing: 'Syncing with Google Calendar…',
      error: message || 'Google Calendar had a problem.',
      idle: `Google Calendar is on. ${lastSyncText(config.lastSync)}`,
    }[state];
    fill(el,
      icon('calendar', 14),
      h('span', { role: 'status' }, text),
      state !== 'syncing' && h('button', {
        class: 'btn-link',
        type: 'button',
        onClick: () => connectCalendar(config.clientId),
      }, state === 'signed-out' ? 'Sign in' : 'Sync now'));
    if (hadFocus) el.querySelector('button')?.focus();
  }

  render();
  const stop = onCalendarStatus(render);
  const offChange = db.on((change) => {
    if (change.stores.has('meta')) render();
  });
  // Coming back to Today after setting it up, or once signed in, shows fresh events.
  syncCalendar();
  return { el, destroy: () => { stop(); offChange(); } };
}
