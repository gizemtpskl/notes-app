/**
 * search.js: full-text search over titles, bodies, fields and tags.
 *
 * Records are immutable, so the folded (lower case, no accents) text of a note is cached against
 * the record itself. Only notes changed since the last search are folded again, which keeps
 * typing in the search box instant with thousands of notes.
 *
 * All words must match, in any order. Better places score higher: title, then tags, fields, body.
 *
 * Query syntax, besides plain words:
 *   "exact phrase"   tag:name   type:journal   in:school   before:2026-01-31   after:2026-01-01
 *   is:archived   is:private   is:pinned   is:favorite
 */
import { isDateStr, toDateStr } from './dates.js';
import { fieldValue, valueToText } from './fieldKinds.js';
import { fold } from './text.js';

const SEARCHED_KINDS = new Set(['text', 'longtext', 'select', 'multiselect', 'url', 'tasks', 'flashcards']);
const OPERATOR = /^(tag|type|in|before|after|is):(.*)$/i;
const SNIPPET_LENGTH = 170;
const LEAD_IN = 50;

const docs = new WeakMap();

/** The folded text of a note. A changed type means its field text has to be read again. */
function docFor(note, type) {
  let doc = docs.get(note);
  if (!doc || doc.type !== type) {
    const fields = [];
    for (const field of type.fields) {
      if (SEARCHED_KINDS.has(field.kind)) {
        const raw = valueToText(field, fieldValue(note, field));
        if (raw) fields.push({ field, raw, folded: fold(raw) });
      }
    }
    doc = {
      type, title: fold(note.title), body: fold(note.text), fields,
    };
    docs.set(note, doc);
  }
  return doc;
}

/** Splits a query into words, quoted phrases and operators. */
export function parseQuery(raw) {
  const parsed = {
    terms: [], tags: [], types: [], places: [], before: '', after: '', flags: new Set(),
  };
  const parts = String(raw ?? '').match(/"[^"]*"?|\S+/g) ?? [];
  for (const part of parts) {
    const match = part.match(OPERATOR);
    if (match && match[2]) {
      const value = match[2].replace(/^"|"$/g, '');
      const op = match[1].toLowerCase();
      if (op === 'tag') parsed.tags.push(fold(value));
      else if (op === 'type') parsed.types.push(fold(value));
      else if (op === 'in') parsed.places.push(fold(value));
      else if (op === 'before' && isDateStr(value)) parsed.before = value;
      else if (op === 'after' && isDateStr(value)) parsed.after = value;
      else if (op === 'is') parsed.flags.add(value.toLowerCase());
      else parsed.terms.push(fold(part));
    } else {
      const term = fold(part.replace(/^"|"$/g, '')).trim();
      if (term) parsed.terms.push(term);
    }
  }
  return parsed;
}

const isWordStart = (text, at) => at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);

/** How well a term fits a note, and where. Returns null when it isn't there at all. */
function scoreTerm(term, doc, tagNames) {
  const inTitle = doc.title.indexOf(term);
  if (inTitle !== -1) {
    let score = 25;
    if (doc.title === term) score = 100;
    else if (inTitle === 0) score = 60;
    else if (isWordStart(doc.title, inTitle)) score = 40;
    return { score, where: 'title' };
  }
  if (tagNames.some((name) => name.includes(term))) return { score: 20, where: 'tag' };
  for (const entry of doc.fields) {
    const at = entry.folded.indexOf(term);
    if (at !== -1) return { score: isWordStart(entry.folded, at) ? 15 : 10, where: 'field', entry, at };
  }
  const at = doc.body.indexOf(term);
  if (at !== -1) return { score: isWordStart(doc.body, at) ? 8 : 5, where: 'body', at };
  return null;
}

/** Folds text one character at a time, remembering where each folded character came from. */
function foldWithMap(text) {
  let folded = '';
  const map = [];
  let index = 0;
  for (const char of text) {
    const piece = fold(char);
    for (let i = 0; i < piece.length; i += 1) map.push(index);
    folded += piece;
    index += char.length;
  }
  map.push(index);
  return { folded, map };
}

/** Where the terms appear in a piece of original text: [[start, end], ...], sorted and merged. */
export function findRanges(text, terms) {
  if (!terms.length || !text) return [];
  const { folded, map } = foldWithMap(text);
  const ranges = [];
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      ranges.push([map[at], map[at + term.length]]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * A short piece of text around a match. `at` is the match's position in the folded text, which
 * lines up with the original for almost all writing. If it doesn't, the piece is still useful,
 * only without a highlight.
 */
export function buildSnippet(text, terms, at = 0) {
  const flat = String(text ?? '');
  let start = Math.max(0, at - LEAD_IN);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space !== -1 && space < at) start = space + 1;
  }
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  const piece = flat.slice(start, end).replace(/\s/g, ' ');
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return {
    text: `${prefix}${piece}${suffix}`,
    ranges: findRanges(piece, terms).map(([from, to]) => [from + prefix.length, to + prefix.length]),
  };
}

