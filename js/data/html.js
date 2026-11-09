/**
 * html.js: note bodies are stored as sanitized HTML. This is the only place that defines
 * which markup is allowed, and it converts bodies to plain text and Markdown.
 *
 * Allowed output:
 *   Blocks  p h1 h2 h3 blockquote pre ul ol li hr table tbody tr th td
 *   Inline  strong em u s code a br img span[data-math]
 *   Attrs   a[href rel target]  img[data-asset alt]  ul[data-type=check]  li[data-checked]
 *           th/td[colspan rowspan]  pre[data-lang]  span[data-math data-display]
 *
 * Images always point to the local assets store through data-asset. Remote images are turned
 * into plain links, so opening a note can never trigger a network request.
 */

const DROPPED = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM',
  'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'HEAD', 'TITLE', 'VIDEO', 'AUDIO',
  'CANVAS', 'BASE', 'FRAME', 'FRAMESET', 'APPLET', 'MAP', 'AREA',
]);
const HEADINGS = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3' };
const CONTAINERS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'FIGURE', 'FIGCAPTION',
  'CENTER', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD', 'ADDRESS', 'BODY',
]);
const BLOCKS = new Set([
  'P', ...Object.keys(HEADINGS), 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'HR', 'TABLE', ...CONTAINERS,
]);
const MARKS = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', KBD: 'code', TT: 'code', SAMP: 'code' };
const MAX_DEPTH = 64;
const MAX_MATH_LENGTH = 5000;
const ZERO_WIDTH = /[​﻿]/g;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Returns a safe URL, or null. Bare domains get https://. Script-like schemes are refused. */
export function safeUrl(value) {
  // Browsers ignore control characters and whitespace inside schemes, so remove them before checking.
  const url = String(value ?? '').replace(/[\u0000- \u007f]+/g, '');
  if (!url) return null;
  if (/^#\/[\w/-]*$/.test(url)) return url; // link to a note inside this app
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(url)) return `https://${url}`;
  return null;
}

function parse(html) {
  return new DOMParser().parseFromString(String(html ?? ''), 'text/html');
}

/** SVG and MathML elements have lowercase tag names, so they are dropped by namespace instead. */
function isDropped(el) {
  return el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROPPED.has(el.tagName);
}

function isBlock(node) {
  return node.nodeType === 1 && BLOCKS.has(node.tagName);
}

function hasBlockChild(node) {
  for (const child of node.childNodes) if (isBlock(child)) return true;
  return false;
}

function escapeText(value) {
  return escapeHtml(value.replace(ZERO_WIDTH, ''));
}

/** Inline content of a node. Blocks found in inline position collapse to their text plus a line break. */
function renderInline(parent, depth) {
  if (depth > MAX_DEPTH) return escapeText(parent.textContent ?? '');
  let out = '';
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      out += escapeText(node.nodeValue);
    } else if (node.nodeType === 1 && !isDropped(node)) {
      out += renderInlineElement(node, depth + 1);
    }
  }
  return out;
}

