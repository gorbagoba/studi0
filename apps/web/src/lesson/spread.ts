/**
 * Two-page book layout for lesson documents.
 *
 * The lesson iframe is sandboxed without same-origin, so the parent cannot reach
 * into it — everything (layout + page turns) is injected into the document itself.
 * body gets a fixed viewport height with `column-fill: auto`: content flows into
 * two side-by-side pages and further spreads overflow horizontally, which the
 * injected script turns with arrow/PageUp/PageDown keys.
 */

const SPREAD_CSS = `
html { height: 100% !important; }
body {
  height: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 2.5rem 3rem !important;
  box-sizing: border-box !important;
  column-count: 2 !important;
  column-gap: 4rem !important;
  column-fill: auto !important;
}
pre, table, figure, img, mjx-container { break-inside: avoid; max-width: 100%; }
pre { overflow-x: auto; }
`;

const SPREAD_JS = `
(function () {
  var el = document.scrollingElement;
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

/** Injects the spread layout + page-turn keys into a lesson HTML document. */
export function toSpread(html: string): string {
  const withCss = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `<style>${SPREAD_CSS}</style></head>`)
    : /<body[^>]*>/i.test(html)
      ? html.replace(/<body[^>]*>/i, (m) => `${m}<style>${SPREAD_CSS}</style>`)
      : `<style>${SPREAD_CSS}</style>${html}`;
  return /<\/body>/i.test(withCss)
    ? withCss.replace(/<\/body>/i, `<script>${SPREAD_JS}</script></body>`)
    : `${withCss}<script>${SPREAD_JS}</script>`;
}
