/**
 * highlight.js: syntax colors for code blocks.
 *
 * The colors use the CSS Custom Highlight API, which paints ranges of text without touching the
 * document. That matters here: extra markup inside an editable block would move the caret and
 * would end up in the saved note. Browsers without the API just show plain code.
 */

export const LANGUAGES = Object.freeze([
  { id: '', label: 'Auto-detect' },
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C and C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Shell' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'r', label: 'R' },
  { id: 'matlab', label: 'MATLAB' },
  { id: 'latex', label: 'LaTeX' },
]);

const words = (text) => new Set(text.split(' '));

const C_LIKE = 'if else for while do switch case break continue return default goto sizeof struct enum union typedef const static void int long short char float double bool true false null';

const KEYWORDS = {
  python: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'),
  javascript: words('async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'),
  typescript: words('abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface keyof let module namespace never new null number of private protected public readonly return static string super switch this throw true try type typeof undefined unknown var void while yield'),
  java: words(`${C_LIKE} abstract assert boolean byte catch class extends final finally implements import instanceof interface native new package private protected public strictfp super synchronized this throw throws transient try volatile String`),
  c: words(`${C_LIKE} auto class catch constexpr delete extern friend include inline namespace new nullptr operator private protected public register signed template this throw try typename unsigned using virtual volatile`),
  csharp: words(`${C_LIKE} abstract as async await base byte catch checked class decimal delegate event explicit extern finally foreach get implicit in interface internal is lock namespace new object out override params private protected public readonly ref sealed set stackalloc string this throw try typeof uint ulong unchecked unsafe ushort using var virtual`),
  go: words('break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var string int bool error'),
  rust: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  sql: words('select from where and or not insert into values update set delete create table index view join left right inner outer on as group by order having limit offset union all distinct null is in like between exists case when then else end primary key foreign references default drop alter add column count sum avg min max asc desc'),
  bash: words('if then else elif fi for while until do done case esac in function return exit export local readonly echo cd ls grep sed awk cat sudo set unset source'),
  r: words('if else for while repeat function return next break TRUE FALSE NULL NA Inf NaN library require'),
  matlab: words('if elseif else end for while switch case otherwise function return break continue try catch global persistent true false'),
  css: words('important inherit initial unset none auto'),
  json: words('true false null'),
  latex: new Set(),
  html: new Set(),
};

const COMMENTS = {
  python: ['#'],
  bash: ['#'],
  r: ['#'],
  matlab: ['%'],
  latex: ['%'],
  sql: ['--'],
  json: [],
  html: [],
  css: [],
};
const DEFAULT_LINE_COMMENT = ['//'];
const BLOCK_COMMENT = {
  javascript: true, typescript: true, java: true, c: true, csharp: true, go: true, rust: true, css: true, sql: true,
};
const CASE_INSENSITIVE = new Set(['sql']);
const STRING_QUOTES = {
  bash: ['"', "'"], python: ['"', "'"], sql: ["'"], html: ['"', "'"], css: ['"', "'"], json: ['"'], javascript: ['"', "'", '`'], typescript: ['"', "'", '`'],
};

