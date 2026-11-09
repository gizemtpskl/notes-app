/**
 * tidy.js: rules for the tidy-up assistant. Pure: nothing here changes a note.
 */
import { DAY_MS } from './schema.js';
import { fold } from './text.js';
import { isBlankNote } from './types.js';

const MIN_NEAR_LENGTH = 6;
const BLOCK_LIMIT = 300;

/** Edit distance, stopping early once it is past the limit. */
export function editDistance(a, b, limit = Infinity) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < smallest) smallest = value;
    }
    if (smallest > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

const titleKey = (title) => fold(title).replace(/[^\p{L}\p{N}]+/gu, '');
const digitsOf = (key) => key.replace(/\D+/g, '');

/**
 * Whether two cleaned titles look like the same thing. Numbers have to match, so "Lecture 3" and
 * "Lecture 4" are not duplicates, and small differences only count in longer titles.
 */
export function titlesLookAlike(a, b) {
  if (a === b) return a.length > 0;
  if (Math.min(a.length, b.length) < MIN_NEAR_LENGTH) return false;
  if (digitsOf(a) !== digitsOf(b)) return false;
  const limit = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.12));
  return editDistance(a, b, limit) <= limit;
}

/**
 * Groups notes with near-identical titles, newest first in each group. Only titles sharing their
 * first or last few letters are compared, so this stays fast with thousands of notes. Titles a
 * type makes by itself, such as a journal entry's date, are left out.
 */
export function findDuplicateGroups(notes, getType) {
  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    // Shortens the path for next time.
    let node = id;
    while (parent.get(node) !== root) {
      const up = parent.get(node);
      parent.set(node, root);
      node = up;
    }
    return root;
  };
  const union = (a, b) => parent.set(find(a), find(b));

  const entries = [];
  const blocks = new Map();
  const addTo = (key, entry) => {
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(entry);
  };
  for (const note of notes) {
    const key = titleKey(note.title);
    if (key.length >= 2 && !getType(note.typeId).autoTitle) {
      const entry = { note, key };
      entries.push(entry);
      parent.set(note.id, note.id);
      addTo(`s:${key.slice(0, 4)}`, entry);
      addTo(`e:${key.slice(-4)}`, entry);
    }
  }
  for (const block of blocks.values()) {
    if (block.length > 1 && block.length <= BLOCK_LIMIT) {
      for (let i = 0; i < block.length; i += 1) {
        for (let j = i + 1; j < block.length; j += 1) {
          if (titlesLookAlike(block[i].key, block[j].key)) union(block[i].note.id, block[j].note.id);
        }
      }
    } else if (block.length > BLOCK_LIMIT) {
      // A huge block is usually one repeated title, so exact matches still group cheaply.
      const exact = new Map();
      for (const entry of block) {
        if (exact.has(entry.key)) union(entry.note.id, exact.get(entry.key));
        else exact.set(entry.key, entry.note.id);
      }
    }
  }
  const groups = new Map();
  for (const { note } of entries) {
    const root = find(note.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(note);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((a, b) => b.updated - a.updated))
    .sort((a, b) => b.length - a.length);
}

export function findEmptyNotes(notes, getType) {
  return notes.filter((note) => isBlankNote(note, getType(note.typeId)));
}

/** Notes not opened for a long time. Pinned and favorite notes are clearly wanted, so they stay out. */
export function findStaleNotes(notes, days, now = Date.now()) {
  const cutoff = now - days * DAY_MS;
  return notes
    .filter((note) => !note.pinned && !note.favorite && (note.opened ?? note.updated) < cutoff)
    .sort((a, b) => (a.opened ?? a.updated) - (b.opened ?? b.updated));
}
