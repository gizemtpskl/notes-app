/**
 * templatesPage.js: the list of templates, choosing one for a new note, and saving a note as one.
 */
import { app } from '../context.js';
import { fill, h } from '../ui/dom.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { showError, withUndo } from './actions.js';
import { emptyState } from './noteList.js';
import { homeForType } from './palette.js';

/** Makes a note from a template and opens it. Without a location it goes where its type belongs. */
export function newFromTemplate(templateId, target = null) {
  const { db } = app;
  try {
    const template = db.getTemplate(templateId);
    const where = target ?? homeForType(template.typeId);
    const { typeId: _ignored, ...location } = where;
    const note = db.createFromTemplate(templateId, location);
    app.navigate(`note/${note.id}`);
    return note;
  } catch (error) {
    showError(error);
    return null;
  }
}

/** Lets you choose a template for a new note in a location. */
export function pickTemplateDialog(target = null) {
  const { db } = app;
  return openDialog({
    title: 'New note from a template',
    className: 'dialog-picker',
    build: (close) => h('div', { class: 'picker-list', role: 'list' },
      db.listTemplates().map((template) => h('button', {
        class: 'picker-item',
        type: 'button',
        onClick: () => {
          close();
          newFromTemplate(template.id, target);
        },
      },
      h('span', { class: 'picker-icon', 'aria-hidden': 'true' }, template.icon),
      h('span', { class: 'picker-label' }, template.name),
      h('span', { class: 'picker-detail' }, db.getType(template.typeId).name)))),
  });
}

export async function saveAsTemplateFlow(noteId) {
  const { db } = app;
  const note = db.getNote(noteId);
  if (!note) return;
  const name = await promptDialog({
    title: 'Save as a template',
    label: 'Template name',
    value: note.title,
    confirmLabel: 'Save template',
    validate: (text) => (text ? '' : 'A template needs a name.'),
  });
  if (name) withUndo(`Saved template "${name}"`, () => db.saveNoteAsTemplate(noteId, { name }));
}

export function templatesPageView() {
  const { db } = app;
  const body = h('div');

  function refresh() {
    const templates = db.listTemplates();
    const own = templates.filter((t) => !t.builtin);
    const row = (template) => h('li', { class: 'tag-row', dataset: { id: template.id } },
      h('button', {
        class: 'tag-row-link template-use',
        type: 'button',
        onClick: () => newFromTemplate(template.id),
      },
      h('span', { class: 'tag-row-name' }, h('span', { class: 'view-row-icon', 'aria-hidden': 'true' }, template.icon), template.name),
      h('span', { class: 'tag-row-count' }, db.getType(template.typeId).name)),
      !template.builtin && h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Actions for ${template.name}`,
        'aria-haspopup': 'menu',
        onClick: (event) => openMenu(event.currentTarget, [
          {
            label: 'Rename',
            icon: 'edit',
            onSelect: async () => {
              const name = await promptDialog({
                title: 'Rename template', label: 'Template name', value: template.name, validate: (text) => (text ? '' : 'A template needs a name.'),
              });
              if (name) db.updateTemplate(template.id, { name });
            },
          },
          {
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: async () => {
              const ok = await confirmDialog({
                title: `Delete "${template.name}"?`, message: 'Notes made from it stay as they are.', confirmLabel: 'Delete template', danger: true,
              });
              if (ok) withUndo(`Deleted ${template.name}`, () => db.deleteTemplate(template.id));
            },
          },
        ], { label: `${template.name} actions` }),
      }, icon('more')));
    fill(body,
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Your templates'),
        own.length
          ? h('ul', { class: 'tag-rows' }, own.map(row))
          : emptyState({
            emoji: '🧩',
            title: 'None of your own yet',
            text: 'Open any note, choose its ... menu, then "Save as template".',
          })),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Built in'),
        h('ul', { class: 'tag-rows' }, templates.filter((t) => t.builtin).map(row))));
  }

  refresh();
  return {
    title: 'Templates',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Templates'),
        h('p', { class: 'page-sub' }, 'Choose one to start a new note from it.')),
      body),
    update: (change) => {
      if (change.stores.has('templates')) refresh();
    },
  };
}