/** A rough guess at the language, from telltale words. Good enough for colors. */
export function detectLanguage(code) {
  const tests = [
    ['html', /^\s*<(!doctype|html|div|p|span|a|body|head|script)\b/i],
    ['json', /^\s*[{[]\s*"[^"]*"\s*:/],
    ['sql', /\b(select\s.+\sfrom|insert\s+into|create\s+table|update\s+\w+\s+set)\b/i],
    ['python', /^\s*(def \w+\(.*\):|class \w+.*:|import \w+|from \w+ import|elif |print\()/m],
    ['bash', /^\s*(#!\/|sudo |cd |ls |echo |apt |brew |npm |git |python3? )/m],
    ['c', /^\s*#include\b|\bstd::|\bprintf\(|\bcout\b/m],
    ['java', /\bpublic\s+(static\s+)?(class|void|int)\b|\bSystem\.out\b/],
    ['go', /^\s*package \w+|\bfunc \w+\(|:=/m],
    ['rust', /\bfn \w+\(|\blet mut\b|\bimpl\b/],
    ['typescript', /\binterface \w+\s*{|:\s*(string|number|boolean)\b/],
    ['javascript', /\b(const|let|var|function)\b|=>|console\.log/],
    ['css', /^[.#]?[\w-]+\s*{\s*[\w-]+\s*:/m],
    ['latex', /\\(begin|frac|sum|int|alpha|section)\b/],
  ];
  return tests.find(([, pattern]) => pattern.test(code))?.[0] ?? 'javascript';
}

/**
 * Finds the colored parts of some code: [{ type, start, end }] in order.
 * A small hand-written scanner rather than a full parser, so it's fast on every keystroke, and a
 * half-typed string can't break anything: the worst case is a wrong color.
 */
export function tokenize(code, language) {
  const lang = KEYWORDS[language] ? language : detectLanguage(code);
  const keywords = KEYWORDS[lang];
  const lineComments = COMMENTS[lang] ?? DEFAULT_LINE_COMMENT;
  const blockComments = BLOCK_COMMENT[lang];
  const quotes = STRING_QUOTES[lang] ?? ['"', "'"];
  const insensitive = CASE_INSENSITIVE.has(lang);
  const tokens = [];
  const length = code.length;
  let i = 0;

  while (i < length) {
    const char = code[i];

    if (lang === 'html' && char === '<') {
      if (code.startsWith('<!--', i)) {
        const close = code.indexOf('-->', i + 4);
        const end = close === -1 ? length : close + 3;
        tokens.push({ type: 'comment', start: i, end });
        i = end;
        continue;
      }
      const match = /^<\/?[\w-]+/.exec(code.slice(i, i + 60));
      if (match) {
        tokens.push({ type: 'keyword', start: i, end: i + match[0].length });
        i += match[0].length;
        continue;
      }
    }

    if (lang === 'latex' && char === '\\') {
      const match = /^\\[a-zA-Z]+/.exec(code.slice(i, i + 40));
      if (match) {
        tokens.push({ type: 'keyword', start: i, end: i + match[0].length });
        i += match[0].length;
        continue;
      }
    }

    const line = lineComments.find((mark) => code.startsWith(mark, i));
    if (line) {
      const close = code.indexOf('\n', i);
      const end = close === -1 ? length : close;
      tokens.push({ type: 'comment', start: i, end });
      i = end;
      continue;
    }
    if (blockComments && code.startsWith('/*', i)) {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? length : close + 2;
      tokens.push({ type: 'comment', start: i, end });
      i = end;
      continue;
    }

    if (quotes.includes(char)) {
      let j = i + 1;
      while (j < length && code[j] !== char) {
        if (code[j] === '\\') j += 1;
        // Only template strings and Python triple quotes run over lines. Others end at the line.
        else if (code[j] === '\n' && char !== '`') break;
        j += 1;
      }
      const end = Math.min(length, j + (code[j] === char ? 1 : 0));
      tokens.push({ type: 'string', start: i, end });
      i = end;
      continue;
    }

    if (/[0-9]/.test(char) && !/[\w$]/.test(code[i - 1] ?? '')) {
      const match = /^(0[xX][\da-fA-F_]+|[\d_]*\.?[\d_]+([eE][+-]?\d+)?)/.exec(code.slice(i, i + 40));
      if (match) {
        tokens.push({ type: 'number', start: i, end: i + match[0].length });
        i += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(char)) {
      let j = i + 1;
      while (j < length && /[\w$]/.test(code[j])) j += 1;
      const word = code.slice(i, j);
      if (keywords.has(insensitive ? word.toLowerCase() : word)) {
        tokens.push({ type: 'keyword', start: i, end: j });
      } else if (code[j] === '(') {
        tokens.push({ type: 'function', start: i, end: j });
      }
      i = j;
      continue;
    }

    i += 1;
  }
  return tokens;
}

const SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
const TYPES = ['keyword', 'string', 'comment', 'number', 'function'];
const registry = SUPPORTED ? new Map(TYPES.map((type) => {
  const highlight = new Highlight();
  CSS.highlights.set(`code-${type}`, highlight);
  return [type, highlight];
})) : null;
const applied = new WeakMap();
const MAX_CODE_LENGTH = 40000;

/** Removes a block's colors, for instance when it is about to be changed or removed. */
export function clearHighlight(pre) {
  const ranges = applied.get(pre);
  if (!ranges) return;
  for (const { type, range } of ranges) registry.get(type).delete(range);
  applied.delete(pre);
}

/** Colors one code block. Handles the line breaks Chrome represents with <br>. */
export function highlightBlock(pre) {
  if (!SUPPORTED) return;
  clearHighlight(pre);
  const nodes = [];
  let text = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        nodes.push({ node: child, start: text.length });
        text += child.nodeValue;
      } else if (child.nodeName === 'BR') {
        text += '\n';
      } else {
        walk(child);
      }
    }
  };
  walk(pre);
  if (!text.trim() || text.length > MAX_CODE_LENGTH) return;

  const locate = (offset, from) => {
    let index = from;
    while (index < nodes.length - 1 && nodes[index + 1].start <= offset) index += 1;
    return index;
  };
  const ranges = [];
  let cursor = 0;
  for (const token of tokenize(text, pre.getAttribute('data-lang') ?? '')) {
    const first = locate(token.start, cursor);
    const last = locate(token.end - 1, first);
    cursor = first;
    if (nodes[first] && token.start - nodes[first].start < nodes[first].node.length) {
      const range = new Range();
      range.setStart(nodes[first].node, token.start - nodes[first].start);
      range.setEnd(nodes[last].node, Math.min(token.end - nodes[last].start, nodes[last].node.length));
      registry.get(token.type).add(range);
      ranges.push({ type: token.type, range });
    }
  }
  applied.set(pre, ranges);
}
