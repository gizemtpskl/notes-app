/**
 * palette.js: the command palette, on Ctrl/Cmd+K. One box for finding notes, going anywhere and
 * doing common things without leaving the keyboard.
 */
import { app } from '../context.js';
import { markdownExport } from '../data/porting.js';
import { findRanges, queryTerms, rememberSearch, searchNotes } from '../data/search.js';
import { fold, snippet } from '../data/text.js';
import { displayTitle } from '../data/types.js';
import { downloadBlob, fill, h } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { focusTargetForNote, startFocusDialog } from './focus.js';
import { archiveNotes, locationName, moveNotes, newNote, showError, trashNotes } from './actions.js';
import { pickDestination, pickNote } from './dialogs.js';
import { newFromTemplate } from './templatesPage.js';
import { applyTheme } from './theme.js';
import { exportBackup } from './transfer.js';

const NOTE_LIMIT = 20;
const COMMAND_LIMIT = 6;

/** Text with the matched words marked, as elements. Never as markup, so titles can't inject anything. */
export function highlighted(text, ranges) {
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(h('mark', null, text.slice(start, end)));
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Where a new note of a type belongs: the first collection made for that type, or the Inbox. */
export function homeForType(typeId) {
  const col = app.db.allCollections().find((c) => c.defaultTypeId === typeId);
  return col ? { collectionId: col.id, typeId } : { typeId };
}

async function moveNoteFlow(noteId) {
  const id = noteId ?? await pickNote({ title: 'Which note do you want to move?' });
  if (!id) return;
  const target = await pickDestination({ title: 'Move note to' });
  if (target) moveNotes([id], target);
}

/** Every command available right now. */
function allCommands() {
  const { db } = app;
  const commands = [];
  const add = (label, iconName, run, keys = '') => commands.push({
    label, icon: iconName, run, key: fold(`${label} ${keys}`),
  });

  add('Quick capture to Inbox', 'plus', () => app.openCapture(), 'new note');
  for (const type of db.listTypes()) {
    const label = type.id === 'journal' ? 'New journal entry' : `New ${type.name.toLowerCase()}`;
    add(label, 'plus', () => newNote(homeForType(type.id)), 'create add');
  }

  const noteId = app.currentNoteId?.();
  const current = noteId ? db.getNote(noteId) : null;
  if (current && !current.trashedAt) {
    add('Move this note…', 'move', () => moveNoteFlow(noteId));
    add(current.pinned ? 'Unpin this note' : 'Pin this note', 'pin', () => db.setPinned(noteId, !current.pinned));
    add(current.favorite ? 'Remove this note from favorites' : 'Add this note to favorites', 'star', () => db.setFavorite(noteId, !current.favorite));
    add('Archive this note', 'archive', () => archiveNotes([noteId]));
    add('Delete this note', 'trash', () => trashNotes([noteId]));
    add('Export this note as Markdown', 'download', async () => {
      try {
        const { blob, filename } = await markdownExport(db, { kind: 'note', id: noteId });
        downloadBlob(blob, filename);
      } catch (error) {
        showError(error);
      }
    });
    add('Writing focus mode', 'focus', () => app.toggleFocus());
    add('Start a focus session on this note', 'clock', () => startFocusDialog(focusTargetForNote(current, displayTitle(current, db.getType(current.typeId)) || 'Untitled')), 'timer pomodoro');
  } else {
    add('Move note…', 'move', () => moveNoteFlow());
  }

  const pages = [
    ['Dashboard', 'home', 'home'], ['Today', 'today', 'calendar'], ['Inbox', 'inbox', 'inbox'], ['Inbox review', 'inbox/review', 'sparkle'],
    ['Search page', 'search', 'search'], ['Tags', 'tags', 'tag'], ['Saved views', 'views', 'bookmark'], ['Favorites', 'favorites', 'star'],
    ['Archive', 'archive', 'archive'], ['Trash', 'trash', 'trash'], ['Settings', 'settings', 'settings'], ['Note types', 'types', 'edit'],
    ['Templates', 'templates', 'template'], ['Weekly review', 'review', 'check'], ['Tidy up', 'tidy', 'broom'], ['Statistics', 'stats', 'chart'],
  ];
  for (const [label, route, iconName] of pages) add(`Go to ${label}`, iconName, () => app.navigate(route));
  for (const space of db.listSpaces()) {
    add(`Go to ${space.name}`, 'folder', () => app.navigate(`space/${space.id}`), 'space');
  }
  for (const col of db.allCollections()) {
    add(`Go to ${col.name}`, 'folder', () => app.navigate(`collection/${col.id}`), db.getSpace(col.spaceId)?.name ?? '');
  }
  for (const view of db.listSavedViews()) add(`Go to ${view.name}`, 'bookmark', () => app.navigate(`view/${view.id}`), 'saved view');
  for (const tag of db.listTags()) add(`Go to #${tag.name}`, 'tag', () => app.navigate(`tag/${tag.id}`));

  add('Start a focus session', 'clock', () => startFocusDialog(), 'timer pomodoro');
  if (db.storage.encrypted) add('Lock now', 'lock', () => app.lockNow());
  add('Download backup', 'download', () => exportBackup(), 'export json');
  add('Keyboard shortcuts', 'keyboard', () => app.showShortcuts(), 'help');
  add('Switch to dark theme', 'settings', () => {
    db.updateSettings({ theme: 'dark' });
    applyTheme('dark');
  }, 'appearance');
  add('Switch to light theme', 'settings', () => {
    db.updateSettings({ theme: 'light' });
    applyTheme('light');
  }, 'appearance');
  for (const template of db.listTemplates()) add(`New from template: ${template.name}`, 'template', () => newFromTemplate(template.id), 'create add');
  return commands;
}

const QUICK_ACTIONS = ['New journal entry', 'New checklist', 'Quick capture to Inbox', 'Move', 'Go to Today', 'Go to Inbox review', 'Go to Weekly review'];

function emptyQueryCommands(commands) {
  return QUICK_ACTIONS.map((name) => commands.find((c) => c.label.startsWith(name))).filter(Boolean);
}

export function openPalette() {
  if (document.querySelector('dialog.dialog-palette')) return Promise.resolve();
  const { db } = app;
  const commands = allCommands();
  let includePrivate = false;

  return openDialog({
    ariaLabel: 'Search and commands',
    className: 'dialog-palette',
    build: (close) => {
      let rows = [];
      let active = 0;
      const list = h('div', { class: 'palette-list', role: 'listbox', id: 'palette-list', 'aria-label': 'Results' });

      const finish = (row) => {
        const query = input.value.trim();
        if (row.remember && query) db.setMeta('recentSearches', rememberSearch(db.getMeta('recentSearches', []), query));
        close();
        // Runs after the dialog returns focus, so anything it opens stays in front.
        setTimeout(row.run, 0);
      };

      function render() {
        let group = null;
        const items = [];
        rows.forEach((row, index) => {
          if (row.group !== group) {
            group = row.group;
            items.push(h('div', { class: 'palette-group', role: 'presentation' }, group));
          }
          items.push(h('button', {
            class: `palette-item${index === active ? ' is-active' : ''}`,
            id: `palette-${index}`,
            type: 'button',
            role: 'option',
            tabindex: '-1',
            'aria-selected': String(index === active),
            onClick: () => finish(row),
            onMousemove: () => {
              if (active !== index) {
                active = index;
                paintActive();
              }
            },
          }, row.content));
        });
        if (!rows.length) items.push(h('p', { class: 'palette-empty' }, input.value.trim() ? 'No results. Try fewer words.' : 'Type to search your notes.'));
        fill(list, items);
        paintActive();
      }

      function paintActive() {
        for (const el of list.querySelectorAll('.palette-item')) {
          const on = el.id === `palette-${active}`;
          el.classList.toggle('is-active', on);
          el.setAttribute('aria-selected', String(on));
          if (on) el.scrollIntoView({ block: 'nearest' });
        }
        if (rows.length) input.setAttribute('aria-activedescendant', `palette-${active}`);
        else input.removeAttribute('aria-activedescendant');
      }

      const commandRow = (command, group) => ({
        group,
        run: command.run,
        content: [h('span', { class: 'palette-icon' }, icon(command.icon ?? 'chevronRight', 16)), h('span', { class: 'palette-label' }, command.label)],
      });

      function noteRow(result, terms) {
        const { note } = result;
        const type = db.getType(note.typeId);
        const title = snippet(displayTitle(note, type) || 'Untitled', 90);
        return {
          group: 'Notes',
          remember: true,
          run: () => app.navigate(`note/${note.id}`),
          content: [
            h('span', { class: 'palette-icon', 'aria-hidden': 'true' }, type.icon),
            h('span', { class: 'palette-main' },
              h('span', { class: 'palette-label' }, highlighted(title, findRanges(title, terms))),
              result.snippet.ranges.length > 0 && h('span', { class: 'palette-snippet' }, highlighted(result.snippet.text, result.snippet.ranges))),
            h('span', { class: 'palette-where' }, locationName(note)),
          ],
        };
      }

      function update() {
        const query = input.value.trim();
        active = 0;
        if (!query) {
          const recent = db.getMeta('recentSearches', []);
          rows = [
            ...recent.slice(0, 5).map((text) => ({
              group: 'Recent searches',
              run: () => app.navigate(`search?q=${encodeURIComponent(text)}`),
              content: [h('span', { class: 'palette-icon' }, icon('search', 16)), h('span', { class: 'palette-label' }, text)],
            })),
            ...emptyQueryCommands(commands).map((c) => commandRow(c, 'Quick actions')),
          ];
          render();
          return;
        }
        const onlyCommands = query.startsWith('>');
        const words = fold(query.replace(/^>/, '')).split(/\s+/).filter(Boolean);
        const matched = commands
          .filter((c) => words.every((w) => c.key.includes(w)))
          .sort((a, b) => Number(b.key.startsWith(words[0] ?? '')) - Number(a.key.startsWith(words[0] ?? '')))
          .slice(0, onlyCommands ? 30 : COMMAND_LIMIT);
        const results = onlyCommands ? [] : searchNotes(db, query, { includePrivate, limit: NOTE_LIMIT });
        const terms = queryTerms(query);
        rows = [
          // Notes usually matter most. Commands go first only when no notes match.
          ...results.map((result) => noteRow(result, terms)),
          ...matched.map((c) => commandRow(c, 'Commands')),
          ...(onlyCommands ? [] : [{
            group: 'Search',
            remember: true,
            run: () => app.navigate(`search?q=${encodeURIComponent(query)}${includePrivate ? '&private=1' : ''}`),
            content: [h('span', { class: 'palette-icon' }, icon('search', 16)), h('span', { class: 'palette-label' }, `See all results and filters for "${snippet(query, 40)}"`)],
          }]),
        ];
        render();
      }

      const input = h('input', {
        class: 'palette-input',
        type: 'text',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'palette-list',
        'aria-label': 'Search notes or type a command',
        placeholder: 'Search notes, or type a command…',
        autocomplete: 'off',
        spellcheck: 'false',
        autofocus: true,
        onInput: update,
        onKeydown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (rows.length) {
              active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
              paintActive();
            }
          } else if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            if (rows[active]) finish(rows[active]);
          }
        },
      });

      update();
      return h('div', { class: 'palette' },
        h('div', { class: 'palette-head' }, icon('search', 18), input),
        list,
        h('div', { class: 'palette-foot' },
          h('label', { class: 'palette-private' },
            h('input', {
              type: 'checkbox',
              onChange: (event) => {
                includePrivate = event.target.checked;
                update();
                input.focus();
              },
            }),
            'Include journal and private notes'),
          h('span', { class: 'palette-hint' }, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to choose, ', h('kbd', null, 'Enter'), ' to open, ', h('kbd', null, '>'), ' for commands only')));
    },
  });
}
