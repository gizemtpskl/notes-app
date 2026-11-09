/**
 * shortcuts.js: global keyboard shortcuts, and the "?" cheat sheet.
 *
 * Browsers reserve Ctrl/Cmd+N for opening a new window in normal tabs, and pages can't always
 * override it. It is registered anyway, because some browsers and installed apps allow it,
 * and the single key N always works.
 */
import { app } from '../context.js';
import { altName, h, isTyping, modKey, modName } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';

const SHEET = [
  ['Capture and create', [
    [['N'], 'Quick capture to Inbox'],
    [[modName, 'N'], 'Quick capture, where the browser allows it'],
    [[altName, 'N'], 'Quick capture while typing elsewhere'],
    [['Shift', 'N'], 'New note in the current space or collection'],
    [[modName, 'K'], 'Search and commands'],
    [['/'], 'Also opens search, when not typing'],
  ]],
  ['Go to', [
    [['G', 'H'], 'Dashboard'],
    [['G', 'O'], 'Today'],
    [['G', 'C'], 'Timetable'],
    [['G', 'I'], 'Inbox'],
    [['G', 'R'], 'Inbox review'],
    [['G', 'F'], 'Favorites'],
    [['G', 'A'], 'Archive'],
    [['G', 'T'], 'Trash'],
    [['G', 'S'], 'Settings'],
    [['G', 'Y'], 'Note types'],
    [['G', 'L'], 'Tags'],
    [['G', 'V'], 'Saved views'],
    [['G', 'W'], 'Weekly review'],
    [['G', 'P'], 'Templates'],
    [['['], 'Show or hide the sidebar'],
    [['?'], 'This list'],
  ]],
  ['Writing', [
    [[modName, 'B'], 'Bold'],
    [[modName, 'I'], 'Italic'],
    [[modName, 'E'], 'Inline code'],
    [[altName, 'K'], 'Add or edit a link'],
    [['/'], 'Insert a block (in an empty line or after a space)'],
    [['[[',], 'Link to another note'],
    [['$x^2$'], 'A math formula, in LaTeX'],
    [['$$', 'Enter'], 'A math block'],
    [[modName, 'Enter'], 'Tick a checklist item, or leave a code block'],
    [['Enter', 'Enter', 'Enter'], 'Also leaves a code block'],
    [['Tab'], 'Indent a list, or go to the next table cell'],
    [['Esc', 'Tab'], 'Move focus out of the editor'],
    [[altName, 'F'], 'Writing focus mode'],
  ]],
  ['Task lists', [
    [['Enter'], 'Add a task below'],
    [['↑', '↓'], 'Move between tasks'],
    [[altName, '↑', '↓'], 'Reorder a task'],
    [[altName, '→'], 'Make it a subtask'],
    [[altName, '←'], 'Move a subtask back out'],
    [['Backspace'], 'Remove an empty task'],
  ]],
  ['Kanban', [
    [[altName, '←', '→'], 'Move the focused card to another column'],
  ]],
  ['Selecting several notes', [
    [['Shift', 'Click'], 'Select a range'],
    [['Esc'], 'Stop selecting'],
  ]],
  ['Markdown while typing', [
    [['#', 'Space'], 'Heading (also ## and ###)'],
    [['-', 'Space'], 'Bulleted list'],
    [['1.', 'Space'], 'Numbered list'],
    [['[]', 'Space'], 'Checklist'],
    [['>', 'Space'], 'Quote'],
    [['```', 'Enter'], 'Code block (or ```python, for a language)'],
    [['---', 'Enter'], 'Divider'],
    [['**bold**'], 'Also *italic*, ~~strike~~ and `code`'],
  ]],
  ['Quiz', [
    [['Space'], 'Show the answer'],
    [['1'], 'Missed it'],
    [['2'], 'Got it'],
  ]],
  ['Inbox review', [
    [['1', '–', '9'], 'Choose a destination'],
    [['S'], 'Skip'],
    [['E'], 'Edit'],
    [['A'], 'Archive'],
    [['D'], 'Delete'],
  ]],
];

export function showShortcuts() {
  if (document.querySelector('dialog.dialog-shortcuts')) return;
  openDialog({
    title: 'Keyboard shortcuts',
    className: 'dialog-shortcuts',
    build: () => h('div', { class: 'shortcut-groups' },
      SHEET.map(([title, rows]) => h('section', { class: 'shortcut-group' },
        h('h3', { class: 'shortcut-title' }, title),
        h('dl', null, rows.map(([keys, label]) => h('div', { class: 'shortcut-row' },
          h('dt', null, keys.map((key) => (key === '–' ? ' – ' : h('kbd', null, key)))),
          h('dd', null, label))))))),
  });
}

const GO_ROUTES = {
  h: 'home', o: 'today', c: 'timetable', i: 'inbox', r: 'inbox/review', f: 'favorites', a: 'archive', t: 'trash', s: 'settings', y: 'types', l: 'tags', v: 'views', w: 'review', p: 'templates',
};

let goPending = false;

/** True right after G is pressed, so views with their own single-key shortcuts can stay out of the way. */
export function isGoPending() {
  return goPending;
}

export function installShortcuts({ getNewNoteTarget, newNote, toggleSidebar }) {
  let goTimer = null;

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const key = event.key.toLowerCase();

    // These two work even while typing.
    if ((modKey(event) && !event.shiftKey && !event.altKey && key === 'n')
      || (event.altKey && !modKey(event) && event.code === 'KeyN')) {
      event.preventDefault();
      app.openCapture();
      return;
    }
    if (event.altKey && !modKey(event) && event.code === 'KeyF') {
      event.preventDefault();
      app.toggleFocus();
      return;
    }
    if (modKey(event) && !event.shiftKey && !event.altKey && key === 'k') {
      event.preventDefault();
      app.openPalette();
      return;
    }
    if (event.key === 'Escape' && document.body.classList.contains('focus-mode') && !document.querySelector('dialog[open]')) {
      app.toggleFocus(false);
      return;
    }

    if (isTyping(event.target) || modKey(event) || event.altKey || document.querySelector('dialog[open]')) return;

    if (goPending) {
      goPending = false;
      clearTimeout(goTimer);
      if (GO_ROUTES[key]) {
        event.preventDefault();
        app.navigate(GO_ROUTES[key]);
      }
      return;
    }

    if (key === 'g') {
      goPending = true;
      goTimer = setTimeout(() => {
        goPending = false;
      }, 1200);
    } else if (event.key === 'n') {
      event.preventDefault();
      app.openCapture();
    } else if (event.key === 'N') {
      event.preventDefault();
      newNote(getNewNoteTarget());
    } else if (event.key === '?') {
      event.preventDefault();
      showShortcuts();
    } else if (event.key === '[') {
      event.preventDefault();
      toggleSidebar();
    } else if (event.key === '/') {
      event.preventDefault();
      app.openPalette();
    }
  });
}
