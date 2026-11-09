/**
 * transfer.js: backup and restore flows, shared by Settings, onboarding and the reminder.
 */
import { app } from '../context.js';
import { applyImport, buildExport, markdownExport, parseImport } from '../data/porting.js';
import { downloadBlob, h, plural } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { showError } from './actions.js';

const dateStamp = () => new Date().toISOString().slice(0, 10);

/** Downloads a full JSON backup. Returns true on success. */
export async function exportBackup() {
  try {
    const backup = await buildExport(app.db);
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    downloadBlob(blob, `notes-backup-${dateStamp()}.json`);
    app.db.markExported();
    toast('Backup downloaded');
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

export async function exportAllMarkdown() {
  try {
    const { blob, filename } = await markdownExport(app.db, { kind: 'all' });
    downloadBlob(blob, filename);
    app.db.markExported();
    toast('Markdown export downloaded');
  } catch (error) {
    showError(error);
  }
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => {
      resolve(input.files[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

function reportProblem(message) {
  return openDialog({
    title: "Couldn't import that file",
    build: (close) => h('div', null,
      h('p', { class: 'dialog-text' }, message),
      h('p', { class: 'dialog-text' }, 'Your current notes were not changed.'),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onClick: () => close() }, 'OK'))),
  });
}

/** Shows what the file contains and asks how to apply it. Resolves with 'merge', 'replace' or undefined. */
function confirmImport(parsed) {
  const hasNotes = app.db.data.notes.size > 0;
  const { summary } = parsed;
  return openDialog({
    title: 'Import backup',
    build: (close) => {
      const mergeRadio = h('input', { type: 'radio', name: 'import-mode', value: 'merge', checked: true });
      const replaceRadio = h('input', { type: 'radio', name: 'import-mode', value: 'replace' });
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          close(replaceRadio.checked ? 'replace' : 'merge');
        },
      },
      h('p', { class: 'dialog-text' },
        `This file has ${plural(summary.notes, 'note')}, ${plural(summary.spaces, 'space')}, ${plural(summary.collections, 'collection')}, ${plural(summary.images, 'image')} and ${plural(summary.timeBlocks, 'timetable block')}.`),
      parsed.exportedAt && h('p', { class: 'dialog-note' }, `Created ${new Date(parsed.exportedAt).toLocaleString()}.`),
      parsed.warnings.map((warning) => h('p', { class: 'dialog-note' }, warning)),
      hasNotes && h('fieldset', { class: 'radio-group' },
        h('legend', { class: 'field-label' }, 'How should it be applied?'),
        h('label', { class: 'radio' }, mergeRadio,
          h('span', null, h('strong', null, 'Merge'), h('span', { class: 'radio-hint' }, 'Keep everything here and add the file. If a note exists in both, the newer version wins.'))),
        h('label', { class: 'radio' }, replaceRadio,
          h('span', null, h('strong', null, 'Replace'), h('span', { class: 'radio-hint' }, 'Remove what is here now and use only the file.')))),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Import')));
    },
  });
}

/** Full flow: choose a file, validate, confirm, apply. Resolves true if something was imported. */
export async function importBackup() {
  const file = await pickFile('.json,application/json');
  if (!file) return false;
  let text;
  try {
    text = await file.text();
  } catch {
    await reportProblem('The file could not be read.');
    return false;
  }
  const parsed = parseImport(text);
  if (!parsed.ok) {
    await reportProblem(parsed.error);
    return false;
  }
  const mode = await confirmImport(parsed);
  if (!mode) return false;
  try {
    const undo = await applyImport(app.db, parsed.data, mode);
    toast(`Imported ${plural(parsed.summary.notes, 'note')}`, { undo });
    return true;
  } catch (error) {
    console.error(error);
    await reportProblem('Saving the imported data failed. Your device may be out of storage space.');
    return false;
  }
}