function renderInlineElement(el, depth) {
  const tag = el.tagName;
  if (tag === 'BR') return '<br>';
  if (tag === 'IMG') return renderImage(el);
  if (tag === 'SPAN' && el.hasAttribute('data-math')) return renderMath(el);
  if (tag === 'A') {
    const inner = renderInline(el, depth);
    const href = safeUrl(el.getAttribute('href'));
    if (!href || !inner) return inner;
    const external = /^https?:/i.test(href);
    return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${inner}</a>`;
  }
  if (MARKS[tag]) {
    const inner = renderInline(el, depth);
    // Google Docs wraps entire pastes in <b style="font-weight:normal">, which is not bold.
    if (tag === 'B' && /font-weight:\s*(normal|[1-5]00)/i.test(el.getAttribute('style') ?? '')) return inner;
    return inner ? `<${MARKS[tag]}>${inner}</${MARKS[tag]}>` : '';
  }
  if (isBlock(el)) {
    const inner = renderInline(el, depth);
    return inner && !inner.endsWith('<br>') && el.nextSibling ? `${inner}<br>` : inner;
  }
  // Spans and unknown elements are unwrapped. Bold and italic set through styles survive pasting.
  let inner = renderInline(el, depth);
  const style = el.getAttribute('style') ?? '';
  if (inner && /font-weight:\s*(bold|[6-9]00)/i.test(style)) inner = `<strong>${inner}</strong>`;
  if (inner && /font-style:\s*italic/i.test(style)) inner = `<em>${inner}</em>`;
  if (inner && /text-decoration[^;]*line-through/i.test(style)) inner = `<s>${inner}</s>`;
  return inner;
}

/**
 * A formula keeps its LaTeX in an attribute, and as plain text so it stays searchable and readable
 * wherever math isn't drawn. Whatever was drawn inside is discarded here.
 */
function renderMath(el) {
  const source = (el.getAttribute('data-math') ?? '').slice(0, MAX_MATH_LENGTH).replace(ZERO_WIDTH, '');
  if (!source.trim()) return '';
  const display = el.getAttribute('data-display') === 'true' ? ' data-display="true"' : '';
  return `<span data-math="${escapeHtml(source)}"${display}>${escapeHtml(source)}</span>`;
}

function renderImage(el) {
  const asset = el.getAttribute('data-asset');
  const alt = escapeHtml(el.getAttribute('alt') ?? '');
  if (asset && /^[\w-]+$/.test(asset)) return `<img data-asset="${asset}" alt="${alt}">`;
  const src = el.getAttribute('src') ?? '';
  if (/^https?:/i.test(src)) return `<a href="${escapeHtml(src)}" rel="noopener noreferrer" target="_blank">${alt || 'Image link'}</a>`;
  return alt;
}

function renderPre(el) {
  const copy = el.cloneNode(true);
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  // Block children such as <div> mean one line each in code pasted from web editors.
  for (const line of copy.querySelectorAll('div, p')) {
    if (line.nextSibling) line.append('\n');
  }
  const text = copy.textContent.replace(ZERO_WIDTH, '').replace(/\r\n?/g, '\n');
  const lang = el.getAttribute('data-lang') ?? '';
  const attr = /^[\w+#-]{1,20}$/.test(lang) ? ` data-lang="${lang}"` : '';
  return `<pre${attr}>${escapeHtml(text) || '\n'}</pre>`;
}

function renderListItem(li, checklist, depth) {
  let content = '';
  let hasCheck = checklist;
  for (const node of li.childNodes) {
    if (node.nodeType === 3) {
      content += escapeText(node.nodeValue);
    } else if (node.nodeType === 1 && !isDropped(node)) {
      if (node.tagName === 'UL' || node.tagName === 'OL') {
        content = content.replace(/(<br>|\s)+$/, '');
        content += renderList(node, depth + 1);
      } else if (isBlock(node)) {
        const inner = renderInline(node, depth + 1);
        content += inner && node.nextElementSibling && !/^(UL|OL)$/.test(node.nextElementSibling.tagName) ? `${inner}<br>` : inner;
      } else {
        content += renderInlineElement(node, depth + 1);
      }
    }
  }
  const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
  if (box) hasCheck = true;
  const checked = li.getAttribute('data-checked') === 'true' || box?.hasAttribute('checked');
  const attr = hasCheck ? ` data-checked="${checked ? 'true' : 'false'}"` : '';
  return { html: `<li${attr}>${content.trim() ? content.trimStart() : '<br>'}</li>`, hasCheck };
}

function renderList(el, depth) {
  if (depth > MAX_DEPTH) return `<p>${escapeText(el.textContent ?? '')}</p>`;
  const tag = el.tagName === 'OL' ? 'ol' : 'ul';
  const declared = tag === 'ul' && el.getAttribute('data-type') === 'check';
  let items = '';
  let anyCheck = declared;
  for (const child of el.childNodes) {
    if (child.nodeType === 1 && child.tagName === 'LI') {
      const { html, hasCheck } = renderListItem(child, declared, depth);
      items += html;
      anyCheck ||= hasCheck;
    } else if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
      items += `<li>${renderList(child, depth + 1)}</li>`;
    } else if (child.nodeType === 3 ? child.nodeValue.trim() : child.nodeType === 1 && !isDropped(child)) {
      const inner = child.nodeType === 3 ? escapeText(child.nodeValue.trim()) : renderInlineElement(child, depth + 1);
      if (inner) items += `<li${declared ? ' data-checked="false"' : ''}>${inner}</li>`;
    }
  }
  if (!items) return '';
  // Items from pasted task lists can be mixed. A check list treats them all as tasks.
  if (anyCheck && !declared && tag === 'ul') {
    items = items.replace(/<li>/g, '<li data-checked="false">');
  }
  return `<${tag}${anyCheck && tag === 'ul' ? ' data-type="check"' : ''}>${items}</${tag}>`;
}

function renderTable(el) {
  let rows = '';
  for (const row of el.rows) {
    let cells = '';
    for (const cell of row.cells) {
      const tag = cell.tagName === 'TH' ? 'th' : 'td';
      const span = ['colspan', 'rowspan'].map((name) => {
        const value = parseInt(cell.getAttribute(name) ?? '', 10);
        return value > 1 && value < 100 ? ` ${name}="${value}"` : '';
      }).join('');
      cells += `<${tag}${span}>${renderInline(cell, 1) || '<br>'}</${tag}>`;
    }
    if (cells) rows += `<tr>${cells}</tr>`;
  }
  return rows ? `<table><tbody>${rows}</tbody></table>` : '';
}

function renderBlock(el, depth) {
  const tag = el.tagName;
  if (HEADINGS[tag]) {
    const inner = renderInline(el, depth);
    return `<${HEADINGS[tag]}>${inner || '<br>'}</${HEADINGS[tag]}>`;
  }
  if (tag === 'PRE') return renderPre(el);
  if (tag === 'HR') return '<hr>';
  if (tag === 'UL' || tag === 'OL') return renderList(el, depth);
  if (tag === 'TABLE') return renderTable(el);
  if (tag === 'BLOCKQUOTE') {
    const inner = renderBlocks(el, depth + 1);
    return inner ? `<blockquote>${inner}</blockquote>` : '';
  }
  if (tag === 'LI') return renderList(Object.assign(el.ownerDocument.createElement('ul'), { innerHTML: el.outerHTML }), depth);
  if (hasBlockChild(el)) return renderBlocks(el, depth + 1);
  const inner = renderInline(el, depth);
  return inner.replace(/<br>$/, '').trim() || inner.includes('<img') ? `<p>${inner}</p>` : '<p><br></p>';
}

function renderBlocks(parent, depth) {
  if (depth > MAX_DEPTH) return `<p>${escapeText(parent.textContent ?? '')}</p>`;
  let out = '';
  let run = '';
  const flushRun = () => {
    const meaningful = run.replace(/\s+/g, '');
    if (meaningful) out += `<p>${run.trim().replace(/<br>$/, '') || '<br>'}</p>`;
    run = '';
  };
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      run += escapeText(node.nodeValue);
    } else if (node.nodeType === 1 && !isDropped(node)) {
      if (isBlock(node)) {
        flushRun();
        out += renderBlock(node, depth + 1);
      } else {
        run += renderInlineElement(node, depth + 1);
      }
    }
  }
  flushRun();
  return out;
}

/**
 * Removes everything outside the allowlist and normalizes browser-specific markup.
 * The input is parsed with DOMParser, which never runs scripts or loads resources.
 */
export function sanitizeHtml(input) {
  if (!input) return '';
  const html = renderBlocks(parse(input).body, 0);
  return html.replace(/(<p><br><\/p>)+$/, '');
}

/** Plain text of a body, used for previews, word counts and search. */
export function htmlToText(html) {
  if (!html) return '';
  const body = parse(html).body;
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue);
      } else if (child.nodeType === 1 && !isDropped(child)) {
        if (child.tagName === 'BR') {
          parts.push('\n');
        } else if (child.tagName === 'IMG') {
          if (child.alt) parts.push(child.alt);
        } else if (child.tagName === 'TD' || child.tagName === 'TH') {
          walk(child);
          parts.push('\t');
        } else if (isBlock(child) || child.tagName === 'TR') {
          parts.push('\n');
          walk(child);
          parts.push('\n');
        } else {
          walk(child);
        }
      }
    }
  };
  walk(body);
  return parts.join('').replace(ZERO_WIDTH, '').replace(/[ \t]*\n[ \t\n]*/g, '\n').trim();
}

/** True when a body has no text and no visual content. */
export function isBodyEmpty(html) {
  if (!html) return true;
  if (/<(img|hr|table)\b/i.test(html)) return false;
  return !htmlToText(html);
}

/** Plain text to safe paragraphs. */
export function textToHtml(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

/** Asset ids referenced by a body. Uses a regex because garbage collection scans every note. */
export function assetIds(html) {
  return [...String(html ?? '').matchAll(/data-asset="([\w-]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------------------

export function escapeMd(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]])/g, '\\$1')
    .replace(/(^|[\s(])_/g, '$1\\_');
}

function inlineMd(node, ctx) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += escapeMd(child.nodeValue);
    } else if (child.nodeType === 1) {
      const inner = () => inlineMd(child, ctx);
      switch (child.tagName) {
        case 'BR': out += '  \n'; break;
        case 'STRONG': out += `**${inner()}**`; break;
        case 'EM': out += `*${inner()}*`; break;
        case 'S': out += `~~${inner()}~~`; break;
        case 'U': out += `<u>${inner()}</u>`; break;
        case 'SPAN': {
          if (child.hasAttribute('data-math')) {
            const math = child.getAttribute('data-math');
            out += child.getAttribute('data-display') === 'true' ? `$$${math}$$` : `$${math}$`;
          } else {
            out += inner();
          }
          break;
        }
        case 'CODE': {
          const code = child.textContent;
          const fence = code.includes('`') ? '``' : '`';
          out += `${fence}${code}${fence}`;
          break;
        }
        case 'A': {
          const href = child.getAttribute('href') ?? '';
          // A link to another note reads as a wiki link in other Markdown tools.
          out += href.startsWith('#/note/') ? `[[${inner()}]]` : `[${inner()}](${href})`;
          break;
        }
        case 'IMG': {
          const id = child.getAttribute('data-asset');
          out += `![${escapeMd(child.getAttribute('alt') ?? '')}](${ctx.imageSrc ? ctx.imageSrc(id) : id})`;
          break;
        }
        case 'UL': case 'OL': break; // written as a nested list by listMd
        default: out += inner();
      }
    }
  }
  return out;
}

function listMd(list, ctx, indent) {
  const lines = [];
  let index = 1;
  for (const li of list.children) {
    let marker = '- ';
    if (list.tagName === 'OL') marker = `${index}. `;
    else if (li.hasAttribute('data-checked')) marker = `- [${li.getAttribute('data-checked') === 'true' ? 'x' : ' '}] `;
    index += 1;
    const text = inlineMd(li, ctx).trim().replace(/ {2}\n/g, `  \n${indent}  `);
    lines.push(`${indent}${marker}${text}`);
    for (const nested of li.querySelectorAll(':scope > ul, :scope > ol')) {
      lines.push(listMd(nested, ctx, `${indent}  `));
    }
  }
  return lines.join('\n');
}

function tableMd(table, ctx) {
  const rows = [...table.rows].map((row) => [...row.cells].map((cell) => inlineMd(cell, ctx).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [head, ...rest] = rows;
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...rest.map(line)].join('\n');
}

function blocksMd(parent, ctx) {
  const parts = [];
  for (const el of parent.children) {
    switch (el.tagName) {
      case 'H1': parts.push(`# ${inlineMd(el, ctx)}`); break;
      case 'H2': parts.push(`## ${inlineMd(el, ctx)}`); break;
      case 'H3': parts.push(`### ${inlineMd(el, ctx)}`); break;
      case 'P': {
        const text = inlineMd(el, ctx).trim();
        if (text) parts.push(text);
        break;
      }
      case 'BLOCKQUOTE': parts.push(blocksMd(el, ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')); break;
      case 'PRE': {
        const code = el.textContent.replace(/\n$/, '');
        const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
        const fence = '`'.repeat(longest + 1);
        parts.push(`${fence}${el.getAttribute('data-lang') ?? ''}\n${code}\n${fence}`);
        break;
      }
      case 'UL': case 'OL': parts.push(listMd(el, ctx, '')); break;
      case 'TABLE': parts.push(tableMd(el, ctx)); break;
      case 'HR': parts.push('---'); break;
      default: {
        const text = inlineMd(el, ctx).trim();
        if (text) parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}

/** imageSrc maps an asset id to the path used in the Markdown image syntax. */
export function htmlToMarkdown(html, { imageSrc } = {}) {
  if (!html) return '';
  return blocksMd(parse(html).body, { imageSrc });
}
