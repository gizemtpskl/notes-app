/**
 * editor.js: the rich text editor, built on contenteditable.
 *
 * Why document.execCommand: it is deprecated in name, but it is the only API that keeps the
 * browser's native undo stack working, and every browser still ships it. Operations with no
 * command (tables, check list state) change the DOM directly.
 *
 * Features: headings, marks, lists, check lists, quotes, code blocks, tables, images, links,
 * [[wiki links]] to other notes, LaTeX math, colored code, Markdown shortcuts while typing, and a
 * "/" block menu.
 *
 * Usage:
 *   const editor = createEditor({ html, readOnly, onChange, saveImage, loadImage, askLink, searchNotes, createLinkedNote });
 *   searchNotes(query) returns [{ id, title, detail }], createLinkedNote(title) returns { id, title }.
 *   askMath({ source, display, isNew }) resolves with { source, display } or null.
 *   container.append(editor.toolbar, editor.el);
 *   editor.getHtml(); editor.focus(); editor.setHtml(html); editor.destroy();
 */
import { escapeHtml, safeUrl, sanitizeHtml } from '../data/html.js';
import { altName, frameThrottle, h, modKey, modName } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { LANGUAGES, clearHighlight, highlightBlock } from './highlight.js';
import { renderMath } from './math.js';

const ZWSP = '​';

