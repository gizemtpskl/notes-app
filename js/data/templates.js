/**
 * templates.js: note templates. A template is a starting point: a type, a title pattern, a body
 * and field values. Built-ins live in code and are never stored. Any note can become a template.
 *
 * Template: { id, name, icon, typeId, title, body, fields, tagIds, builtin }
 * {{date}} in a title or body becomes today's date, and {{weekday}} the day's name.
 */
import { formatDay, toDateStr } from './dates.js';
import { normalizeCards } from './flashcards.js';
import { sanitizeHtml } from './html.js';
import { uid } from './schema.js';
import { normalizeTasks } from './tasks.js';

function builtin(definition) {
  return Object.freeze({
    builtin: true, fields: {}, tagIds: [], created: 0, updated: 0, ...definition,
  });
}

const checks = (...items) => `<ul data-type="check">${items.map((item) => `<li data-checked="false">${item || '<br>'}</li>`).join('')}</ul>`;

export const BUILTIN_TEMPLATES = Object.freeze([
  builtin({
    id: 'tpl-daily-journal',
    name: 'Daily journal',
    icon: '📔',
    typeId: 'journal',
    title: '',
    body: '<p>Today I…</p>',
  }),
  builtin({
    id: 'tpl-weekly-review',
    name: 'Weekly review',
    icon: '🗓️',
    typeId: 'free',
    title: 'Weekly review, {{date}}',
    body: '<h2>What went well</h2><p><br></p><h2>What didn\'t</h2><p><br></p><h2>What I learned</h2><p><br></p><h2>Next week\'s focus</h2>'
      + checks('', '', ''),
  }),
  builtin({
    id: 'tpl-lecture-note',
    name: 'Lecture note',
    icon: '🎓',
    typeId: 'course',
    title: '',
    body: '<h2>Main ideas</h2><p><br></p><h2>Examples</h2><p><br></p><h2>To look up</h2>' + checks(''),
  }),
  builtin({
    id: 'tpl-project-plan',
    name: 'Project plan',
    icon: '🧭',
    typeId: 'free',
    title: 'Project: ',
    body: '<h2>Goal</h2><p>What does done look like?</p><h2>Why it matters</h2><p><br></p><h2>Milestones</h2>'
      + checks('', '', '') + '<h2>Risks</h2><ul><li><br></li></ul><h2>Next step</h2><p><br></p>',
  }),
  builtin({
    id: 'tpl-movie-night',
    name: 'Movie night',
    icon: '🍿',
    typeId: 'checklist',
    title: 'Movie night, {{date}}',
    body: '<h2>What we watched</h2><p><br></p><h2>Verdict</h2><p><br></p>',
    fields: {
      items: [
        { text: 'Pick a movie' },
        { text: 'Snacks' },
        { text: 'Invite people' },
      ],
    },
  }),
]);

/** Fills in the date words in a template's text. */
export function fillPlaceholders(text, now = Date.now()) {
  const date = toDateStr(new Date(now));
  return String(text ?? '')
    .replaceAll('{{date}}', formatDay(date))
    .replaceAll('{{weekday}}', formatDay(date, { weekday: 'long' }));
}

/** Task and card ids must be unique per note, so each use of a template gets new ones. */
function freshFieldValues(type, fields) {
  const values = { ...fields };
  for (const field of type.fields) {
    if (field.kind === 'tasks' && values[field.id]) {
      values[field.id] = normalizeTasks(values[field.id]).map((task) => ({
        ...task, id: uid(), done: false, doneAt: null, children: task.children.map((child) => ({ ...child, id: uid(), done: false, doneAt: null })),
      }));
    } else if (field.kind === 'flashcards' && values[field.id]) {
      values[field.id] = normalizeCards(values[field.id]).map((card) => ({
        ...card, id: uid(), right: 0, wrong: 0, review: false, lastSeen: null,
      }));
    }
  }
  return values;
}

/** What createNote needs to make a note from a template. */
export function notePropsFromTemplate(template, type, now = Date.now()) {
  return {
    title: fillPlaceholders(template.title, now),
    body: fillPlaceholders(template.body, now),
    typeId: template.typeId,
    fields: freshFieldValues(type, template.fields ?? {}),
    tagIds: [...(template.tagIds ?? [])],
    now,
  };
}

/** A template copied from a note. Dates in fields are left out, since they belong to that note. */
export function templateFromNote(note, type, { id = uid(), name, icon, now = Date.now() }) {
  const fields = {};
  for (const field of type.fields) {
    if (field.kind !== 'date' && note.fields?.[field.id] !== undefined) fields[field.id] = note.fields[field.id];
  }
  return {
    id, name, icon: icon ?? type.icon, typeId: note.typeId, title: note.title, body: note.body, fields, tagIds: [...note.tagIds], builtin: false, created: now, updated: now,
  };
}

/** Rebuilds a template from untrusted data. A template can't pretend to be built-in. */
export function cleanTemplate(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128 || typeof raw.name !== 'string') return null;
  if (BUILTIN_TEMPLATES.some((t) => t.id === raw.id)) return null;
  return {
    id: raw.id,
    name: raw.name.slice(0, 120) || 'Untitled template',
    icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 16) : '📄',
    typeId: typeof raw.typeId === 'string' ? raw.typeId : 'free',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
    body: sanitizeHtml(typeof raw.body === 'string' ? raw.body : ''),
    fields: raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) ? raw.fields : {},
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter((id) => typeof id === 'string') : [],
    builtin: false,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}
