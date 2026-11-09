/**
 * text.js: small text helpers shared by the data layer.
 */

/**
 * Case- and accent-insensitive form for comparisons. Turkish dotted and dotless i are mapped
 * to plain i first, because toLowerCase alone leaves them different from each other.
 */
export function fold(value) {
  return String(value ?? '')
    .replace(/[İIı]/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'are', 'but', 'not',
  'you', 'your', 'about', 'into', 'what', 'when', 'where', 'which', 'will', 'would', 'should', 'could',
  'can', 'all', 'out', 'one', 'some', 'just', 'like', 'them', 'then', 'there', 'they', 'their',
]);

/** Distinct meaningful words, used for filing suggestions. */
export function tokenize(value, limit = 40) {
  const words = fold(value).match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];
  const seen = new Set();
  for (const word of words) {
    if (!STOP_WORDS.has(word)) seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** One-line preview: collapses whitespace and cuts at a word boundary where possible. */
export function snippet(text, max = 140) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Splits quick-capture text into a title and a body.
 * Line 1 becomes the title. A single long line is kept whole in the body as well.
 */
export function splitCapture(raw) {
  const value = String(raw ?? '').trim();
  const newline = value.indexOf('\n');
  const first = newline === -1 ? value : value.slice(0, newline).trim();
  const rest = newline === -1 ? '' : value.slice(newline + 1).trim();
  if (first.length <= 90) return { title: first, bodyText: rest };
  return { title: snippet(first, 70), bodyText: value };
}

/** Removes characters that are unsafe in file names on common systems, keeping letters of any alphabet. */
export function safeFileName(value, fallback = 'Untitled') {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}