/** Inline Markdown, checked against the text just before the caret after each typed character. */
const INLINE_RULES = [
  { pattern: /(^|[\s(])\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/, tag: 'strong' },
  { pattern: /(^|[\s(])__([^\s_](?:[^_]*[^\s_])?)__$/, tag: 'strong' },
  { pattern: /(^|[\s(])\*([^\s*](?:[^*]*[^\s*])?)\*$/, tag: 'em' },
  { pattern: /(^|[\s(])_([^\s_](?:[^_]*[^\s_])?)_$/, tag: 'em' },
  { pattern: /(^|[\s(])~~([^\s~](?:[^~]*[^\s~])?)~~$/, tag: 's' },
  { pattern: /(^|[\s(])`([^`]+)`$/, tag: 'code' },
];
const LINK_RULE = /(^|[\s(])\[([^\]]+)\]\(([^)\s]+)\)$/;
/** $x^2$ is math, but "$5 and $6" isn't: no space just inside the dollar signs. */
const MATH_RULE = /(^|[\s(])\$([^\s$](?:[^$]*[^\s$])?)\$$/;
const CODE_DELAY_MS = 150;
const BLOCK_TOP_LEVEL = /^(P|H1|H2|H3|UL|OL|BLOCKQUOTE|PRE|TABLE|HR)$/;

export function createEditor({
  html = '', readOnly = false, onChange = () => {}, saveImage, loadImage, askLink, label = 'Note body', searchNotes, createLinkedNote, askMath,
}) {
  document.execCommand('defaultParagraphSeparator', false, 'p');

  const root = h('div', {
    class: 'editor-content',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': label,
    contenteditable: readOnly ? 'false' : 'true',
    spellcheck: 'true',
  });
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1',
  });
  const el = h('div', { class: 'editor' }, root, fileInput);

  let applying = false;
  let releaseTab = false;
  let imageRange = null;

  // -- Selection helpers -----------------------------------------------------------------

  const selection = () => document.getSelection();

  function caretNode() {
    const node = selection()?.anchorNode;
    return node && root.contains(node) ? node : null;
  }

  function closest(selector) {
    const node = caretNode();
    if (!node) return null;
    const start = node.nodeType === 1 ? node : node.parentElement;
    const found = start.closest(selector);
    return found && root.contains(found) ? found : null;
  }

  const currentBlock = () => closest('p, h1, h2, h3, pre, li, td, th');

  /** A range's text with line breaks counted, since Chrome uses <br> for new lines in code blocks. */
  function rangeText(range) {
    const fragment = range.cloneContents();
    for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
    return fragment.textContent.replace(/ /g, ' ').replaceAll(ZWSP, '');
  }

  /** Text between the start of a block and the caret. */
  function textBeforeCaret(block) {
    const range = selection().getRangeAt(0).cloneRange();
    range.setStart(block, 0);
    return rangeText(range);
  }

  function textAfterCaret(block) {
    const range = selection().getRangeAt(0).cloneRange();
    range.setEnd(block, block.childNodes.length);
    return rangeText(range);
  }

  function isCaretAtStart(block) {
    return selection().isCollapsed && textBeforeCaret(block) === '';
  }

  function placeCaret(node, offset = 0) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = selection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function selectRange(startNode, startOffset, endNode, endOffset) {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = selection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const isEmptyBlock = (block) => !block.textContent.replaceAll(ZWSP, '').trim() && !block.querySelector('img');

  function exec(command, value) {
    applying = true;
    try {
      return document.execCommand(command, false, value);
    } finally {
      applying = false;
    }
  }

  const changed = () => {
    if (!readOnly) onChange();
  };

  // -- Structure upkeep ------------------------------------------------------------------

  /** Keeps the document valid after browser edits: no bare text at the root, and a place to type at the end. */
  function normalize() {
    fixTopLevel();
    const last = root.lastElementChild;
    if (!last || /^(PRE|TABLE|HR|BLOCKQUOTE)$/.test(last.tagName)) root.append(h('p', null, h('br')));
    for (const list of root.querySelectorAll('ul[data-type="check"]')) {
      for (const li of list.children) {
        if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
        for (const nested of li.querySelectorAll(':scope > ul')) nested.setAttribute('data-type', 'check');
      }
    }
    root.classList.toggle('is-empty', root.children.length === 1 && root.firstElementChild.tagName === 'P' && isEmptyBlock(root.firstElementChild) && !root.querySelector('[data-math]'));
    drawMath();
  }

  /** Draws formulas that aren't drawn yet. A formula is one unit to the caret: click to edit it. */
  function drawMath() {
    for (const span of root.querySelectorAll('span[data-math]:not([data-drawn])')) {
      span.setAttribute('data-drawn', '1');
      span.setAttribute('contenteditable', 'false');
      span.setAttribute('role', 'img');
      span.setAttribute('aria-label', `Formula: ${span.getAttribute('data-math')}`);
      renderMath(span, span.getAttribute('data-math'), span.getAttribute('data-display') === 'true').catch((error) => {
        // The LaTeX source is still shown, which is better than nothing if the renderer can't load.
        console.warn('Math could not be drawn:', error);
      });
    }
  }

  function mathMarkup(source, display) {
    return `<span data-math="${escapeHtml(source)}"${display ? ' data-display="true"' : ''}>${escapeHtml(source)}</span>`;
  }

  async function insertMath(display = false) {
    if (!askMath) return;
    const sel = selection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const chosen = await askMath({ source: '', display, isNew: true });
    root.focus();
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    if (chosen?.source) {
      exec('insertHTML', `${mathMarkup(chosen.source, chosen.display)}${ZWSP}`);
      afterEdit();
    }
  }

  async function editMath(span) {
    if (!askMath || readOnly) return;
    const chosen = await askMath({ source: span.getAttribute('data-math'), display: span.getAttribute('data-display') === 'true', isNew: false });
    if (!chosen || !span.isConnected) return;
    if (!chosen.source) {
      span.remove();
    } else {
      span.setAttribute('data-math', chosen.source);
      if (chosen.display) span.setAttribute('data-display', 'true');
      else span.removeAttribute('data-display');
      span.removeAttribute('data-drawn');
    }
    afterEdit();
  }

  // -- Code colors -----------------------------------------------------------------------

  let codeTimer = null;

  function colorCode(all = false) {
    clearTimeout(codeTimer);
    if (all) {
      for (const pre of root.querySelectorAll('pre')) highlightBlock(pre);
      return;
    }
    codeTimer = setTimeout(() => {
      const pre = closest('pre');
      if (pre) highlightBlock(pre);
    }, CODE_DELAY_MS);
  }

  /**
   * Repairs what browsers leave at the top level: Chrome's list commands produce <p><ul>...,
   * and text can end up outside any block. Moving nodes loses the caret, so it is restored.
   */
  function fixTopLevel() {
    const needsWork = [...root.childNodes].some((node) => (node.nodeType === 3 ? node.nodeValue.trim() : !BLOCK_TOP_LEVEL.test(node.tagName) || (node.tagName === 'P' && node.querySelector(':scope > ul, :scope > ol, :scope > table, :scope > pre, :scope > blockquote, :scope > h1, :scope > h2, :scope > h3, :scope > hr, :scope > p'))));
    if (!needsWork) return;

    const sel = selection();
    const anchor = sel.isCollapsed && caretNode() ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;

    for (const p of [...root.children]) {
      if (p.tagName === 'P' && p.querySelector(':scope > ul, :scope > ol, :scope > table, :scope > pre, :scope > blockquote, :scope > h1, :scope > h2, :scope > h3, :scope > hr, :scope > p')) {
        p.replaceWith(...p.childNodes);
      } else if (p.tagName === 'DIV') {
        p.replaceWith(h('p', null, ...p.childNodes));
      }
    }
    // Neighbouring loose text and marks belong together in one paragraph.
    let run = null;
    for (const node of [...root.childNodes]) {
      const isBlock = node.nodeType === 1 && BLOCK_TOP_LEVEL.test(node.tagName);
      if (isBlock) {
        run = null;
      } else if (node.nodeType === 3 && !node.nodeValue.trim() && !run) {
        node.remove();
      } else if (node.nodeType === 1 || node.nodeType === 3) {
        if (!run) {
          run = h('p');
          node.before(run);
        }
        run.append(node);
      }
    }
    if (anchor?.node.isConnected && root.contains(anchor.node)) {
      sel.collapse(anchor.node, Math.min(anchor.offset, anchor.node.nodeType === 3 ? anchor.node.length : anchor.node.childNodes.length));
    }
  }

  function setHtml(value) {
    root.innerHTML = sanitizeHtml(value) || '<p><br></p>';
    normalize();
    for (const img of root.querySelectorAll('img[data-asset]')) hydrateImage(img);
    colorCode(true);
  }

  async function hydrateImage(img) {
    if (!loadImage) return;
    try {
      const url = await loadImage(img.getAttribute('data-asset'));
      if (url) img.src = url;
      else img.classList.add('img-missing');
    } catch {
      img.classList.add('img-missing');
    }
  }

  // -- Block commands --------------------------------------------------------------------

  function setBlock(tag) {
    const quote = closest('blockquote');
    if (quote && tag !== 'blockquote') unwrapQuote(quote);
    exec('formatBlock', `<${tag}>`);
    root.focus();
    afterEdit();
  }

  function toggleBlock(tag) {
    const already = closest(tag);
    setBlock(already ? 'p' : tag);
  }

  function toggleQuote() {
    const quote = closest('blockquote');
    if (quote) {
      unwrapQuote(quote);
      afterEdit();
    } else {
      exec('formatBlock', '<blockquote>');
      afterEdit();
    }
  }

  function unwrapQuote(quote) {
    const sel = selection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    for (const node of [...quote.childNodes]) {
      if (node.nodeType === 3 && node.nodeValue.trim()) {
        const p = h('p');
        node.replaceWith(p);
        p.append(node);
      }
    }
    quote.replaceWith(...quote.childNodes);
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  }

  function toggleList(kind) {
    if (closest('h1, h2, h3, pre')) exec('formatBlock', '<p>');
    const list = closest('ul, ol');
    const inCheck = list?.getAttribute('data-type') === 'check';
    if (kind === 'ol') {
      exec('insertOrderedList');
    } else if (kind === 'ul' && inCheck) {
      list.removeAttribute('data-type');
      for (const li of list.children) li.removeAttribute('data-checked');
    } else if (kind === 'check' && list?.tagName === 'UL' && !inCheck) {
      list.setAttribute('data-type', 'check');
    } else if (kind === 'check' && inCheck) {
      exec('insertUnorderedList');
    } else {
      exec('insertUnorderedList');
      if (kind === 'check') closest('ul')?.setAttribute('data-type', 'check');
    }
    afterEdit();
  }

  /** Inserts a block element, replacing the current paragraph when it is empty. */
  function insertBlock(html) {
    const block = closest('p');
    if (block && isEmptyBlock(block)) {
      const range = document.createRange();
      range.selectNode(block);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const host = topLevelOf(caretNode()) ?? root.lastChild;
      const range = document.createRange();
      range.setStartAfter(host);
      range.collapse(true);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    exec('insertHTML', html);
    afterEdit();
  }

  function topLevelOf(node) {
    let current = node;
    while (current && current.parentNode !== root) current = current.parentNode;
    return current;
  }

  function insertTable(rows = 3, cols = 3) {
    const head = `<tr>${'<th><br></th>'.repeat(cols)}</tr>`;
    const row = `<tr>${'<td><br></td>'.repeat(cols)}</tr>`;
    insertBlock(`<table data-new="1"><tbody>${head}${row.repeat(rows - 1)}</tbody></table><p><br></p>`);
    const table = root.querySelector('table[data-new]');
    if (table) {
      table.removeAttribute('data-new');
      placeCaret(table.querySelector('th, td'), 0);
      updateContext();
    }
  }

  // -- Inline commands -------------------------------------------------------------------

  function toggleInlineCode() {
    const code = closest('code');
    if (code) {
      const text = code.textContent;
      const range = document.createRange();
      range.selectNode(code);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
      exec('insertText', text);
    } else if (!selection().isCollapsed) {
      const text = selection().toString();
      exec('insertHTML', `<code>${escapeHtml(text)}</code>${ZWSP}`);
    }
    afterEdit();
  }

  async function editLink() {
    if (!askLink) return;
    const existing = closest('a');
    const sel = selection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const selectedText = sel.toString();
    const url = await askLink(existing?.getAttribute('href') ?? '');
    root.focus();
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    if (url === null) return;
    const safe = safeUrl(url);
    if (existing) {
      if (safe) {
        existing.setAttribute('href', safe);
        changed();
      } else {
        unlink(existing);
      }
    } else if (safe) {
      if (selectedText) exec('createLink', safe);
      else exec('insertHTML', `<a href="${escapeHtml(safe)}">${escapeHtml(url)}</a>${ZWSP}`);
      afterEdit();
    }
  }

  function unlink(anchor) {
    anchor.replaceWith(...anchor.childNodes);
    hidePopovers();
    changed();
  }

  /** After a mark is applied the caret sits past a zero-width space, so typing continues unformatted. */
  function applyInlineMarkdown() {
    const sel = selection();
    if (!sel.isCollapsed || closest('pre, code')) return false;
    const node = sel.anchorNode;
    if (node?.nodeType !== 3) return false;
    const before = node.nodeValue.slice(0, sel.anchorOffset).replace(/ /g, ' ');

    const math = before.endsWith('$') && before.match(MATH_RULE);
    if (math) {
      const start = math.index + math[1].length;
      selectRange(node, start, node, sel.anchorOffset);
      exec('insertHTML', `${mathMarkup(math[2], false)}${ZWSP}`);
      return true;
    }
    const link = before.endsWith(')') && before.match(LINK_RULE);
    if (link) {
      const href = safeUrl(link[3]);
      if (href) {
        const start = link.index + link[1].length;
        selectRange(node, start, node, sel.anchorOffset);
        exec('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(link[2])}</a>${ZWSP}`);
        return true;
      }
    }
    for (const { pattern, tag } of INLINE_RULES) {
      const match = before.match(pattern);
      if (match) {
        const start = match.index + match[1].length;
        selectRange(node, start, node, sel.anchorOffset);
        exec('insertHTML', `<${tag}>${escapeHtml(match[2])}</${tag}>${ZWSP}`);
        return true;
      }
    }
    return false;
  }

  /** "# ", "- ", "[] ", "> " and friends at the start of a paragraph. */
  function applyBlockMarkdown() {
    const block = closest('p');
    if (!block || closest('blockquote, li, td, th')) return false;
    const before = textBeforeCaret(block);
    const clearPrefix = () => {
      const sel = selection();
      const range = sel.getRangeAt(0).cloneRange();
      range.setStart(block, 0);
      sel.removeAllRanges();
      sel.addRange(range);
      exec('delete');
    };
    const actions = {
      '# ': () => setBlock('h1'),
      '## ': () => setBlock('h2'),
      '### ': () => setBlock('h3'),
      '- ': () => toggleList('ul'),
      '* ': () => toggleList('ul'),
      '+ ': () => toggleList('ul'),
      '1. ': () => toggleList('ol'),
      '[] ': () => toggleList('check'),
      '[ ] ': () => toggleList('check'),
      '- [ ] ': () => toggleList('check'),
      '> ': () => toggleQuote(),
      '``` ': () => setBlock('pre'),
    };
    const action = actions[before];
    if (!action) return false;
    clearPrefix();
    action();
    return true;
  }

  /** "---" or "```" followed by Enter. Returns true if handled. */
  function applyEnterMarkdown() {
    const block = closest('p');
    if (!block || closest('blockquote, li, td, th')) return false;
    const text = block.textContent.replaceAll(ZWSP, '').trim();
    if (text === '---' || text === '***') {
      const range = document.createRange();
      range.selectNodeContents(block);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
      exec('delete');
      insertBlock('<hr><p><br></p>');
      return true;
    }
    const fence = text.match(/^```([\w+#-]*)$/);
    if (fence) {
      const range = document.createRange();
      range.selectNodeContents(block);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
      exec('delete');
      setBlock('pre');
      if (fence[1]) {
        const known = LANGUAGES.find((lang) => lang.id === fence[1].toLowerCase());
        if (known) closest('pre')?.setAttribute('data-lang', known.id);
      }
      return true;
    }
    if (text === '$$' && askMath) {
      const range = document.createRange();
      range.selectNodeContents(block);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
      exec('delete');
      insertMath(true);
      return true;
    }
    return false;
  }

  // -- Slash menu ------------------------------------------------------------------------

  const SLASH_ITEMS = [
    { id: 'p', label: 'Text', hint: 'Plain paragraph', icon: 'paragraph', keys: 'text paragraph', run: () => setBlock('p') },
    { id: 'h1', label: 'Heading 1', hint: 'Large section title', icon: null, badge: 'H1', keys: 'heading title h1', run: () => setBlock('h1') },
    { id: 'h2', label: 'Heading 2', hint: 'Medium section title', icon: null, badge: 'H2', keys: 'heading subtitle h2', run: () => setBlock('h2') },
    { id: 'h3', label: 'Heading 3', hint: 'Small section title', icon: null, badge: 'H3', keys: 'heading h3', run: () => setBlock('h3') },
    { id: 'ul', label: 'Bulleted list', hint: 'Simple list', icon: 'listBullet', keys: 'bullet list ul', run: () => toggleList('ul') },
    { id: 'ol', label: 'Numbered list', hint: 'List with numbers', icon: 'listNumber', keys: 'number ordered list ol', run: () => toggleList('ol') },
    { id: 'check', label: 'Checklist', hint: 'Items you can tick off', icon: 'listCheck', keys: 'checklist todo task checkbox', run: () => toggleList('check') },
    { id: 'quote', label: 'Quote', hint: 'Set a passage apart', icon: 'quote', keys: 'quote blockquote', run: () => toggleQuote() },
    { id: 'code', label: 'Code block', hint: 'Colored by language', icon: 'codeBlock', keys: 'code pre snippet', run: () => setBlock('pre') },
    ...(askMath ? [
      { id: 'math', label: 'Math formula', hint: 'LaTeX, in the line', icon: 'sigma', keys: 'math latex formula equation', run: () => insertMath(false) },
      { id: 'mathblock', label: 'Math block', hint: 'LaTeX, on its own line', icon: 'sigma', keys: 'math latex formula equation block display', run: () => insertMath(true) },
    ] : []),
    { id: 'table', label: 'Table', hint: '3 by 3 grid', icon: 'table', keys: 'table grid', run: () => insertTable() },
    { id: 'image', label: 'Image', hint: 'From this device', icon: 'image', keys: 'image picture photo', run: () => pickImage() },
    { id: 'link', label: 'Link', hint: 'Add a web address', icon: 'link', keys: 'link url', run: () => editLink() },
    ...(searchNotes ? [{ id: 'wiki', label: 'Link to a note', hint: 'Same as typing [[', icon: 'note', keys: 'wiki note link backlink', run: () => { exec('insertText', '[['); openWiki(); } }] : []),
    { id: 'hr', label: 'Divider', hint: 'Horizontal line', icon: 'divider', keys: 'divider line separator hr', run: () => insertBlock('<hr><p><br></p>') },
  ];

  const slashBox = h('div', { class: 'slash-menu', role: 'listbox', 'aria-label': 'Insert block', id: `slash-${Math.random().toString(36).slice(2)}`, hidden: true });
  let slash = null; // { node, offset, matches, active }

  function openSlash() {
    const sel = selection();
    const node = sel.anchorNode;
    if (node?.nodeType !== 3 || closest('pre, code')) return;
    const offset = sel.anchorOffset - 1;
    const before = node.nodeValue.slice(0, offset).replace(/ /g, ' ');
    if (before && !before.endsWith(' ')) return;
    slash = { node, offset, matches: SLASH_ITEMS, active: 0 };
    renderSlash();
  }

  function slashQuery() {
    const sel = selection();
    if (!slash || sel.anchorNode !== slash.node || sel.anchorOffset <= slash.offset) return null;
    const text = slash.node.nodeValue.slice(slash.offset, sel.anchorOffset).replace(/ /g, ' ');
    return text.startsWith('/') ? text.slice(1) : null;
  }

  function updateSlash() {
    const query = slashQuery();
    if (query === null || query.length > 24) {
      closeSlash();
      return;
    }
    const q = query.toLowerCase();
    slash.matches = SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(q) || item.keys.includes(q));
    slash.active = 0;
    if (!slash.matches.length) closeSlash();
    else renderSlash();
  }

  function renderSlash() {
    slashBox.replaceChildren(...slash.matches.map((item, index) => h('button', {
      class: `slash-item${index === slash.active ? ' is-active' : ''}`,
      id: `${slashBox.id}-${item.id}`,
      type: 'button',
      role: 'option',
      tabindex: '-1',
      'aria-selected': String(index === slash.active),
      onMousedown: (event) => {
        event.preventDefault();
        chooseSlash(index);
      },
    },
    h('span', { class: 'slash-icon' }, item.icon ? icon(item.icon, 18) : item.badge),
    h('span', { class: 'slash-text' }, h('span', { class: 'slash-label' }, item.label), h('span', { class: 'slash-hint' }, item.hint)))));
    slashBox.hidden = false;
    root.setAttribute('aria-controls', slashBox.id);
    root.setAttribute('aria-activedescendant', `${slashBox.id}-${slash.matches[slash.active].id}`);
    positionNear(slashBox, caretRect());
    slashBox.children[slash.active]?.scrollIntoView({ block: 'nearest' });
  }

  function chooseSlash(index) {
    const item = slash.matches[index];
    const { node, offset } = slash;
    const end = selection().anchorOffset;
    closeSlash();
    selectRange(node, offset, node, end);
    exec('delete');
    item.run();
  }

  function closeSlash() {
    slash = null;
    slashBox.hidden = true;
    root.removeAttribute('aria-activedescendant');
    root.removeAttribute('aria-controls');
  }

  function caretRect() {
    const sel = selection();
    if (!sel.rangeCount) return root.getBoundingClientRect();
    const rect = sel.getRangeAt(0).getClientRects()[0];
    return rect ?? (currentBlock() ?? root).getBoundingClientRect();
  }

  function positionNear(box, rect) {
    const { width, height } = box.getBoundingClientRect();
    const below = rect.bottom + 6;
    box.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    box.style.top = `${Math.max(8, below + height > innerHeight - 8 ? rect.top - height - 6 : below)}px`;
  }

  // -- Wiki links ------------------------------------------------------------------------

  const wikiBox = h('div', { class: 'slash-menu wiki-menu', role: 'listbox', 'aria-label': 'Link to a note', id: `wiki-${Math.random().toString(36).slice(2)}`, hidden: true });
  let wiki = null; // { node, offset, matches, active }, offset is where "[[" starts

  function openWiki() {
    const sel = selection();
    const node = sel.anchorNode;
    if (!searchNotes || node?.nodeType !== 3 || closest('pre, code')) return;
    wiki = { node, offset: sel.anchorOffset - 2, matches: [], active: 0 };
    updateWiki();
  }

  function wikiQuery() {
    const sel = selection();
    if (!wiki || sel.anchorNode !== wiki.node || sel.anchorOffset < wiki.offset + 2) return null;
    const text = wiki.node.nodeValue.slice(wiki.offset, sel.anchorOffset).replace(/\u00a0/g, ' ');
    return text.startsWith('[[') ? text.slice(2) : null;
  }

  function updateWiki() {
    const query = wikiQuery();
    if (query === null || query.length > 120) {
      closeWiki();
      return;
    }
    // Typing the closing brackets by hand finishes the link: an exact title, or a new note.
    if (query.endsWith(']]')) {
      const name = query.slice(0, -2).trim();
      if (!name) {
        closeWiki();
        return;
      }
      const exact = searchNotes(name).find((item) => item.title.toLowerCase() === name.toLowerCase());
      finishWiki(exact ?? createLinkedNote?.(name));
      return;
    }
    const name = query.trim();
    const found = searchNotes(name);
    wiki.matches = found.map((item) => ({ ...item, key: item.id }));
    if (name && createLinkedNote && !found.some((item) => item.title.toLowerCase() === name.toLowerCase())) {
      wiki.matches.push({ key: 'new', create: name, title: name, detail: 'New note in the Inbox' });
    }
    wiki.active = Math.min(wiki.active, Math.max(0, wiki.matches.length - 1));
    renderWiki(name);
  }

  function renderWiki(name) {
    wikiBox.replaceChildren(...wiki.matches.map((item, index) => h('button', {
      class: `slash-item${index === wiki.active ? ' is-active' : ''}`,
      id: `${wikiBox.id}-${index}`,
      type: 'button',
      role: 'option',
      tabindex: '-1',
      'aria-selected': String(index === wiki.active),
      onMousedown: (event) => {
        event.preventDefault();
        chooseWiki(index);
      },
    },
    h('span', { class: 'slash-icon' }, icon(item.create ? 'plus' : 'note', 16)),
    h('span', { class: 'slash-text' },
      h('span', { class: 'slash-label' }, item.create ? `Create "${item.title}"` : item.title),
      item.detail && h('span', { class: 'slash-hint' }, item.detail)))));
    if (!wiki.matches.length) wikiBox.append(h('p', { class: 'wiki-empty' }, name ? 'No matching notes.' : 'Type a note title.'));
    wikiBox.hidden = false;
    root.setAttribute('aria-controls', wikiBox.id);
    if (wiki.matches.length) root.setAttribute('aria-activedescendant', `${wikiBox.id}-${wiki.active}`);
    else root.removeAttribute('aria-activedescendant');
    positionNear(wikiBox, caretRect());
    wikiBox.children[wiki.active]?.scrollIntoView({ block: 'nearest' });
  }

  function chooseWiki(index) {
    const item = wiki.matches[index];
    if (item) finishWiki(item.create ? createLinkedNote(item.create) : item);
  }

  /** Replaces the typed "[[..." with a link. The zero-width space lets typing continue outside it. */
  function finishWiki(target) {
    const { node, offset } = wiki;
    const end = selection().anchorOffset;
    closeWiki();
    if (!target) return;
    selectRange(node, offset, node, end);
    exec('insertHTML', `<a href="#/note/${escapeHtml(target.id)}">${escapeHtml(target.title || 'Untitled')}</a>${ZWSP}`);
    afterEdit();
  }

  function closeWiki() {
    wiki = null;
    wikiBox.hidden = true;
    root.removeAttribute('aria-activedescendant');
    root.removeAttribute('aria-controls');
  }

  // -- Images ----------------------------------------------------------------------------

  function pickImage() {
    const sel = selection();
    imageRange = sel.rangeCount && caretNode() ? sel.getRangeAt(0).cloneRange() : null;
    fileInput.click();
  }

  async function insertImages(files) {
    if (!saveImage) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const saved = await saveImage(file);
      if (saved) insertImageAtCaret(saved.id, saved.dataUrl, file.name);
    }
  }

  function insertImageAtCaret(id, dataUrl, alt) {
    root.focus();
    if (imageRange) {
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(imageRange);
      imageRange = null;
    }
    exec('insertHTML', `<img data-asset="${escapeHtml(id)}" alt="${escapeHtml(alt ?? '')}" src="${escapeHtml(dataUrl)}">`);
    afterEdit();
  }

  // -- Paste and drop --------------------------------------------------------------------

  async function storeInlineImages(html) {
    if (!saveImage || !html.includes('data:image')) return html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img[src^="data:image"]')) {
      try {
        const blob = await (await fetch(img.getAttribute('src'))).blob();
        const saved = await saveImage(new File([blob], img.alt || 'pasted image', { type: blob.type }));
        if (saved) {
          img.setAttribute('data-asset', saved.id);
        }
      } catch {
        img.remove();
      }
    }
    return doc.body.innerHTML;
  }

  async function onPaste(event) {
    const data = event.clipboardData;
    if (!data) return;
    const text = data.getData('text/plain');
    const pastedHtml = data.getData('text/html');
    const images = [...data.files].filter((file) => file.type.startsWith('image/'));

    if (closest('pre')) {
      event.preventDefault();
      exec('insertText', text);
      afterEdit();
      return;
    }
    if (images.length && !pastedHtml) {
      event.preventDefault();
      await insertImages(images);
      return;
    }
    if (!selection().isCollapsed && !pastedHtml.includes('<img') && safeUrl(text.trim()) && /^https?:/.test(text.trim())) {
      event.preventDefault();
      exec('createLink', safeUrl(text.trim()));
      afterEdit();
      return;
    }
    if (pastedHtml) {
      event.preventDefault();
      const stored = await storeInlineImages(pastedHtml);
      const clean = sanitizeHtml(stored);
      if (clean) {
        exec('insertHTML', clean);
        for (const img of root.querySelectorAll('img[data-asset]:not([src])')) hydrateImage(img);
      }
      afterEdit();
      return;
    }
    if (text.includes('\n')) {
      event.preventDefault();
      const paragraphs = text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
      exec('insertHTML', paragraphs);
      afterEdit();
    }
    // Single-line plain text: the browser's default insert is already right.
  }

  function onDrop(event) {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range) {
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      root.focus();
    }
    insertImages(files);
  }

  // -- Keyboard --------------------------------------------------------------------------

  function onKeyDown(event) {
    if (wiki) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (wiki.matches.length) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          wiki.active = (wiki.active + step + wiki.matches.length) % wiki.matches.length;
          renderWiki(wikiQuery()?.trim() ?? '');
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (wiki.matches.length) {
          event.preventDefault();
          chooseWiki(wiki.active);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeWiki();
        return;
      }
    }
    if (slash) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        slash.active = (slash.active + step + slash.matches.length) % slash.matches.length;
        renderSlash();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseSlash(slash.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSlash();
        return;
      }
    }

    if (event.key === 'Escape') {
      // Lets keyboard users leave: Esc, then Tab moves focus out of a list, table or code block.
      // In a code block, the next stop is its language menu.
      releaseTab = true;
      hidePopovers();
      const pre = closest('pre');
      if (pre) showCodePopover(pre);
      return;
    }

    if (modKey(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      toggleInlineCode();
      return;
    }
    if (event.altKey && event.code === 'KeyK') {
      event.preventDefault();
      editLink();
      return;
    }

    if (event.key === 'Tab') {
      if (releaseTab) {
        releaseTab = false;
        return;
      }
      handleTab(event);
      return;
    }
    releaseTab = false;

    if (event.key === 'Enter') handleEnter(event);
    else if (event.key === 'Backspace') handleBackspace(event);
  }

  function handleTab(event) {
    const pre = closest('pre');
    const cell = closest('td, th');
    const li = closest('li');
    if (pre) {
      event.preventDefault();
      if (!event.shiftKey) exec('insertText', '  ');
    } else if (cell) {
      event.preventDefault();
      moveCell(cell, event.shiftKey ? -1 : 1);
    } else if (li) {
      event.preventDefault();
      exec(event.shiftKey ? 'outdent' : 'indent');
      afterEdit();
    }
  }

  function moveCell(cell, step) {
    const table = cell.closest('table');
    const cells = [...table.querySelectorAll('th, td')];
    const next = cells[cells.indexOf(cell) + step];
    if (next) {
      placeCaret(next, 0);
    } else if (step > 0) {
      const row = addRow(cell.closest('tr'));
      placeCaret(row.cells[0], 0);
    }
  }

  function handleEnter(event) {
    if (modKey(event)) {
      const pre = closest('pre');
      if (pre) {
        event.preventDefault();
        exitBlock(pre);
      } else {
        const task = closest('ul[data-type="check"] li');
        if (task) {
          event.preventDefault();
          toggleCheck(task);
        }
      }
      return;
    }
    if (event.shiftKey) return;
    if (event.isComposing) return;

    const pre = closest('pre');
    if (pre) {
      event.preventDefault();
      // Two blank lines at the end leave the code block. One is allowed, since code often has them.
      const after = textAfterCaret(pre);
      if (!after.replaceAll('\n', '') && after.length <= 1 && textBeforeCaret(pre).endsWith('\n\n')) {
        trimCodeEnd(pre);
        exitBlock(pre);
      } else {
        exec('insertLineBreak');
        afterEdit();
      }
      return;
    }
    if (applyEnterMarkdown()) {
      event.preventDefault();
      return;
    }
    const quote = closest('blockquote');
    if (quote) {
      const block = closest('p') ?? quote;
      if (block !== quote && isEmptyBlock(block)) {
        event.preventDefault();
        block.remove();
        exitBlock(quote);
      } else if (block === quote && isEmptyBlock(quote)) {
        event.preventDefault();
        exec('formatBlock', '<p>');
        afterEdit();
      }
    }
  }

  /** Removes the blank lines left at the end of a code block when leaving it. */
  function trimCodeEnd(pre) {
    while (pre.lastChild) {
      const last = pre.lastChild;
      if (last.nodeName === 'BR') {
        last.remove();
      } else if (last.nodeType === 3 && !last.nodeValue.replace(/\n/g, '')) {
        last.remove();
      } else {
        if (last.nodeType === 3) last.nodeValue = last.nodeValue.replace(/\n+$/, '');
        break;
      }
    }
    if (!pre.firstChild) pre.append(h('br'));
  }

  function exitBlock(block) {
    let next = block.nextElementSibling;
    if (!next || next.tagName !== 'P') {
      next = h('p', null, h('br'));
      block.after(next);
    }
    placeCaret(next, 0);
    afterEdit();
  }

  function handleBackspace(event) {
    if (!selection().isCollapsed) return;
    const heading = closest('h1, h2, h3, pre');
    if (heading && isCaretAtStart(heading)) {
      event.preventDefault();
      exec('formatBlock', '<p>');
      afterEdit();
      return;
    }
    const quote = closest('blockquote');
    if (quote && isCaretAtStart(quote)) {
      event.preventDefault();
      unwrapQuote(quote);
      afterEdit();
    }
  }

  function toggleCheck(li) {
    li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
    changed();
  }

  // -- Input ------------------------------------------------------------------------------

  function onInput(event) {
    if (applying) return;
    const type = event.inputType ?? '';
    const typed = type === 'insertText' || type === 'insertCompositionText' ? event.data : null;

    if (type === 'insertParagraph') {
      // A new line after a heading is a paragraph, and a new task starts unticked.
      const heading = closest('h1, h2, h3');
      if (heading && isEmptyBlock(heading)) exec('formatBlock', '<p>');
      const li = closest('ul[data-type="check"] li');
      if (li && isEmptyBlock(li)) li.setAttribute('data-checked', 'false');
    }

    if (slash) updateSlash();
    else if (typed === '/') openSlash();

    if (wiki) {
      updateWiki();
    } else if (typed === '[' && searchNotes) {
      const sel = selection();
      if (sel.anchorNode?.nodeType === 3 && sel.anchorNode.nodeValue.slice(sel.anchorOffset - 2, sel.anchorOffset) === '[[') openWiki();
    }

    if (typed && typed.endsWith(' ')) applyBlockMarkdown();
    if (typed && /[*_~`)$]/.test(typed.at(-1))) applyInlineMarkdown();
    afterEdit();
  }

  function afterEdit() {
    normalize();
    updateContext();
    colorCode();
    changed();
  }

  // -- Click handling ---------------------------------------------------------------------

  function onMouseDown(event) {
    const li = event.target.closest?.('ul[data-type="check"] > li');
    if (!li || readOnly) return;
    const box = li.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(li).paddingLeft) || 28;
    const inGutter = document.dir === 'rtl' ? event.clientX > box.right - padding : event.clientX < box.left + padding;
    if (inGutter && event.clientY < box.top + 30) {
      event.preventDefault();
      toggleCheck(li);
    }
  }

  function onClick(event) {
    const anchor = event.target.closest?.('a');
    // A link to another note opens with a plain click, like any link in the rest of the app.
    if (anchor?.getAttribute('href')?.startsWith('#/note/') && selection().isCollapsed) {
      event.preventDefault();
      location.hash = anchor.getAttribute('href');
      return;
    }
    if (anchor && (modKey(event) || readOnly)) {
      event.preventDefault();
      window.open(anchor.href, anchor.target || '_self', 'noopener');
    }
    const img = event.target.closest?.('img');
    if (img && !readOnly) showImagePopover(img);
    const math = event.target.closest?.('[data-math]');
    if (math) editMath(math);
  }

  // -- Toolbar ---------------------------------------------------------------------------

  const toolbarDefs = [
    { id: 'h1', text: 'H1', label: 'H1: Heading 1', run: () => toggleBlock('h1'), active: () => closest('h1') },
    { id: 'h2', text: 'H2', label: 'H2: Heading 2', run: () => toggleBlock('h2'), active: () => closest('h2') },
    { id: 'h3', text: 'H3', label: 'H3: Heading 3', run: () => toggleBlock('h3'), active: () => closest('h3') },
    'separator',
    { id: 'bold', icon: 'bold', label: `Bold (${modName}+B)`, run: () => { exec('bold'); afterEdit(); }, active: () => document.queryCommandState('bold') && !closest('h1, h2, h3') },
    { id: 'italic', icon: 'italic', label: `Italic (${modName}+I)`, run: () => { exec('italic'); afterEdit(); }, active: () => document.queryCommandState('italic') },
    { id: 'strike', icon: 'strike', label: 'Strikethrough', run: () => { exec('strikeThrough'); afterEdit(); }, active: () => document.queryCommandState('strikeThrough') },
    { id: 'code', icon: 'code', label: `Inline code (${modName}+E)`, run: toggleInlineCode, active: () => closest('code') },
    { id: 'link', icon: 'link', label: `Link (${altName}+K)`, run: editLink, active: () => closest('a') },
    'separator',
    { id: 'ul', icon: 'listBullet', label: 'Bulleted list', run: () => toggleList('ul'), active: () => closest('ul:not([data-type="check"])') },
    { id: 'ol', icon: 'listNumber', label: 'Numbered list', run: () => toggleList('ol'), active: () => closest('ol') },
    { id: 'check', icon: 'listCheck', label: 'Checklist', run: () => toggleList('check'), active: () => closest('ul[data-type="check"]') },
    'separator',
    { id: 'quote', icon: 'quote', label: 'Quote', run: toggleQuote, active: () => closest('blockquote') },
    { id: 'pre', icon: 'codeBlock', label: 'Code block', run: () => toggleBlock('pre'), active: () => closest('pre') },
    ...(askMath ? [{ id: 'math', icon: 'sigma', label: 'Math formula', run: () => insertMath(false) }] : []),
    { id: 'table', icon: 'table', label: 'Table', run: () => insertTable() },
    { id: 'image', icon: 'image', label: 'Image', run: pickImage },
    { id: 'hr', icon: 'divider', label: 'Divider', run: () => insertBlock('<hr><p><br></p>') },
  ];

  const toolButtons = new Map();
  const toolbar = h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Formatting', hidden: readOnly },
    toolbarDefs.map((def) => {
      if (def === 'separator') return h('span', { class: 'toolbar-sep', role: 'separator', 'aria-orientation': 'vertical' });
      const button = h('button', {
        class: 'tool-btn',
        type: 'button',
        'aria-label': def.label,
        title: def.label,
        tabindex: '-1',
        // Keeps the text selection when the button is pressed.
        onMousedown: (event) => event.preventDefault(),
        onClick: () => {
          if (!caretNode()) {
            root.focus();
            if (!caretNode()) placeCaret(root.lastElementChild ?? root, 0);
          }
          def.run();
        },
      }, def.icon ? icon(def.icon, 17) : def.text);
      if (def.active) button.setAttribute('aria-pressed', 'false');
      toolButtons.set(def.id, { button, def });
      return button;
    }));
  [...toolButtons.values()][0]?.button.setAttribute('tabindex', '0');
  toolbar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...toolbar.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    buttons.forEach((b) => b.setAttribute('tabindex', '-1'));
    next.setAttribute('tabindex', '0');
    next.focus();
    event.preventDefault();
  });

  // -- Context popovers ------------------------------------------------------------------

  const linkPop = h('div', { class: 'editor-pop', hidden: true, role: 'group', 'aria-label': 'Link options' });
  const tablePop = h('div', { class: 'editor-pop', hidden: true, role: 'toolbar', 'aria-label': 'Table options' });
  const imagePop = h('div', { class: 'editor-pop', hidden: true, role: 'group', 'aria-label': 'Image options' });
  const codePop = h('div', { class: 'editor-pop', hidden: true, role: 'group', 'aria-label': 'Code block options' });
  let imagePopFor = null;
  let codePopFor = null;

  const popButton = (iconName, text, onPress, extra = {}) => h('button', {
    class: 'pop-btn',
    type: 'button',
    onMousedown: (event) => event.preventDefault(),
    onClick: onPress,
    ...extra,
  }, iconName && icon(iconName, 15), text && h('span', null, text));

  function hidePopovers() {
    linkPop.hidden = true;
    tablePop.hidden = true;
    imagePop.hidden = true;
    imagePopFor = null;
    codePop.hidden = true;
    codePopFor = null;
  }

  /** Stays up while the caret is in a code block, offering the language. */
  function showCodePopover(pre) {
    if (codePopFor !== pre) {
      codePopFor = pre;
      const select = h('select', {
        class: 'select pop-select',
        'aria-label': 'Code language',
        onChange: () => {
          if (select.value) pre.setAttribute('data-lang', select.value);
          else pre.removeAttribute('data-lang');
          highlightBlock(pre);
          changed();
          root.focus();
        },
      }, LANGUAGES.map((lang) => h('option', { value: lang.id, selected: lang.id === (pre.getAttribute('data-lang') ?? '') }, lang.label)));
      codePop.replaceChildren(select);
    }
    codePop.hidden = false;
    const box = pre.getBoundingClientRect();
    const { width } = codePop.getBoundingClientRect();
    codePop.style.left = `${Math.max(8, box.right - width - 4)}px`;
    codePop.style.top = `${Math.max(8, box.top + 4)}px`;
  }

  function showLinkPopover(anchor) {
    const internal = anchor.getAttribute('href')?.startsWith('#/note/');
    linkPop.replaceChildren(
      h('a', {
        class: 'pop-url',
        href: anchor.getAttribute('href'),
        ...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' }),
        onMousedown: (event) => event.preventDefault(),
      }, icon(internal ? 'note' : 'external', 14), h('span', null, internal ? 'Open note' : anchor.getAttribute('href'))),
      ...(internal ? [] : [popButton('edit', 'Edit', editLink)]),
      popButton('close', 'Remove', () => unlink(anchor)),
    );
    linkPop.hidden = false;
    positionNear(linkPop, anchor.getBoundingClientRect());
  }

  function addRow(row) {
    const added = row.cloneNode(true);
    for (const cell of added.cells) {
      const td = h('td', null, h('br'));
      cell.replaceWith(td);
    }
    row.after(added);
    changed();
    return added;
  }

  function showTablePopover(table, cell) {
    const columnIndex = () => cell.cellIndex;
    tablePop.replaceChildren(
      popButton('addRow', 'Row', () => {
        placeCaret(addRow(cell.closest('tr')).cells[Math.min(columnIndex(), 0)], 0);
        updateContext();
      }, { 'aria-label': 'Add row below' }),
      popButton('addColumn', 'Column', () => {
        const at = columnIndex();
        for (const row of table.rows) {
          const tag = row.cells[0]?.tagName === 'TH' ? 'th' : 'td';
          const fresh = h(tag, null, h('br'));
          row.cells[at] ? row.cells[at].after(fresh) : row.append(fresh);
        }
        changed();
        updateContext();
      }, { 'aria-label': 'Add column to the right' }),
      popButton('removeRow', null, () => {
        const row = cell.closest('tr');
        if (table.rows.length <= 1) return removeTable(table);
        const neighbor = row.nextElementSibling ?? row.previousElementSibling;
        row.remove();
        placeCaret(neighbor.cells[0], 0);
        afterEdit();
      }, { 'aria-label': 'Delete this row', title: 'Delete row' }),
      popButton('removeColumn', null, () => {
        const at = columnIndex();
        if (table.rows[0].cells.length <= 1) return removeTable(table);
        for (const row of table.rows) row.cells[at]?.remove();
        placeCaret(table.rows[0].cells[Math.max(0, at - 1)], 0);
        afterEdit();
      }, { 'aria-label': 'Delete this column', title: 'Delete column' }),
      popButton('trash', null, () => removeTable(table), { 'aria-label': 'Delete table', title: 'Delete table' }),
    );
    tablePop.hidden = false;
    positionNear(tablePop, table.getBoundingClientRect());
  }

  function removeTable(table) {
    const next = h('p', null, h('br'));
    table.replaceWith(next);
    placeCaret(next, 0);
    hidePopovers();
    afterEdit();
  }

  function showImagePopover(img) {
    imagePopFor = img;
    imagePop.replaceChildren(
      popButton('edit', 'Describe', async () => {
        const text = await askLink?.(img.alt, { describeImage: true });
        if (text !== null && text !== undefined) {
          img.alt = text;
          changed();
        }
      }),
      popButton('trash', 'Delete', () => {
        img.remove();
        hidePopovers();
        afterEdit();
      }),
    );
    imagePop.hidden = false;
    positionNear(imagePop, img.getBoundingClientRect());
  }

  function placePlaceholder() {
    for (const old of root.querySelectorAll('.show-hint')) old.classList.remove('show-hint');
    const block = closest('p');
    if (block && document.activeElement === root && isEmptyBlock(block) && !closest('li, td, th, blockquote')) {
      block.classList.add('show-hint');
    }
  }

  const updateContext = frameThrottle(() => {
    if (readOnly || !root.isConnected) return;
    const inside = Boolean(caretNode());
    for (const { button, def } of toolButtons.values()) {
      if (def.active) {
        let on = false;
        try {
          on = inside && Boolean(def.active());
        } catch {
          // queryCommandState can throw while the selection is changing.
        }
        button.setAttribute('aria-pressed', String(on));
      }
    }
    placePlaceholder();
    if (!inside) {
      if (!el.contains(document.activeElement) && !codePop.contains(document.activeElement)) hidePopovers();
      return;
    }
    const anchor = selection().isCollapsed ? closest('a') : null;
    if (anchor) showLinkPopover(anchor);
    else linkPop.hidden = true;
    const cell = closest('td, th');
    if (cell) showTablePopover(cell.closest('table'), cell);
    else tablePop.hidden = true;
    const pre = closest('pre');
    if (pre) showCodePopover(pre);
    else {
      codePop.hidden = true;
      codePopFor = null;
    }
    if (imagePopFor && !imagePopFor.isConnected) hidePopovers();
    if (slash && slashQuery() === null) closeSlash();
    if (wiki && wikiQuery() === null) closeWiki();
  });

  // -- Wiring ----------------------------------------------------------------------------

  el.append(slashBox, wikiBox, linkPop, tablePop, imagePop, codePop);
  setHtml(html);

  const listeners = [
    [root, 'keydown', onKeyDown],
    [root, 'input', onInput],
    [root, 'paste', onPaste],
    [root, 'drop', onDrop],
    [root, 'mousedown', onMouseDown],
    [root, 'click', onClick],
    [root, 'focus', updateContext],
    [root, 'blur', () => {
      closeSlash();
      closeWiki();
      for (const old of root.querySelectorAll('.show-hint')) old.classList.remove('show-hint');
    }],
    [document, 'selectionchange', updateContext],
    [fileInput, 'change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      await insertImages(files);
    }],
  ];
  const onScroll = () => hidePopovers();
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return {
    el,
    toolbar,
    getHtml() {
      return sanitizeHtml(root.innerHTML);
    },
    setHtml,
    /** Puts the caret at the end by default, or at the start. */
    focus(where = 'end') {
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(where === 'start');
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
    isFocused: () => document.activeElement === root,
    destroy() {
      clearTimeout(codeTimer);
      for (const pre of root.querySelectorAll('pre')) clearHighlight(pre);
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      window.removeEventListener('scroll', onScroll, { capture: true });
    },
  };
}
