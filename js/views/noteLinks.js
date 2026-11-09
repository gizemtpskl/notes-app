/**
 * noteLinks.js: below a note: the notes that link to it, and related notes that share its tags.
 */
import { app } from '../context.js';
import { displayTitle } from '../data/types.js';
import { fill, h } from '../ui/dom.js';
import { locationName } from './actions.js';

function linkRows(notes) {
  return h('ul', { class: 'link-rows' }, notes.map((note) => h('li', null,
    h('a', { class: 'link-row', href: `#/note/${encodeURIComponent(note.id)}` },
      h('span', { class: 'link-row-icon', 'aria-hidden': 'true' }, app.db.getType(note.typeId).icon),
      h('span', { class: 'link-row-title' }, displayTitle(note, app.db.getType(note.typeId)) || 'Untitled'),
      h('span', { class: 'link-row-where' }, locationName(note))))));
}

export function noteLinksPanel(noteId) {
  const el = h('div', { class: 'note-links' });

  function refresh() {
    const { db } = app;
    const note = db.getNote(noteId);
    if (!note) return;
    const backlinks = db.backlinks(noteId);
    const already = new Set([...backlinks.map((n) => n.id), ...(note.links ?? [])]);
    const related = db.relatedNotes(note, 8).filter((other) => !already.has(other.id)).slice(0, 5);
    fill(el,
      backlinks.length > 0 && h('section', { class: 'note-links-section', 'aria-label': 'Linked from' },
        h('h2', { class: 'section-title' }, 'Linked from'),
        linkRows(backlinks)),
      related.length > 0 && h('section', { class: 'note-links-section', 'aria-label': 'Related notes' },
        h('h2', { class: 'section-title' }, 'Related notes'),
        linkRows(related)));
  }

  refresh();
  return { el, refresh };
}
