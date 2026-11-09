/**
 * typesPage.js: the list of note types, and the custom type builder. Changes save as you go,
 * like everything else. Built-in types are read-only, and can be duplicated to customize.
 */
import { app } from '../context.js';
import { FIELD_KINDS } from '../data/fieldKinds.js';
import { uid } from '../data/schema.js';
import { BUILDER_KINDS, VIEWS, viewsFor } from '../data/types.js';
import { confirmDialog } from '../ui/dialog.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pointerDrag } from '../ui/pointerDrag.js';
import { withUndo } from './actions.js';
import { emojiPicker } from './dialogs.js';
import { fieldForm } from './fieldWidgets.js';
import { breadcrumbs, notFound } from './folder.js';

export function typesListView() {
  const { db } = app;
  const body = h('div');

  function row(type) {
    const count = db.typeUsage(type.id);
    return h('li', { class: 'type-row' },
      h('a', { class: 'type-link', href: `#/types/${encodeURIComponent(type.id)}` },
        h('span', { class: 'type-icon', 'aria-hidden': 'true' }, type.icon),
        h('span', { class: 'type-main' },
          h('span', { class: 'type-name' }, type.name),
          h('span', { class: 'type-meta' }, [
            type.fields.length ? plural(type.fields.length, 'field') : 'Just a title and text',
            count ? plural(count, 'note') : null,
          ].filter(Boolean).join(' · '))),
        icon('chevronRight', 16)));
  }

  function refresh() {
    const types = db.listTypes();
    const custom = types.filter((t) => !t.builtin);
    fill(body,
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Your types'),
        custom.length
          ? h('ul', { class: 'type-list' }, custom.map(row))
          : h('p', { class: 'empty-line' }, 'None yet. Make one when your notes keep needing the same details, like "Plants" with a watering schedule.')),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Built-in'),
        h('ul', { class: 'type-list' }, types.filter((t) => t.builtin).map(row))));
  }
  refresh();

  return {
    title: 'Note types',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        breadcrumbs([{ label: 'Settings', href: '#/settings' }, { label: 'Note types' }]),
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, 'Note types'),
          h('div', { class: 'page-actions' },
            h('button', {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => app.navigate(`types/${db.createType({ name: 'New type' }).id}`),
            }, icon('plus', 16), 'New type'))),
        h('p', { class: 'page-sub' }, 'A type decides which details a note has and how a collection of them looks.')),
      body),
    update: (change) => {
      if (change.stores.has('noteTypes')) refresh();
    },
  };
}

function builtinFieldRow(field) {
  return h('li', { class: 'type-field-static' },
    h('span', { class: 'type-name' }, field.name),
    h('span', { class: 'type-meta' }, [
      FIELD_KINDS[field.kind]?.label,
      field.options?.length ? field.options.join(', ') : null,
    ].filter(Boolean).join(': ')));
}

