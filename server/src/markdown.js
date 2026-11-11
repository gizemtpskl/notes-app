/**
 * markdown.js: text Claude writes, in simple Markdown, as note HTML. Only what the editor has:
 * headings, paragraphs, bullet, numbered and check lists, quotes, bold, italic, code and links.
 * The result is cleaned again by sanitizeHtml, here and on every device it reaches.
 */
import { escapeHtml, safeUrl } from '../../js/data/html.js';

function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safe = safeUrl(url.replace(/&amp;/g, '&'));
    return safe ? `<a href="${escapeHtml(safe)}">${label}</a>` : label;
  });
  return html;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;

/** Markdown text as HTML. */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      let checks = false;
      while (i < lines.length && LIST.test(lines[i])) {
        const [, , , box, text] = lines[i].match(LIST);
        if (box) checks = true;
        items.push({ box, text });
        i += 1;
      }
      const tag = ordered && !checks ? 'ol' : 'ul';
      const lis = items.map(({ box, text }) => (checks
        ? `<li data-checked="${box && /x/i.test(box) ? 'true' : 'false'}">${inline(text)}</li>`
        : `<li>${inline(text)}</li>`)).join('');
      out.push(`<${tag}${checks ? ' data-type="check"' : ''}>${lis}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(inline(lines[i].replace(/^>\s?/, '')));
        i += 1;
      }
      out.push(`<blockquote><p>${quoted.join('<br>')}</p></blockquote>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,3})\s/.test(lines[i]) && !/^>\s?/.test(lines[i])) {
      paragraph.push(inline(lines[i]));
      i += 1;
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return out.join('');
}
