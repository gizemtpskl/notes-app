/**
 * note.js: the note page: breadcrumbs, title, the type's fields, editor and autosave.
 *
 * Saving: edits schedule a save after a short pause. Pending edits are also saved when the
 * editor loses focus, when leaving the page, and when the tab is hidden or closed.
 */
import { app } from '../context.js';
import { formatDay } from '../data/dates.js';
import { markdownExport } from '../data/porting.js';
import { fold, snippet } from '../data/text.js';
import { autoTitleFor, displayTitle, isBlankNote, noteWords } from '../data/types.js';
import { createEditor } from '../editor/editor.js';
import { downloadBlob, fill, fullDate, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { focusTargetForNote, startFocusDialog } from './focus.js';
import { openMenu } from '../ui/menu.js';
import { promptDialog } from '../ui/dialog.js';
import { archiveNotes, locationName, moveNotes, purgeNotes, restoreNotes, showError, trashNotes, unarchiveNotes, withUndo } from './actions.js';
import { pickDestination } from './dialogs.js';
import { fieldForm } from './fieldWidgets.js';
import { breadcrumbs, notFound } from './folder.js';
import { saveImageFile } from './images.js';
import { openHistory } from './historyDialog.js';
import { mathDialog } from './mathDialog.js';
import { noteLinksPanel } from './noteLinks.js';
import { tagEditor } from './tags.js';
import { saveAsTemplateFlow } from './templatesPage.js';

const SAVE_DELAY_MS = 400;
const SLOW_SAVE_DELAY_MS = 1500;
/** Serializing a huge note takes noticeable time, so save it less often. */
const LONG_NOTE_CHARS = 200000;
/** During long sessions a version is kept this often, plus one on leaving. */
const VERSION_INTERVAL_MS = 5 * 60 * 1000;

export function noteView({ id, isNew }) {
  const { db } = app;
  const initial = db.getNote(id);
  if (!initial) return notFound('This note no longer exists.');

  const type = db.getType(initial.typeId);
  const readOnly = Boolean(initial.trashedAt);
  let savedTitle = initial.title;
  let savedBody = initial.body;
  let savedFields = initial.fields;
  let fieldsDirty = false;
  let timer = null;
  let dirty = false;
  let lastVersionAt = 0;
  let changedSinceVersion = false;

  const status = h('span', { class: 'note-status', role: 'status' });
  const words = h('span', { class: 'note-words' });

  function updateWordCount() {
    const note = db.getNote(id);
    if (note) words.textContent = plural(noteWords(note, type), 'word');
  }

  /** Keeps the note as it was before this session's first edit, then every few minutes. */
  function keepVersion(previous, updated) {
    const now = Date.now();
    if (!lastVersionAt) {
      lastVersionAt = now;
      // A brand new note has nothing worth going back to yet.
      if (!isBlankNote(previous, type)) db.snapshotNote(id, previous);
      changedSinceVersion = true;
    } else if (now - lastVersionAt >= VERSION_INTERVAL_MS) {
      lastVersionAt = now;
      db.snapshotNote(id, updated);
      changedSinceVersion = false;
    } else {
      changedSinceVersion = true;
    }
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    const note = db.getNote(id);
    if (!dirty || !note) return;
    dirty = false;
    const title = titleInput.value.trim();
    const body = editor.getHtml();
    const patch = {};
    if (title !== savedTitle) patch.title = title;
    if (body !== savedBody) patch.body = body;
    if (fieldsDirty) {
      patch.fields = { ...note.fields, ...form.values() };
      fieldsDirty = false;
    }
    if (Object.keys(patch).length) {
      const updated = db.updateNote(id, patch);
      keepVersion(note, updated);
      savedTitle = updated.title;
      savedBody = updated.body;
      savedFields = updated.fields;
      updateWordCount();
      document.title = `${displayTitle(updated, type) || 'Untitled'} · Notes`;
    }
    status.textContent = 'Saving…';
    db.flush().then(() => {
      if (!dirty) status.textContent = 'Saved';
    });
  }

  function scheduleSave() {
    dirty = true;
    status.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(save, savedBody.length > LONG_NOTE_CHARS ? SLOW_SAVE_DELAY_MS : SAVE_DELAY_MS);
  }

  // -- Title -----------------------------------------------------------------------------

  /** Where the caret goes after the title: a type's main task list, or the text. */
  function focusAfterTitle() {
    if (!form?.focusPrimary()) editor.focus('start');
  }

  const titleInput = h('textarea', {
    class: 'note-title-input',
    rows: 1,
    value: initial.title,
    placeholder: displayTitle(initial, type) || 'Untitled',
    'aria-label': 'Title',
    readOnly,
    onInput: () => {
      growTitle();
      scheduleSave();
    },
    onKeydown: (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        focusAfterTitle();
      } else if (event.key === 'ArrowDown' && titleInput.selectionStart === titleInput.value.length) {
        event.preventDefault();
        focusAfterTitle();
      }
    },
    onBlur: save,
  });

  function growTitle() {
    titleInput.style.height = 'auto';
    titleInput.style.height = `${titleInput.scrollHeight}px`;
  }

  // -- Fields ----------------------------------------------------------------------------

  /** A title made from the date follows the date, unless the title was changed by hand. */
  function followDate(fieldId, previousValues) {
    if (type.autoTitle !== 'date' || fieldId !== 'date') return;
    if (titleInput.value.trim() === autoTitleFor(type, previousValues)) {
      titleInput.value = autoTitleFor(type, form.values());
      growTitle();
    }
  }

  let formValues = {};
  const form = type.fields.length ? fieldForm({
    note: initial,
    type,
    db,
    readOnly,
    onChange: (fieldId) => {
      followDate(fieldId, formValues);
      formValues = form.values();
      fieldsDirty = true;
      scheduleSave();
    },
  }) : null;
  if (form) {
    formValues = form.values();
    form.el.addEventListener('focusout', (event) => {
      if (!form.el.contains(event.relatedTarget)) save();
    });
  }

  // -- Editor ----------------------------------------------------------------------------

  /** Notes for the [[ menu: the best title matches, skipping this note and the Trash. */
  function searchNotes(query) {
    const q = fold(query);
    const scored = [];
    for (const other of db.data.notes.values()) {
      if (other.id !== id && !other.trashedAt) {
        const name = displayTitle(other, db.getType(other.typeId));
        const key = fold(name);
        const at = q ? key.indexOf(q) : 0;
        if (name && at !== -1) scored.push({ other, name, at });
      }
    }
    scored.sort((a, b) => a.at - b.at || b.other.updated - a.other.updated);
    return scored.slice(0, 8).map(({ other, name }) => ({ id: other.id, title: snippet(name, 80), detail: locationName(other) }));
  }

  const editor = createEditor({
    html: initial.body,
    readOnly,
    onChange: scheduleSave,
    saveImage: saveImageFile,
    loadImage: async (assetId) => (await db.getAsset(assetId))?.dataUrl ?? null,
    askMath: (options) => mathDialog(options),
    searchNotes,
    createLinkedNote: (name) => {
      const created = db.createNote({ title: name });
      return { id: created.id, title: created.title };
    },
    askLink: (value, options = {}) => (options.describeImage
      ? promptDialog({
        title: 'Describe this image', label: 'Text for screen readers and exports', value,
      })
      : promptDialog({
        title: value ? 'Edit link' : 'Add link', label: 'Web address', value, placeholder: 'https://', confirmLabel: 'Apply',
      })),
  });
  editor.el.addEventListener('focusout', save);

  // -- Header ----------------------------------------------------------------------------

  const crumbs = h('div', { class: 'note-crumbs' });
  const actions = h('div', { class: 'note-actions', role: 'group', 'aria-label': 'Note actions' });
  const banner = h('div');
  const created = h('p', { class: 'note-dates' });
  const metaRow = h('div', { class: 'note-meta-row' });
  const tags = tagEditor({ noteId: id, readOnly });
  const links = noteLinksPanel(id);
  // The title is a text box, so screen reader users get a real heading too.
  const heading = h('h1', { class: 'sr-only' }, displayTitle(initial, type) || 'Untitled');

  function crumbItems(note) {
    const name = displayTitle(note, type) || 'Untitled';
    const space = db.getSpace(note.spaceId);
    if (!space) return [{ label: '📥 Inbox', href: '#/inbox' }, sessionCrumb(note.id), { label: name }].filter(Boolean);
    const col = db.getCollection(note.collectionId);
    const parent = col ? db.getCollection(col.parentId) : null;
    return [
      { label: `${space.icon} ${space.name}`, href: `#/space/${space.id}` },
      parent && { label: parent.name, href: `#/collection/${parent.id}` },
      col && { label: col.name, href: `#/collection/${col.id}` },
      sessionCrumb(note.id),
      { label: name },
    ].filter(Boolean);
  }

  /** A note written for one session of a timetable block links back to that session. */
  function sessionCrumb(noteId) {
    for (const block of db.listBlocks()) {
      const original = Object.entries(block.sessions ?? {}).find(([, id]) => id === noteId)?.[0];
      if (original) {
        const change = block.exceptions?.[original];
        const date = change?.date ?? original;
        const start = change?.start ?? block.start;
        return { label: `🗓 ${block.title} · ${formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${start}`, href: `#/timetable?date=${date}&view=day` };
      }
    }
    return null;
  }

  const toggleButton = (iconName, label, on, onClick) => h('button', {
    class: `icon-btn${on ? ' is-on' : ''}`,
    type: 'button',
    'aria-label': label,
    'aria-pressed': String(on),
    title: label,
    dataset: { focusKey: label },
    onClick,
  }, icon(iconName));

  async function exportMarkdown() {
    save();
    try {
      const { blob, filename } = await markdownExport(db, { kind: 'note', id });
      downloadBlob(blob, filename);
    } catch (error) {
      showError(error);
    }
  }

  function changeType(typeId) {
    save();
    const next = db.getType(typeId);
    withUndo(`Changed to ${next.name}`, () => db.setNoteType(id, typeId));
  }

  function renderMeta(note) {
    fill(metaRow,
      h('button', {
        class: 'chip chip-button',
        type: 'button',
        disabled: readOnly,
        'aria-haspopup': 'menu',
        'aria-label': `Note type: ${type.name}. Change type`,
        dataset: { focusKey: 'type' },
        onClick: (event) => openMenu(event.currentTarget, db.listTypes().map((t) => ({
          label: `${t.icon}  ${t.name}`, checked: t.id === type.id, onSelect: () => changeType(t.id),
        })), { label: 'Change note type' }),
      }, h('span', { 'aria-hidden': 'true' }, type.icon), type.name, icon('chevronDown', 12)),
      note.private && h('span', { class: 'chip', title: 'Kept off the Home screen' }, icon('lock', 12), 'Private'));
  }

  function renderChrome() {
    const note = db.getNote(id);
    if (!note) return;
    const hadFocus = actions.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    crumbs.replaceChildren(breadcrumbs(crumbItems(note)));
    page.dataset.color = db.getSpace(note.spaceId)?.color ?? 'slate';
    created.textContent = `Created ${fullDate(note.created)}`;
    heading.textContent = displayTitle(note, type) || 'Untitled';
    renderMeta(note);

    if (note.trashedAt) {
      banner.replaceChildren(h('div', { class: 'note-banner' },
        h('span', null, 'This note is in the Trash and is read-only.'),
        h('button', { class: 'btn', type: 'button', onClick: () => restoreNotes([id]) }, 'Restore'),
        h('button', { class: 'btn btn-danger', type: 'button', onClick: async () => { if (await purgeNotes([id])) app.navigate('trash'); } }, 'Delete forever')));
    } else if (note.archived) {
      banner.replaceChildren(h('div', { class: 'note-banner' },
        h('span', null, 'This note is archived.'),
        h('button', { class: 'btn', type: 'button', onClick: () => unarchiveNotes([id]) }, 'Unarchive')));
    } else {
      banner.replaceChildren();
    }

    fill(actions,
      !note.trashedAt && !note.archived && toggleButton('pin', note.pinned ? 'Unpin' : 'Pin', note.pinned, () => db.setPinned(id, !note.pinned)),
      !note.trashedAt && toggleButton('star', note.favorite ? 'Remove from favorites' : 'Add to favorites', note.favorite, () => db.setFavorite(id, !note.favorite)),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Writing focus mode',
        title: 'Writing focus mode',
        dataset: { focusKey: 'focus' },
        onClick: () => app.toggleFocus(),
      }, icon('focus')),
      !note.trashedAt && h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Move note',
        title: 'Move note',
        dataset: { focusKey: 'move' },
        onClick: async () => {
          const target = await pickDestination({ title: 'Move note to' });
          if (target) {
            save();
            moveNotes([id], target);
          }
        },
      }, icon('move')),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        dataset: { focusKey: 'more' },
        onClick: (event) => openMenu(event.currentTarget, [
          !note.trashedAt && { label: 'Start a focus session', icon: 'clock', onSelect: () => startFocusDialog(focusTargetForNote(note, displayTitle(note, type) || 'Untitled')) },
          { label: 'Version history', icon: 'history', onSelect: () => { save(); openHistory(id); } },
          !note.trashedAt && { label: 'Save as template', icon: 'template', onSelect: () => { save(); saveAsTemplateFlow(id); } },
          { label: 'Export as Markdown', icon: 'download', onSelect: exportMarkdown },
          !note.trashedAt && {
            label: note.private ? 'Show on Home' : 'Make private',
            icon: 'lock',
            onSelect: () => db.updateNote(id, { private: !note.private }),
          },
          !note.trashedAt && !note.archived && 'separator',
          !note.trashedAt && !note.archived && {
            label: 'Archive',
            icon: 'archive',
            onSelect: () => {
              save();
              archiveNotes([id]);
            },
          },
          !note.trashedAt && 'separator',
          !note.trashedAt && {
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: () => {
              save();
              leaveAfterDelete();
              trashNotes([id]);
            },
          },
        ], { label: 'Note actions' }),
      }, icon('more')),
    );
    if (hadFocus) actions.querySelector(`[data-focus-key="${CSS.escape(hadFocus)}"]`)?.focus();
  }

  function leaveAfterDelete() {
    const note = db.getNote(id);
    if (note?.collectionId) app.navigate(`collection/${note.collectionId}`);
    else if (note?.spaceId) app.navigate(`space/${note.spaceId}`);
    else app.navigate('inbox');
  }

  // -- Page ------------------------------------------------------------------------------

  const page = h('article', { class: `page page-note${type.fields.length ? ' has-fields' : ''}` },
    heading,
    h('div', { class: 'note-topbar' }, crumbs, actions),
    banner,
    titleInput,
    h('div', { class: 'note-meta-wrap' }, metaRow, tags.el),
    form?.el,
    form && type.bodyLabel && h('h2', { class: 'note-body-label' }, type.bodyLabel),
    editor.toolbar,
    editor.el,
    links.el,
    h('footer', { class: 'note-foot' }, words, status, created));

  const onHide = () => {
    if (document.visibilityState === 'hidden') {
      save();
      db.flush();
    }
  };
  const onPageHide = () => {
    save();
    db.flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  renderChrome();
  updateWordCount();

  // Opening a note is recorded so the tidy-up tools can find old, unopened notes.
  db.updateNote(id, { opened: Date.now() });

  return {
    title: displayTitle(initial, type) || 'Untitled',
    el: page,
    mounted() {
      growTitle();
      if (isNew) {
        if (type.focusOnNew === 'body') editor.focus('start');
        else titleInput.focus();
      }
    },
    /** Focus stays put when a new note opens, so typing can begin straight away. */
    keepsFocus: Boolean(isNew),
    update(change) {
      links.refresh();
      if (!change.ids.has(id) && !change.structural) return;
      const note = db.getNote(id);
      if (!note) {
        if (change.source === 'remote') app.navigate('home');
        return;
      }
      // The form and read-only state are built for one type, so these need a fresh page.
      if (note.typeId !== type.id || Boolean(note.trashedAt) !== readOnly) {
        app.reloadRoute?.();
        return;
      }
      // Changed outside this page, by another tab or an undo. Never overwrite active typing.
      if (change.ids.has(id) && !dirty && !editor.isFocused() && !page.contains(document.activeElement)) {
        if (note.body !== savedBody) {
          editor.setHtml(note.body);
          savedBody = note.body;
        }
        if (note.title !== savedTitle) {
          titleInput.value = note.title;
          savedTitle = note.title;
          growTitle();
        }
        if (form && note.fields !== savedFields) {
          form.reload(note);
          formValues = form.values();
          savedFields = note.fields;
        }
        updateWordCount();
      }
      tags.render();
      renderChrome();
    },
    destroy() {
      save();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      editor.destroy();
      const note = db.getNote(id);
      if (changedSinceVersion && note) db.snapshotNote(id, note);
      // A brand new note left untouched would only be clutter, so it is removed silently.
      if (isNew && note && isBlankNote(note, type)) db.purgeNotes([id]);
    },
  };
}