export function typeEditorView({ id }) {
  const { db } = app;
  const initial = db.getType(id);
  if (!initial || initial.id !== id) return notFound('This note type no longer exists.');

  const duplicate = () => {
    const copy = db.duplicateType(id);
    app.navigate(`types/${copy.id}`);
  };

  if (initial.builtin) {
    return {
      title: initial.name,
      el: h('div', { class: 'page page-narrow' },
        h('header', { class: 'page-head' },
          breadcrumbs([{ label: 'Settings', href: '#/settings' }, { label: 'Note types', href: '#/types' }, { label: initial.name }]),
          h('div', { class: 'page-title-row' },
            h('h1', { class: 'page-title', tabindex: '-1' }, h('span', { class: 'page-emoji', 'aria-hidden': 'true' }, initial.icon), initial.name),
            h('div', { class: 'page-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: duplicate }, icon('copy', 16), 'Duplicate to customize'))),
          h('p', { class: 'page-sub' }, 'Built-in types can’t be changed, so their special views keep working. A copy is yours to edit.')),
        h('section', { class: 'section' },
          h('h2', { class: 'section-title' }, 'Fields'),
          initial.fields.length
            ? h('ul', { class: 'type-list' }, initial.fields.map(builtinFieldRow))
            : h('p', { class: 'empty-line' }, 'Just a title and rich text.'))),
    };
  }

  const current = () => db.getType(id);
  const save = (patch) => db.updateType(id, patch);
  const fieldsEl = h('ul', { class: 'builder-fields' });
  const previewEl = h('div');
  const viewSelect = h('select', {
    class: 'select',
    id: 'type-default-view',
    onChange: () => save({ defaultView: viewSelect.value }),
  });

  function setFields(fields) {
    const updated = save({ fields });
    // A view can stop being available when its field goes away.
    if (!viewsFor(updated).includes(updated.defaultView)) save({ defaultView: 'list' });
    renderViewOptions();
    renderPreview();
  }

  function renderViewOptions() {
    const type = current();
    fill(viewSelect, viewsFor(type)
      .filter((view) => view !== 'journal')
      .map((view) => h('option', { value: view, selected: view === type.defaultView }, VIEWS[view].label)));
  }

  function renderPreview() {
    const type = current();
    fill(previewEl, type.fields.length
      ? fieldForm({ note: null, type, db, preview: true }).el
      : h('p', { class: 'empty-line' }, 'Add a field and it appears here, as it will in a note.'));
  }

  function updateField(fieldId, patch) {
    setFields(current().fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)));
  }

  function moveField(fieldId, step) {
    const fields = [...current().fields];
    const index = fields.findIndex((f) => f.id === fieldId);
    const to = index + step;
    if (to < 0 || to >= fields.length) return;
    fields.splice(to, 0, fields.splice(index, 1)[0]);
    setFields(fields);
    renderFields();
    fieldsEl.querySelector(`[data-id="${CSS.escape(fieldId)}"] .builder-field-name`)?.focus();
  }

  function removeField(field) {
    // Values stay on the notes, so Undo brings them back along with the field.
    withUndo(`Removed ${field.name}`, () => setFields(current().fields.filter((f) => f.id !== field.id)));
    renderFields();
  }

  function kindChanged(field, kind) {
    const patch = { kind };
    if (FIELD_KINDS[kind].hasOptions) {
      patch.options = field.options ?? [];
      patch.creatable = field.creatable ?? false;
    } else {
      patch.options = undefined;
      patch.creatable = undefined;
    }
    if (kind === 'rating') patch.max = field.max ?? 5;
    updateField(field.id, patch);
    renderFields();
  }

  function fieldRow(field, index, total) {
    const hasOptions = FIELD_KINDS[field.kind]?.hasOptions;
    const grip = h('button', {
      class: 'task-grip', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: 'Drag to reorder',
    }, icon('grip', 14));
    const row = h('li', { class: 'builder-field', dataset: { id: field.id } },
      h('div', { class: 'builder-field-main' },
        grip,
        h('input', {
          class: 'input builder-field-name',
          type: 'text',
          value: field.name,
          maxlength: 80,
          'aria-label': 'Field name',
          onInput: (event) => updateField(field.id, { name: event.target.value }),
          onBlur: (event) => {
            if (!event.target.value.trim()) {
              event.target.value = 'Untitled field';
              updateField(field.id, { name: 'Untitled field' });
            }
          },
        }),
        h('select', {
          class: 'select',
          'aria-label': `Kind of field for ${field.name}`,
          onChange: (event) => kindChanged(field, event.target.value),
        }, BUILDER_KINDS.map((kind) => h('option', { value: kind.id, selected: kind.id === field.kind }, kind.label))),
        h('button', { class: 'icon-btn', type: 'button', disabled: index === 0, 'aria-label': `Move ${field.name} up`, onClick: () => moveField(field.id, -1) }, icon('arrowUp', 15)),
        h('button', { class: 'icon-btn', type: 'button', disabled: index === total - 1, 'aria-label': `Move ${field.name} down`, onClick: () => moveField(field.id, 1) }, icon('arrowDown', 15)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${field.name}`, onClick: () => removeField(field) }, icon('trash', 15))),
      hasOptions && h('div', { class: 'builder-field-extra' },
        h('label', { class: 'field-grow' },
          h('span', { class: 'field-label' }, 'Options, separated by commas'),
          h('input', {
            class: 'input',
            type: 'text',
            value: (field.options ?? []).join(', '),
            placeholder: 'Option one, Option two',
            onChange: (event) => updateField(field.id, {
              options: [...new Set(event.target.value.split(',').map((o) => o.trim()).filter(Boolean))],
            }),
          })),
        h('label', { class: 'check-field' },
          h('input', {
            type: 'checkbox',
            checked: field.creatable === true,
            onChange: (event) => updateField(field.id, { creatable: event.target.checked }),
          }),
          h('span', null, 'Allow new values while writing'))),
      field.kind === 'rating' && h('div', { class: 'builder-field-extra' },
        h('label', null,
          h('span', { class: 'field-label' }, 'Scale'),
          h('select', {
            class: 'select',
            onChange: (event) => updateField(field.id, { max: Number(event.target.value) }),
          }, [3, 5, 10].map((max) => h('option', { value: max, selected: (field.max ?? 5) === max }, `1 to ${max}`))))));

    let overIndex = null;
    pointerDrag(grip, {
      start: () => {
        row.classList.add('is-dragging');
        document.body.classList.add('is-pointer-dragging');
      },
      move: (event) => {
        const rows = [...fieldsEl.children];
        rows.forEach((r) => r.classList.remove('is-drop-before', 'is-drop-after'));
        overIndex = null;
        rows.forEach((candidate, i) => {
          const box = candidate.getBoundingClientRect();
          if (candidate !== row && event.clientY >= box.top && event.clientY <= box.bottom) {
            const before = event.clientY < box.top + box.height / 2;
            candidate.classList.add(before ? 'is-drop-before' : 'is-drop-after');
            overIndex = before ? i : i + 1;
          }
        });
      },
      drop: () => {
        row.classList.remove('is-dragging');
        document.body.classList.remove('is-pointer-dragging');
        if (overIndex !== null) {
          const fields = [...current().fields];
          const from = fields.findIndex((f) => f.id === field.id);
          const to = from < overIndex ? overIndex - 1 : overIndex;
          fields.splice(to, 0, fields.splice(from, 1)[0]);
          setFields(fields);
        }
        renderFields();
      },
      cancel: () => {
        document.body.classList.remove('is-pointer-dragging');
        renderFields();
      },
    });
    return row;
  }

  function renderFields() {
    const { fields } = current();
    fill(fieldsEl, fields.map((field, i) => fieldRow(field, i, fields.length)));
  }

  function addField() {
    const field = { id: uid(), name: 'New field', kind: 'text' };
    setFields([...current().fields, field]);
    renderFields();
    const input = fieldsEl.querySelector(`[data-id="${CSS.escape(field.id)}"] .builder-field-name`);
    input?.focus();
    input?.select();
  }

  async function deleteType() {
    const count = db.typeUsage(id);
    const ok = await confirmDialog({
      title: `Delete "${current().name}"?`,
      message: count
        ? `${plural(count, 'note')} of this type will become Free notes, with their details written into the text so nothing is lost.`
        : 'No notes use this type.',
      confirmLabel: 'Delete type',
      danger: true,
    });
    if (ok) {
      app.navigate('types');
      withUndo(`Deleted ${initial.name}`, () => db.deleteType(id));
    }
  }

  const iconInput = h('input', {
    class: 'input input-emoji',
    id: 'type-icon',
    type: 'text',
    value: initial.icon,
    maxlength: 8,
    onInput: (event) => {
      if (event.target.value.trim()) save({ icon: event.target.value.trim() });
    },
  });

  const titleEl = h('h1', { class: 'page-title', tabindex: '-1' }, initial.name);

  renderFields();
  renderViewOptions();
  renderPreview();

  return {
    title: initial.name,
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        breadcrumbs([{ label: 'Settings', href: '#/settings' }, { label: 'Note types', href: '#/types' }, { label: 'Edit type' }]),
        h('div', { class: 'page-title-row' },
          titleEl,
          h('div', { class: 'page-actions' },
            h('button', { class: 'btn', type: 'button', onClick: duplicate }, icon('copy', 16), 'Duplicate'),
            h('button', { class: 'btn btn-danger-quiet', type: 'button', onClick: deleteType }, icon('trash', 16), 'Delete')))),
      h('section', { class: 'section' },
        h('div', { class: 'field-row' },
          h('div', { class: 'field field-narrow' }, h('label', { class: 'field-label', for: 'type-icon' }, 'Icon'), iconInput),
          h('div', { class: 'field field-grow' },
            h('label', { class: 'field-label', for: 'type-name' }, 'Name'),
            h('input', {
              class: 'input',
              id: 'type-name',
              type: 'text',
              value: initial.name,
              maxlength: 80,
              onInput: (event) => {
                const name = event.target.value.trim();
                if (name) {
                  save({ name });
                  titleEl.textContent = name;
                  document.title = `${name} · Notes`;
                }
              },
            }))),
        emojiPicker(iconInput),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'type-default-view' }, 'Collections open as'), viewSelect),
          h('div', { class: 'field field-grow' },
            h('span', { class: 'field-label' }, 'Privacy'),
            h('label', { class: 'check-field' },
              h('input', {
                type: 'checkbox',
                checked: initial.privateByDefault === true,
                onChange: (event) => save({ privateByDefault: event.target.checked }),
              }),
              h('span', null, 'New notes are private (kept off Home)'))))),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Fields'),
        fieldsEl,
        h('button', { class: 'btn', type: 'button', onClick: addField }, icon('plus', 16), 'Add field')),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Preview'),
        previewEl)),
    update: (change) => {
      // Undoing a field removal needs the list redrawn. Edits made on this page are already showing.
      if (change.stores.has('noteTypes') && !fieldsEl.contains(document.activeElement)) {
        if (!db.data.noteTypes.has(id)) return;
        renderFields();
        renderViewOptions();
        renderPreview();
      }
    },
    // A brand new type starts with its name selected, ready to be typed over.
    keepsFocus: initial.name === 'New type',
    mounted() {
      if (initial.name === 'New type') {
        const input = document.getElementById('type-name');
        input?.focus();
        input?.select();
      }
    },
  };
}
