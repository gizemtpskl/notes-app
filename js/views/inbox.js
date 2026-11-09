/**
 * inbox.js: the Inbox list, and Inbox review, which shows one note at a time with
 * big buttons to file, archive or delete it.
 */
import { app } from '../context.js';
import { drawMathIn } from '../editor/math.js';
import { fill, h, isTyping, modKey, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { showError } from './actions.js';
import { captureField } from './capture.js';
import { editCollectionDialog, editSpaceDialog } from './dialogs.js';
import { emptyState, noteList } from './noteList.js';
import { createSelection } from './selection.js';
import { isGoPending } from './shortcuts.js';

export function inboxView() {
  const { db } = app;
  const body = h('div');
  const reviewButton = h('a', { class: 'btn btn-primary', href: '#/inbox/review' }, icon('sparkle', 16), 'Review');
  const selection = createSelection({
    getIds: () => db.listNotes({ inbox: true, sort: { key: 'created', dir: 'desc' } }).map((n) => n.id),
    onMode: () => refresh(),
  });

  function refresh() {
    const notes = db.listNotes({ inbox: true, sort: { key: 'created', dir: 'desc' } });
    reviewButton.hidden = !notes.length;
    selection.button.hidden = !notes.length;
    body.replaceChildren(noteList(notes, {
      dateKey: 'created',
      selection,
      empty: emptyState({
        emoji: '📥',
        title: 'Inbox is empty',
        text: 'Everything you capture lands here first. Press N anywhere to capture a thought.',
      }),
    }));
  }

  refresh();

  return {
    title: 'Inbox',
    el: h('div', { class: 'page' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, 'Inbox'),
          h('div', { class: 'page-actions' }, selection.button, reviewButton)),
        h('p', { class: 'page-sub' }, 'Capture first, organize later.')),
      captureField(),
      h('section', { class: 'section' }, body),
      selection.bar),
    update: (change) => {
      if (change.structural || change.source === 'remote') {
        refresh();
        selection.prune();
      }
    },
    destroy: () => selection.destroy(),
  };
}

