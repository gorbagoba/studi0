/**
 * Two-page book layout for lesson documents.
 *
 * The lesson iframe is sandboxed without same-origin, so the parent cannot reach
 * into it — everything (typography, layout, page turns, live text size) is
 * injected into the document itself. studi0 owns typography (reader-standard,
 * cf. Pocket/Readwise): lesson layout styles are neutralized, semantic markup
 * and content colors survive. Text size is adjusted live via a `spread-fs`
 * postMessage — no iframe reload, scroll position preserved.
 */

const SPREAD_CSS = `
:root { --spread-fs: 17px; }
html { height: 100% !important; }
body {
  height: 100% !important;
  max-width: none !important;
  width: auto !important;
  margin: 0 !important;
  padding: 1.25rem 1.75rem !important;
  box-sizing: border-box !important;
  column-count: 2 !important;
  column-gap: 2.25rem !important;
  column-fill: auto !important;
  column-rule: 1px solid rgba(128, 128, 128, 0.25);
  font-size: var(--spread-fs) !important;
  line-height: 1.55 !important;
  hyphens: auto !important;
  overflow-wrap: break-word;
}
/* kill centered / width-capped wrappers the lesson may carry */
body > * {
  max-width: none !important;
  width: auto !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}
h1, h2, h3 { line-height: 1.25; }
pre, table, figure, img, mjx-container { break-inside: avoid; max-width: 100%; }
pre { overflow-x: auto; }
@media (max-width: 900px) {
  body { column-count: 1 !important; }
}
`;

const SPREAD_JS = `
(function () {
  var el = document.scrollingElement;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.type === 'spread-fs' && typeof d.fs === 'number') {
      document.documentElement.style.setProperty('--spread-fs', d.fs + 'px');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'PageDown' && e.key !== 'PageUp') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    var dir = e.key === 'ArrowRight' || e.key === 'PageDown' ? 1 : -1;
    el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' });
  });
})();
`;

/** Injects the spread typography/layout + page-turn keys into a lesson HTML document. */
export function toSpread(html: string): string {
  // hyphens:auto needs a document language; default to en when absent
  const withLang = /<html[^>]*>/i.test(html)
    ? html.replace(/<html(?![^>]*\blang=)/i, '<html lang="en"')
    : html;
  const withCss = /<\/head>/i.test(withLang)
    ? withLang.replace(/<\/head>/i, `<style>${SPREAD_CSS}</style></head>`)
    : /<body[^>]*>/i.test(withLang)
      ? withLang.replace(/<body[^>]*>/i, (m) => `${m}<style>${SPREAD_CSS}</style>`)
      : `<style>${SPREAD_CSS}</style>${withLang}`;
  return /<\/body>/i.test(withCss)
    ? withCss.replace(/<\/body>/i, `<script>${SPREAD_JS}</script></body>`)
    : `${withCss}<script>${SPREAD_JS}</script>`;
}
