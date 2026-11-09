/**
 * links.js: links between notes.
 *
 * A wiki link is stored in a note's body as an ordinary anchor, <a href="#/note/ID">Title</a>,
 * so it survives sanitizing, export and copy and paste. note.links holds the ids a note points
 * to (from its body and its "Link to a note" fields). It is always derived, never edited by hand.
 * Backlinks are not stored at all: the data layer builds them from note.links on demand.
 */
import { fieldValue } from './fieldKinds.js';
import { escapeHtml } from './html.js';

const NOTE_ANCHOR = /<a href="#\/note\/([\w-]+)"/g;

export function bodyLinkIds(html) {
  if (!html || !html.includes('#/note/')) return [];
  return [...new Set([...html.matchAll(NOTE_ANCHOR)].map((match) => match[1]))];
}

/** Every note this note points to, without itself. */
export function collectLinks(note, type) {
  const ids = new Set(bodyLinkIds(note.body));
  for (const field of type.fields) {
    if (field.kind === 'relation') {
      const value = fieldValue(note, field);
      if (value) ids.add(value);
    }
  }
  ids.delete(note.id);
  return [...ids];
}

export function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Updates the text of links to a renamed note. A link with its own wording is left alone:
 * only text that still equals the old title follows the new one.
 */
export function renameLinkText(html, noteId, oldTitle, newTitle) {
  const from = `<a href="#/note/${noteId}">${escapeHtml(oldTitle)}</a>`;
  if (!html.includes(from)) return html;
  return html.replaceAll(from, `<a href="#/note/${noteId}">${escapeHtml(newTitle)}</a>`);
}
