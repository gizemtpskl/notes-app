/**
 * schema.js: the single data model.
 *
 *   Space ──< Collection ──< Collection (one nested level only)
 *     │            │
 *     └────────────┴──< Note >── NoteType (decides fields and views)
 *                        │
 *                        ├── tagIds  ──> Tag
 *                        ├── links   ──> Note
 *                        └── versions (last 20, stored apart)
 *
 *   SavedView  a filter, sort and grouping over notes
 *   Template   a starting point for new notes
 *   TimeBlock  a block in the weekly timetable, once or repeating, optionally in a Semester.
 *              See timetable.js for both records and how repeats work.
 *   Habit      a daily habit and the days it was done. See habits.js.
 *   FocusSession  time spent with the focus timer. See focus.js.
 *
 * The four organizing layers stay independent:
 *   1. Space       broad area of life. A note has exactly one, or none while in the Inbox.
 *   2. Collection  project, list or notebook. A note has at most one.
 *   3. NoteType    what kind of note it is. Built-ins and custom types share one mechanism:
 *                  see types.js for definitions and fieldKinds.js for what fields can hold.
 *   4. Tags/links  cross-cutting, never affect where a note lives.
 *
 * The Inbox is not a flag: a note is in the Inbox exactly when spaceId === null.
 *
 * TO EXTEND THE MODEL
 *   - New field on an existing record: add it to the create*() factory with a default,
 *     and to the matching clean*() function in porting.js so imports keep it.
 *   - New kind of record: add its store name to STORES and bump DB_VERSION in storage.js.
 *     Stores are created automatically on upgrade.
 *   - Breaking change to the export format: bump SCHEMA_VERSION and migrate in porting.js.
 */

/** Version of the export format. Files with a newer version are refused on import. */
export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'personal-notes-export';

/** All persisted stores. Every record has a string `id`. */
export const STORES = Object.freeze([
  'meta', 'spaces', 'collections', 'noteTypes', 'notes', 'tags', 'savedViews', 'templates', 'assets', 'versions',
  'timeBlocks', 'semesters', 'habits', 'focus',
]);

/** Images and old versions of notes can be large, so they are read on demand instead of being kept in memory. */
export const MEMORY_STORES = Object.freeze(STORES.filter((s) => s !== 'assets' && s !== 'versions'));

/**
 * Twelve warm pastels, named so the theme can give each one a tuned value for light and dark mode.
 * The ids stay as they are once saved; SPACE_COLOR_NAMES is what people see.
 */
export const SPACE_COLORS = Object.freeze(['sage', 'coral', 'amber', 'sky', 'rose', 'plum', 'peach', 'teal', 'clay', 'moss', 'mauve', 'slate']);
export const SPACE_COLOR_NAMES = Object.freeze({
  sage: 'Sage', coral: 'Coral', amber: 'Honey', sky: 'Sky', rose: 'Rose', plum: 'Lavender',
  peach: 'Peach', teal: 'Seafoam', clay: 'Clay', moss: 'Moss', mauve: 'Mauve', slate: 'Stone',
});

/** The built-in spaces' colors before "Peach and sage", and what they are now. */
export const DEFAULT_SPACE_RECOLOR = Object.freeze({
  School: ['sky', 'sage'], Personal: ['sage', 'coral'], Fun: ['plum', 'amber'], Career: ['amber', 'sky'],
});

export const SOFT_MAX_SPACES = 8;
export const TRASH_DAYS = 30;
export const BACKUP_REMINDER_DAYS = 14;
export const BACKUP_SNOOZE_DAYS = 3;
export const MAX_VERSIONS = 20;
export const DAY_MS = 86400000;

/** updated, created, title, due (next open date), or field:<id> for any field's value. */
export function isSortKey(key) {
  return typeof key === 'string' && /^(updated|created|title|opened|due|field:[\w-]+)$/.test(key);
}

export const DEFAULT_TYPE_ID = 'free';

/** Random id. randomUUID only exists in secure contexts, so plain http falls back to getRandomValues. */
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createSpace({ id = uid(), name, icon = '📁', color = 'slate', order = 0, now = Date.now() }) {
  return { id, name: String(name ?? '').trim() || 'Untitled space', icon, color, order, created: now, updated: now };
}

export function createCollection({
  id = uid(), name, spaceId, parentId = null, icon = '', defaultTypeId = DEFAULT_TYPE_ID,
  order = 0, view = { sort: 'updated', dir: 'desc' }, weeklyGoal = 0, now = Date.now(),
}) {
  return {
    id, name: String(name ?? '').trim() || 'Untitled collection', spaceId, parentId, icon,
    defaultTypeId, order, view, weeklyGoal, created: now, updated: now,
  };
}

export function createNote({
  id = uid(), title = '', body = '', text = '', spaceId = null, collectionId = null,
  typeId = DEFAULT_TYPE_ID, fields = {}, tagIds = [], links = [],
  pinned = false, favorite = false, archived = false, private: isPrivate = false, now = Date.now(),
}) {
  return {
    id, title, body, text, spaceId, collectionId, typeId, fields, tagIds, links,
    pinned, favorite, archived, private: isPrivate, trashedAt: null, created: now, updated: now, opened: now,
  };
}

export function cleanTagName(name) {
  return String(name ?? '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function createTag({ id = uid(), name, now = Date.now() }) {
  return { id, name: cleanTagName(name), created: now, updated: now };
}

/** A saved filter, with how to show it. Pinned views appear in the sidebar. */
export function createSavedView({
  id = uid(), name, icon = '🔖', filter, view = { sort: 'updated', dir: 'desc', mode: 'list' }, pinned = true, order = 0, now = Date.now(),
}) {
  return {
    id, name: String(name ?? '').trim() || 'Untitled view', icon, filter, view, pinned, order, created: now, updated: now,
  };
}

/** Plain-English errors for rule violations, safe to show in the UI. */
export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
  }
}
