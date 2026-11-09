/**
 * historyDialog.js: a note's last 20 versions, with a preview and restore.
 */
import { app } from '../context.js';
import { countWords } from '../data/text.js';
import { htmlToText } from '../data/html.js';
import { createEditor } from '../editor/editor.js';
import { fill, fullDate, h, plural } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { showError } from './actions.js';

export function openHistory(noteId) {
  const { db } = app;
  return openDialog({
    title: 'Version history',
    className: 'dialog-history',
    build: (close) => {
      const list = h('ul', { class: 'history-list', 'aria-label': 'Saved versions' });
      const preview = h('div', { class: 'history-preview' });
      let previewEditor = null;
      let versions = [];
      let current = null;

      function show(version) {
        current = version;
        previewEditor?.destroy();
        previewEditor = createEditor({
          html: version.body,
          readOnly: true,
          label: 'Older version',
          loadImage: async (assetId) => (await db.getAsset(assetId))?.dataUrl ?? null,
        });
        fill(preview,
          h('h3', { class: 'history-title' }, version.title || 'Untitled'),
          previewEditor.el,
          h('div', { class: 'dialog-actions' },
            h('button', {
              class: 'btn btn-primary',
              type: 'button',
              onClick: async () => {
                try {
                  await db.restoreVersion(noteId, version.at);
                  close();
                  toast('Version restored. The one you replaced is in the history too.');
                  app.reloadRoute();
                } catch (error) {
                  showError(error);
                }
              },
            }, icon('restore', 15), 'Restore this version')));
        for (const button of list.querySelectorAll('button')) {
          button.setAttribute('aria-current', String(Number(button.dataset.at) === version.at));
        }
      }

      db.flush().then(() => db.listVersions(noteId)).then((found) => {
        versions = found;
        if (!versions.length) {
          fill(list);
          fill(preview, h('p', { class: 'empty-line' }, 'No earlier versions yet. They are saved as you edit, and when you leave a note.'));
          return;
        }
        fill(list, versions.map((version) => h('li', null,
          h('button', {
            class: 'history-item', type: 'button', dataset: { at: version.at }, onClick: () => show(version),
          },
          h('span', { class: 'history-date' }, fullDate(version.at)),
          h('span', { class: 'history-words' }, plural(countWords(htmlToText(version.body)), 'word'))))));
        show(current ?? versions[0]);
      });

      return h('div', { class: 'history' }, list, preview);
    },
  });
}
