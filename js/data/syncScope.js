/**
 * syncScope.js: which records sync between devices. Kept apart from sync.js so the data layer
 * can ask without loading the rest of sync.
 *
 * Everything you make syncs. Left out: built-in note types (they're in the code), images and
 * old versions (stored apart, and images sync as files of their own), and device settings such
 * as the passcode lock, Google sign-in details and what was shown when.
 */
export const SYNC_STORES = Object.freeze([
  'spaces', 'collections', 'noteTypes', 'notes', 'tags', 'savedViews', 'templates', 'timeBlocks', 'semesters', 'habits',
]);

/** The meta records that sync: your settings and what filing has learned. */
export const SYNC_META = Object.freeze(['settings', 'filing']);

export function syncsRecord(store, record) {
  if (store === 'meta') return SYNC_META.includes(record?.id);
  return SYNC_STORES.includes(store) && !record?.builtin;
}