/** Plain-language names for the operators, resolved to ids. An unknown name matches nothing. */
function resolveOperators(db, parsed) {
  const matching = (list, wanted, name) => list.filter((item) => wanted.every((w) => fold(name(item)).includes(w)));
  const tags = parsed.tags.length ? parsed.tags.map((wanted) => new Set(db.listTags().filter((t) => fold(t.name).includes(wanted)).map((t) => t.id))) : null;
  const types = parsed.types.length
    ? new Set(matching(db.listTypes(), parsed.types, (t) => `${t.id} ${t.name}`).map((t) => t.id))
    : null;
  let spaces = null;
  let collections = null;
  if (parsed.places.length) {
    spaces = new Set(matching(db.listSpaces(), parsed.places, (s) => s.name).map((s) => s.id));
    collections = new Set();
    for (const col of matching(db.allCollections(), parsed.places, (c) => c.name)) {
      collections.add(col.id);
      for (const child of db.listCollections(col.spaceId, col.id)) collections.add(child.id);
    }
  }
  return {
    tags, types, spaces, collections,
  };
}

/**
 * Searches. options narrow the results further, for the filter controls on the search page:
 *   spaceId, collectionId, typeId, tagId, from, to (dates, on when the note was last changed)
 *   status          'active' | 'archived' | 'all'
 *   includePrivate  journal entries and other private notes stay out unless this is true,
 *                   or the query asks for them with is:private or type:
 *   limit           maximum results
 * Returns [{ note, score, where, fieldName, snippet }], best first.
 */
export function searchNotes(db, query, {
  spaceId, collectionId, typeId, tagId, from, to, status = 'active', includePrivate = false, limit = 50,
} = {}) {
  const parsed = parseQuery(query);
  const { terms, flags } = parsed;
  const resolved = resolveOperators(db, parsed);
  const hasOperator = resolved.tags || resolved.types || resolved.spaces || parsed.before || parsed.after || flags.size;
  const hasNarrowing = spaceId || collectionId || typeId || tagId || from || to || status !== 'active';
  if (!terms.length && !hasOperator && !hasNarrowing) return [];

  const wantsArchived = flags.has('archived');
  const seesPrivate = includePrivate || flags.has('private') || Boolean(resolved.types) || (typeId && db.getType(typeId).privateByDefault);
  const collectionIds = collectionId ? new Set([collectionId, ...db.allCollections().filter((c) => c.parentId === collectionId).map((c) => c.id)]) : null;
  const tagName = new Map();
  for (const tag of db.data.tags.values()) tagName.set(tag.id, fold(tag.name));

  const results = [];
  for (const note of db.data.notes.values()) {
    if (note.trashedAt) continue;
    if (wantsArchived ? !note.archived : (status === 'active' && note.archived) || (status === 'archived' && !note.archived)) continue;
    if (note.private && !seesPrivate) continue;
    if (flags.has('private') && !note.private) continue;
    if (flags.has('pinned') && !note.pinned) continue;
    if (flags.has('favorite') && !note.favorite) continue;
    if (spaceId && note.spaceId !== spaceId) continue;
    if (collectionIds && !collectionIds.has(note.collectionId)) continue;
    if (typeId && note.typeId !== typeId) continue;
    if (tagId && !note.tagIds.includes(tagId)) continue;
    if (resolved.types && !resolved.types.has(note.typeId)) continue;
    if (resolved.tags && !resolved.tags.every((ids) => note.tagIds.some((id) => ids.has(id)))) continue;
    if (resolved.spaces && !resolved.spaces.has(note.spaceId) && !resolved.collections.has(note.collectionId)) continue;

    if (from || to || parsed.before || parsed.after) {
      const changed = toDateStr(new Date(note.updated));
      if ((from && changed < from) || (to && changed > to)) continue;
      if ((parsed.after && changed <= parsed.after) || (parsed.before && changed >= parsed.before)) continue;
    }

    const type = db.getType(note.typeId);
    const doc = docFor(note, type);
    const names = note.tagIds.map((id) => tagName.get(id)).filter(Boolean);
    let score = 0;
    let best = null;
    let missing = false;
    for (const term of terms) {
      const hit = scoreTerm(term, doc, names);
      if (!hit) {
        missing = true;
        break;
      }
      score += hit.score;
      // The snippet shows the first place outside the title, which the row already shows.
      if (!best && (hit.where === 'body' || hit.where === 'field')) best = hit;
    }
    if (!missing) {
      if (note.pinned) score += 2;
      results.push({ note, score, best });
    }
  }

  results.sort((a, b) => b.score - a.score || b.note.updated - a.note.updated);
  return results.slice(0, limit).map(({ note, score, best }) => {
    let snippet;
    let fieldName = null;
    if (best?.where === 'field') {
      snippet = buildSnippet(best.entry.raw, terms, best.at);
      fieldName = best.entry.field.name;
    } else if (best) {
      snippet = buildSnippet(note.text, terms, best.at);
    } else {
      snippet = buildSnippet(note.text, terms, 0);
    }
    return {
      note, score, where: best?.where ?? (terms.length ? 'title' : 'none'), fieldName, snippet,
    };
  });
}

/** Keeps the last few searches, newest first and without repeats. */
export function rememberSearch(list, query, limit = 8) {
  const clean = query.trim();
  if (!clean) return list;
  return [clean, ...list.filter((item) => item !== clean)].slice(0, limit);
}

/** The words of a query, for highlighting a title. */
export function queryTerms(query) {
  return parseQuery(query).terms;
}
