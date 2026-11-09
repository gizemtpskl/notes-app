/**
 * onboarding.js: the first-run setup. Proposes default Spaces and Collections from
 * data/defaults.json, which can be accepted or edited before anything is created.
 */
import { app } from '../context.js';
import { SPACE_COLORS } from '../data/schema.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { importBackup } from './transfer.js';

async function loadDefaults() {
  try {
    const response = await fetch(new URL('../../data/defaults.json', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { spaces } = await response.json();
    return spaces;
  } catch (error) {
    console.warn('Default structure could not be loaded:', error);
    return [];
  }
}

/** Creates everything in one batch. Exported so tests can use the same logic. */
export function applyStructure(db, spaces) {
  db.batch(() => {
    for (const draft of spaces) {
      if (!draft.name.trim()) continue;
      const space = db.createSpace({ name: draft.name, icon: draft.icon, color: draft.color });
      for (const col of draft.collections) {
        if (!col.name.trim()) continue;
        const parent = db.createCollection({ name: col.name, spaceId: space.id, defaultTypeId: col.defaultTypeId });
        for (const child of col.children ?? []) {
          if (child.name.trim()) {
            db.createCollection({
              name: child.name, spaceId: space.id, parentId: parent.id, defaultTypeId: child.defaultTypeId,
            });
          }
        }
      }
    }
    db.setMeta('onboarded', true);
    db.setMeta('firstUsedAt', Date.now());
  });
}

/** Shows setup and resolves when it is finished. */
export function runOnboarding() {
  return new Promise((resolve) => {
    const { db } = app;
    const list = h('div', { class: 'setup-list' });
    let drafts = [];

    const finish = async (structure) => {
      applyStructure(db, structure);
      await db.flush();
      screen.remove();
      resolve();
    };

    function nameInput(item, label) {
      return h('input', {
        class: 'input input-quiet',
        type: 'text',
        value: item.name,
        'aria-label': label,
        maxlength: 80,
        onInput: (event) => {
          item.name = event.target.value;
        },
      });
    }

    function removeButton(label, onRemove) {
      return h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onClick: onRemove,
      }, icon('close', 15));
    }

    function renderCollection(col, siblings, space, depth = 0) {
      return h('li', null,
        h('div', { class: 'setup-row', cssVars: { '--depth': depth } },
          icon('folder', 15),
          nameInput(col, `Collection name in ${space.name}`),
          removeButton(`Remove ${col.name}`, () => {
            siblings.splice(siblings.indexOf(col), 1);
            render();
          })),
        col.children?.length > 0 && h('ul', { class: 'setup-sublist' },
          col.children.map((child) => renderCollection(child, col.children, space, depth + 1))));
    }

    function render() {
      list.replaceChildren(...drafts.map((space) => h('section', {
        class: 'setup-space', dataset: { color: space.color }, 'aria-label': space.name,
      },
      h('div', { class: 'setup-row setup-row-space' },
        h('input', {
          class: 'input input-quiet input-emoji',
          type: 'text',
          value: space.icon,
          maxlength: 8,
          'aria-label': `Icon for ${space.name}`,
          onInput: (event) => {
            space.icon = event.target.value;
          },
        }),
        nameInput(space, 'Space name'),
        h('button', {
          class: 'swatch swatch-cycle',
          type: 'button',
          dataset: { color: space.color },
          'aria-label': `Change color for ${space.name}. Now ${space.color}`,
          title: 'Change color',
          onClick: () => {
            space.color = SPACE_COLORS[(SPACE_COLORS.indexOf(space.color) + 1) % SPACE_COLORS.length];
            render();
          },
        }),
        removeButton(`Remove ${space.name}`, () => {
          drafts.splice(drafts.indexOf(space), 1);
          render();
        })),
      h('ul', { class: 'setup-sublist' },
        space.collections.map((col) => renderCollection(col, space.collections, space))),
      h('button', {
        class: 'btn-link',
        type: 'button',
        onClick: () => {
          space.collections.push({ name: 'New collection', defaultTypeId: 'free', children: [] });
          render();
          const inputs = list.children[drafts.indexOf(space)].querySelectorAll('.setup-sublist input');
          inputs[inputs.length - 1]?.select();
        },
      }, icon('plus', 14), 'Add collection'))));
      list.append(h('button', {
        class: 'btn-link',
        type: 'button',
        onClick: () => {
          drafts.push({
            name: 'New space', icon: '📁', color: SPACE_COLORS[drafts.length % SPACE_COLORS.length], collections: [],
          });
          render();
          list.querySelector('.setup-space:last-of-type .setup-row-space input:nth-of-type(2)')?.select();
        },
      }, icon('plus', 14), 'Add space'));
    }

    const screen = h('main', { class: 'setup' },
      h('div', { class: 'setup-inner' },
        h('h1', { class: 'setup-title', tabindex: '-1' }, 'Welcome to your notes'),
        h('p', { class: 'setup-text' }, 'Here is a starting structure. Rename or remove anything. You can change all of it later, too.'),
        h('p', { class: 'setup-note' }, 'Your notes stay in this browser on this device. Nothing is uploaded, so remember to download backups from Settings.'),
        list,
        h('div', { class: 'setup-actions' },
          h('button', { class: 'btn btn-primary btn-large', type: 'button', onClick: () => finish(drafts) }, 'Start with this setup'),
          h('button', { class: 'btn btn-large', type: 'button', onClick: () => finish([]) }, 'Start empty'),
          h('button', {
            class: 'btn-link',
            type: 'button',
            onClick: async () => {
              if (await importBackup()) {
                db.setMeta('firstUsedAt', Date.now());
                await db.flush();
                screen.remove();
                resolve();
              }
            },
          }, icon('upload', 14), 'Restore from a backup'))));

    document.body.append(screen);
    loadDefaults().then((spaces) => {
      drafts = spaces.map((space) => ({
        ...space,
        collections: space.collections.map((col) => ({ ...col, children: (col.children ?? []).map((c) => ({ ...c })) })),
      }));
      render();
      screen.querySelector('.setup-title').focus();
    });
  });
}
