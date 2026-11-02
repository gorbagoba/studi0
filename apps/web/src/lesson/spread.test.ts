import { describe, expect, it } from 'vitest';
import { toSpread } from './spread';

describe('toSpread', () => {
  it('injects the style into head and the page-turn script before </body>', () => {
    const out = toSpread('<html><head><title>t</title></head><body><p>x</p></body></html>');
    expect(out).toContain('column-count: 2');
    expect(out).toContain('body > *');
    expect(out).toContain('spread-fs');
    expect(out.indexOf('<style>')).toBeLessThan(out.indexOf('</head>'));
    expect(out).toContain('scrollBy');
    const scriptAt = out.lastIndexOf('<script>');
    expect(scriptAt).toBeGreaterThan(out.indexOf('<body'));
    expect(scriptAt).toBeLessThan(out.lastIndexOf('</body>'));
  });

  it('defaults the document language to en when missing, keeps an existing one', () => {
    expect(toSpread('<html><body>x</body></html>')).toContain('<html lang="en">');
    expect(toSpread('<html lang="de"><body>x</body></html>')).toContain('<html lang="de">');
  });

  it('injects the style right after <body> when there is no head', () => {
    const out = toSpread('<body><p>x</p></body>');
    expect(out.indexOf('<style>')).toBeGreaterThan(-1);
    expect(out.indexOf('<style>')).toBeLessThan(out.indexOf('<p>'));
  });

  it('prepends both when the document has neither head nor body tags', () => {
    const out = toSpread('<p>bare</p>');
    expect(out.startsWith('<style>')).toBe(true);
    expect(out.endsWith('</script>')).toBe(true);
    expect(out).toContain('<p>bare</p><script>');
  });
});
