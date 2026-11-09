/**
 * filing.js: rule-based "where does this note go?" suggestions for Inbox review.
 *
 * Every time a note is filed, its words are counted against the destination. To suggest a
 * destination for a new note, each option scores points for:
 *   - words the note shares with notes filed there before (strongest signal)
 *   - words the note shares with the space or collection name
 *   - how often that destination has been used (weak tie-breaker)
 *
 * The model is a plain object kept in meta, so it is included in exports and stays inspectable.
 */
import { tokenize } from './text.js';

const MAX_TOKENS = 3000;

export function emptyModel() {
  return { totals: {}, tokens: {} };
}

function destinationKey(spaceId, collectionId) {
  return `${spaceId}|${collectionId ?? ''}`;
}

/** Returns a new model that includes this filing decision. */
export function learn(model, note, spaceId, collectionId) {
  const key = destinationKey(spaceId, collectionId);
  const next = {
    totals: { ...model.totals, [key]: (model.totals[key] ?? 0) + 1 },
    tokens: { ...model.tokens },
  };
  for (const token of tokenize(`${note.title} ${note.text}`)) {
    next.tokens[token] = { ...next.tokens[token], [key]: (next.tokens[token]?.[key] ?? 0) + 1 };
  }
  // Keep the model small: when it grows too large, forget words seen only once.
  const names = Object.keys(next.tokens);
  if (names.length > MAX_TOKENS) {
    for (const name of names) {
      const counts = Object.values(next.tokens[name]);
      if (counts.length === 1 && counts[0] === 1) delete next.tokens[name];
    }
  }
  return next;
}

/** Best destinations for a note: [{ spaceId, collectionId, score }], highest score first. */
export function suggest(model, note, spaces, collections, limit = 3) {
  const noteTokens = tokenize(`${note.title} ${note.text}`);
  const scores = new Map();
  const add = (key, points) => {
    if (points > 0) scores.set(key, (scores.get(key) ?? 0) + points);
  };

  for (const token of noteTokens) {
    const seen = model.tokens[token];
    if (seen) for (const [key, count] of Object.entries(seen)) add(key, 3 * count);
  }
  const wanted = new Set(noteTokens);
  const nameScore = (name) => tokenize(name).filter((t) => wanted.has(t)).length * 4;
  for (const space of spaces) add(destinationKey(space.id, null), nameScore(space.name));
  for (const col of collections) add(destinationKey(col.spaceId, col.id), nameScore(col.name));
  for (const [key, count] of Object.entries(model.totals)) add(key, Math.min(count, 10) * 0.2);

  const spaceIds = new Set(spaces.map((s) => s.id));
  const byId = new Map(collections.map((c) => [c.id, c]));
  return [...scores.entries()]
    .map(([key, score]) => {
      const [spaceId, collectionId] = key.split('|');
      return { spaceId, collectionId: collectionId || null, score };
    })
    // Learned destinations may point at spaces or collections that were deleted since.
    .filter((s) => spaceIds.has(s.spaceId) && (!s.collectionId || byId.get(s.collectionId)?.spaceId === s.spaceId))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