export function inboxReviewView() {
  const { db } = app;
  // A fixed queue, so a skipped note doesn't reappear straight away. Oldest notes come first.
  let queue = db.listNotes({ inbox: true, sort: { key: 'created', dir: 'asc' } }).map((n) => n.id);
  let filed = 0;
  let step = { name: 'space', spaceId: null };
  const stage = h('div', { class: 'review' });
  const total = () => filed + queue.length;

  function current() {
    while (queue.length) {
      const note = db.getNote(queue[0]);
      if (note && note.spaceId === null && !note.trashedAt && !note.archived) return note;
      queue.shift();
    }
    return null;
  }

  function advance(message, change) {
    const note = current();
    try {
      const { undo } = db.undoable(() => change(note));
      queue.shift();
      filed += 1;
      step = { name: 'space', spaceId: null };
      toast(message, {
        undo: () => {
          undo();
          queue.unshift(note.id);
          filed = Math.max(0, filed - 1);
          step = { name: 'space', spaceId: null };
          render();
        },
      });
      render();
    } catch (error) {
      showError(error);
    }
  }

  function fileTo(target) {
    const label = [db.getSpace(target.spaceId)?.name, db.getCollection(target.collectionId)?.name].filter(Boolean).join(' › ');
    advance(`Filed in ${label}`, (note) => db.fileNote(note.id, target));
  }

  /** The collection's default type first, then what you've used there, then everything else. */
  function rankedTypes(target) {
    const col = db.getCollection(target.collectionId);
    const preferred = col && db.data.noteTypes.has(col.defaultTypeId) ? col.defaultTypeId : 'free';
    const uses = new Map();
    const siblings = target.collectionId
      ? db.listNotes({ status: 'all', collectionId: target.collectionId })
      : db.listNotes({ status: 'all', spaceId: target.spaceId, rootOnly: true });
    for (const note of siblings) uses.set(note.typeId, (uses.get(note.typeId) ?? 0) + 1);
    const rank = (type) => {
      if (type.id === preferred) return Infinity;
      return uses.get(type.id) ?? 0;
    };
    return { preferred, types: db.listTypes().map((type, order) => ({ type, order })).sort((a, b) => rank(b.type) - rank(a.type) || a.order - b.order).map((row) => row.type) };
  }

  function skip() {
    const id = queue.shift();
    if (queue.length) {
      queue.push(id);
    } else {
      queue = [id];
    }
    step = { name: 'space', spaceId: null };
    render();
  }

  /** Big numbered choice button. Keys 1 to 9 select the first nine. */
  function choice(index, content, onChoose, extraClass = '') {
    return h('button', {
      class: `choice ${extraClass}`,
      type: 'button',
      onClick: onChoose,
      dataset: { choice: index < 9 ? index + 1 : '' },
    },
    index < 9 && h('kbd', { class: 'choice-key', 'aria-hidden': 'true' }, String(index + 1)),
    content);
  }

  function renderDestinationStep(note) {
    if (step.name === 'space') {
      const spaces = db.listSpaces();
      const suggestions = db.suggestFiling(note);
      let index = 0;
      const suggestionButtons = suggestions.map((s) => {
        const space = db.getSpace(s.spaceId);
        const col = db.getCollection(s.collectionId);
        const button = choice(index, h('span', { class: 'choice-label' },
          h('span', { 'aria-hidden': 'true' }, `${space.icon} `),
          col ? `${space.name} › ${col.name}` : space.name), () => fileTo(s), 'choice-suggested');
        index += 1;
        return button;
      });
      return h('div', null,
        suggestionButtons.length > 0 && h('div', { class: 'review-group' },
          h('h2', { class: 'review-step' }, 'Suggested'),
          h('div', { class: 'choices choices-suggested' }, suggestionButtons)),
        h('div', { class: 'review-group' },
          h('h2', { class: 'review-step' }, 'Choose a space'),
          spaces.length
            ? h('div', { class: 'choices' }, spaces.map((space) => {
              const button = choice(index, h('span', { class: 'choice-label' }, h('span', { 'aria-hidden': 'true' }, `${space.icon} `), space.name), () => {
                step = { name: 'collection', spaceId: space.id };
                render();
              }, 'choice-space');
              button.dataset.color = space.color;
              index += 1;
              return button;
            }))
            : h('button', {
              class: 'btn',
              type: 'button',
              onClick: async () => {
                if (await editSpaceDialog()) render();
              },
            }, icon('plus', 16), 'Create your first space')));
    }

    if (step.name === 'type') {
      const { preferred, types } = rankedTypes(step.target);
      const where = [db.getSpace(step.target.spaceId)?.name, db.getCollection(step.target.collectionId)?.name].filter(Boolean).join(' › ');
      return h('div', { class: 'review-group' },
        h('h2', { class: 'review-step' },
          h('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': 'Back to collections',
            onClick: () => {
              step = { name: 'collection', spaceId: step.target.spaceId };
              render();
            },
          }, icon('arrowLeft', 16)),
          `${where}: what kind of note is it?`),
        h('div', { class: 'choices' }, types.map((type, index) => choice(index,
          h('span', { class: 'choice-label' }, h('span', { 'aria-hidden': 'true' }, `${type.icon} `), type.name),
          () => fileTo({ ...step.target, typeId: type.id }),
          type.id === preferred ? 'choice-suggested' : ''))));
    }

    const space = db.getSpace(step.spaceId);
    const options = [{ label: `Directly in ${space.name}`, target: { spaceId: space.id } }];
    for (const col of db.listCollections(space.id)) {
      options.push({ label: col.name, target: { spaceId: space.id, collectionId: col.id } });
      for (const child of db.listCollections(space.id, col.id)) {
        options.push({ label: `${col.name} › ${child.name}`, target: { spaceId: space.id, collectionId: child.id } });
      }
    }
    return h('div', { class: 'review-group' },
      h('h2', { class: 'review-step' },
        h('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Back to spaces',
          onClick: () => {
            step = { name: 'space', spaceId: null };
            render();
          },
        }, icon('arrowLeft', 16)),
        `${space.icon} ${space.name}: choose a collection`),
      h('div', { class: 'choices' },
        options.map((option, index) => choice(index, h('span', { class: 'choice-label' }, option.label), () => {
          step = { name: 'type', target: option.target };
          render();
        })),
        h('button', {
          class: 'choice choice-new',
          type: 'button',
          onClick: async () => {
            const created = await editCollectionDialog({ spaceId: space.id });
            if (created) {
              step = { name: 'type', target: { spaceId: space.id, collectionId: created.id } };
              render();
            }
          },
        }, icon('plus', 16), h('span', { class: 'choice-label' }, 'New collection'))));
  }

  function render() {
    const note = current();
    if (!note) {
      stage.replaceChildren(emptyState({
        emoji: '🎉',
        title: filed ? `All done. ${plural(filed, 'note')} sorted.` : 'Inbox is empty',
        text: 'Nothing left to organize.',
        action: h('a', { class: 'btn btn-primary', href: '#/home' }, 'Go to Home'),
      }));
      return;
    }
    const position = filed + 1;
    const progress = h('div', {
      class: 'review-progress',
      role: 'progressbar',
      'aria-label': 'Inbox review progress',
      'aria-valuemin': '0',
      'aria-valuemax': String(total()),
      'aria-valuenow': String(filed),
    }, h('div', { class: 'review-progress-bar', cssVars: { '--progress': `${(filed / total()) * 100}%` } }));

    const preview = h('div', { class: 'review-body' });
    // Bodies are sanitized by the data layer before they are stored.
    preview.innerHTML = note.body;
    drawMathIn(preview);
    for (const img of preview.querySelectorAll('img[data-asset]')) {
      db.getAsset(img.dataset.asset).then((asset) => {
        if (asset) img.src = asset.dataUrl;
      });
    }

    fill(stage,
      h('p', { class: 'review-count' }, `${position} of ${total()}`),
      progress,
      h('article', { class: 'review-card' },
        h('h2', { class: `review-title${note.title ? '' : ' is-untitled'}` }, note.title || 'Untitled'),
        note.body && preview),
      renderDestinationStep(note),
      h('div', { class: 'review-actions' },
        h('button', { class: 'btn', type: 'button', onClick: skip, disabled: queue.length < 2 }, icon('skip', 16), 'Skip', h('kbd', null, 'S')),
        h('a', { class: 'btn', href: `#/note/${note.id}` }, icon('edit', 16), 'Edit', h('kbd', null, 'E')),
        h('button', { class: 'btn', type: 'button', onClick: () => advance('Archived', (n) => db.archiveNotes([n.id])) }, icon('archive', 16), 'Archive', h('kbd', null, 'A')),
        h('button', { class: 'btn btn-danger-quiet', type: 'button', onClick: () => advance('Moved to Trash', (n) => db.trashNotes([n.id])) }, icon('trash', 16), 'Delete', h('kbd', null, 'D'))),
    );
  }

  function onKey(event) {
    if (isGoPending() || isTyping(event.target) || modKey(event) || event.altKey || document.querySelector('dialog[open]') || !current()) return;
    const key = event.key.toLowerCase();
    if (/^[1-9]$/.test(key)) {
      const button = stage.querySelector(`[data-choice="${key}"]`);
      if (button) {
        event.preventDefault();
        button.click();
      }
    } else if (key === 's') {
      if (queue.length > 1) skip();
    } else if (key === 'e') {
      app.navigate(`note/${current().id}`);
    } else if (key === 'a') {
      advance('Archived', (n) => db.archiveNotes([n.id]));
    } else if (key === 'd') {
      advance('Moved to Trash', (n) => db.trashNotes([n.id]));
    } else if (key === 'backspace' && step.name !== 'space') {
      step = step.name === 'type' ? { name: 'collection', spaceId: step.target.spaceId } : { name: 'space', spaceId: null };
      render();
    } else {
      return;
    }
    event.stopPropagation();
  }

  // Capture phase: runs before the global shortcuts, and handled keys go no further.
  document.addEventListener('keydown', onKey, true);
  render();

  return {
    title: 'Inbox review',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' },
          h('ol', null, h('li', null, h('a', { href: '#/inbox' }, '📥 Inbox')), h('li', null, h('span', { 'aria-current': 'page' }, 'Review')))),
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Inbox review')),
      stage),
    update(change) {
      // Notes captured during a review join the end of the queue.
      if (change.structural) {
        const known = new Set(queue);
        const fresh = db.listNotes({ inbox: true, sort: { key: 'created', dir: 'asc' } }).filter((n) => !known.has(n.id));
        queue.push(...fresh.map((n) => n.id));
        if (!stage.contains(document.activeElement)) render();
      }
    },
    destroy() {
      document.removeEventListener('keydown', onKey, true);
    },
  };
}
