/**
 * math.js: LaTeX rendering with a local copy of KaTeX in /vendor. It loads the first time a note
 * has math, so notes without any never pay for it, and it works offline.
 *
 * KaTeX's render() builds elements and sets styles through the DOM, which the app's strict
 * Content Security Policy allows. Its renderToString() would be blocked, so it isn't used.
 */

let loading = null;

function loadKatex() {
  if (!loading) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../vendor/katex/katex.min.css', import.meta.url).href;
    document.head.append(link);
    loading = import('../../vendor/katex/katex.mjs').then((module) => module.default);
  }
  return loading;
}

/** Draws one formula into an element. Bad LaTeX shows as red text instead of throwing. */
export async function renderMath(el, source, display = false) {
  const katex = await loadKatex();
  katex.render(source, el, {
    displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml',
  });
}

/** Draws every formula inside a read-only piece of a note. */
export function drawMathIn(root) {
  for (const span of root.querySelectorAll('span[data-math]')) {
    renderMath(span, span.getAttribute('data-math'), span.getAttribute('data-display') === 'true')
      .catch((error) => console.warn('Math could not be drawn:', error));
  }
}

/** Checks a formula. Returns a problem in words, or '' if it's fine. */
export async function mathProblem(source) {
  const katex = await loadKatex();
  try {
    katex.__parse(source, { strict: 'ignore', trust: false });
    return '';
  } catch (error) {
    return String(error.message ?? error).replace(/^KaTeX parse error:\s*/, '');
  }
}
