/**
 * actions.js: note operations as the user sees them, with undo toasts and error messages.
 * Views call these instead of the data layer so behaviour stays the same everywhere.
 */
import { app } from '../context.js';
import { RuleError } from '../data/schema.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { plural } from '../ui/dom.js';

/** Runs a change with an Undo toast. Rule violations are shown instead of thrown. */
export function withUndo(message, change) {
  try {
    const { undo } = app.db.undoable(change);
    toast(typeof message === 'function' ? message() : message, { undo });
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

export function showError(error) {
  if (error instanceof RuleError) {
    toast(error.message, { error: true });
  } else {
    console.error(error);
    toast('Something went wrong. Your notes were not changed.', { error: true });
  }
}

/** Human name of a location, such as "Fun › Movies to watch" or "Inbox". */
export function locationName({ spaceId, collectionId }) {
  const { db } = app;
  const space = db.getSpace(spaceId);
  if (!space) return 'Inbox';
  const col = db.getCollection(collectionId);
  if (!col) return space.name;
  const parent = db.getCollection(col.parentId);
  return [space.name, parent?.name, col.name].filter(Boolean).join(' › ');
}

export function moveNotes(ids, target) {
  const count = plural(ids.length, 'note');
  return withUndo(`Moved ${count} to ${locationName(target)}`, () => app.db.moveNotes(ids, target));
}

export function archiveNotes(ids) {
  return withUndo(`Archived ${plural(ids.length, 'note')}`, () => app.db.archiveNotes(ids));
}

export function unarchiveNotes(ids) {
  return withUndo(`Restored ${plural(ids.length, 'note')} from the archive`, () => app.db.unarchiveNotes(ids));
}

export function trashNotes(ids) {
  return withUndo(`Moved ${plural(ids.length, 'note')} to Trash`, () => app.db.trashNotes(ids));
}

export function restoreNotes(ids) {
  return withUndo(`Restored ${plural(ids.length, 'note')}`, () => app.db.restoreNotes(ids));
}

export async function purgeNotes(ids) {
  const ok = await confirmDialog({
    title: ids.length === 1 ? 'Delete this note forever?' : `Delete ${ids.length} notes forever?`,
    message: 'This cannot be undone.',
    confirmLabel: 'Delete forever',
    danger: true,
  });
  if (ok) {
    app.db.purgeNotes(ids);
    toast(`Deleted ${plural(ids.length, 'note')} forever`);
  }
  return ok;
}

/** New empty note in a location, opened in the editor. Abandoned empty notes are removed on leaving. */
export function newNote(target = {}) {
  const note = app.db.createNote(target);
  app.navigate(`note/${note.id}?new`);
  return note;
}
