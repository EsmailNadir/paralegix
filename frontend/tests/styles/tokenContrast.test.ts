import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * WCAG 1.4.3 (AA) contrast for the semantic text tokens.
 *
 * Every `--on-surface*` colour is rendered on top of one of the surface
 * colours somewhere in the app, so each pairing has to clear 4.5:1. The
 * ratios are computed from `global.css` itself rather than from a copy of the
 * hex values, so darkening a token in one theme and forgetting the other
 * fails here instead of shipping.
 */

const CSS = readFileSync(join(__dirname, '../../src/styles/global.css'), 'utf8');

/** Pull the `:root` (light) and `.dark` custom-property blocks out of the file. */
function readThemeBlock(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {\n  --page:`);
  if (start === -1) throw new Error(`no theme block found for ${selector}`);
  const end = CSS.indexOf('\n}', start);
  const block = CSS.slice(start, end);
  const vars: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6});/g)) {
    vars[name] = value;
  }
  return vars;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Backgrounds that body, secondary and muted text actually sit on. */
const BACKGROUNDS = ['page', 'surface', 'surface-alt', 'surface-hover', 'message-bubble-received'];
const TEXT = ['on-surface', 'on-surface-secondary', 'on-surface-muted'];

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('%s theme text contrast', (_theme, selector) => {
  const vars = readThemeBlock(selector);

  it('defines every token the check reads', () => {
    for (const name of [...TEXT, ...BACKGROUNDS]) {
      expect(vars[name]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it.each(TEXT)('%s clears 4.5:1 on every surface', (text) => {
    for (const background of BACKGROUNDS) {
      const ratio = contrastRatio(vars[text], vars[background]);
      // Reported so a failure names the pairing, not just the number.
      expect({
        pair: `${text} on ${background}`,
        ratio: Number(ratio.toFixed(2)),
        pass: ratio >= 4.5,
      }).toEqual({
        pair: `${text} on ${background}`,
        ratio: Number(ratio.toFixed(2)),
        pass: true,
      });
    }
  });
});

/**
 * WCAG 1.4.11 (AA) non-text contrast for control boundaries.
 *
 * `--input-border` is the only thing that says where a text field, textarea,
 * select or Dropdown trigger begins, and `--control-border` does the same for
 * the secondary button, so both have to clear 3:1 against the fill inside them
 * and the surface they sit on. `--outline` is deliberately not checked: it
 * draws card edges, dividers and modal borders, which are decoration and are
 * exempt. That split is the whole reason `--control-border` exists.
 */
describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('%s theme control boundary contrast', (_theme, selector) => {
  const vars = readThemeBlock(selector);
  const adjacent = ['input-bg', 'surface', 'surface-alt', 'surface-hover', 'page'];

  it.each(['input-border', 'control-border'])('%s clears 3:1 against every colour it touches', (token) => {
    for (const background of adjacent) {
      const ratio = contrastRatio(vars[token], vars[background]);
      expect({
        pair: `${token} on ${background}`,
        ratio: Number(ratio.toFixed(2)),
        pass: ratio >= 3,
      }).toEqual({
        pair: `${token} on ${background}`,
        ratio: Number(ratio.toFixed(2)),
        pass: true,
      });
    }
  });
});

/**
 * Keyboard focus.
 *
 * The app draws exactly one focus indicator, a thin outline on `:focus-visible`
 * declared once in `global.css`. It is deliberately not Tailwind's `ring-*`
 * utilities: 219 of those are declared across 97 files, and letting both draw
 * put a ring and an outline around the same control, which is the doubled edge
 * the design brief rejected. So the ring box-shadow stays suppressed and the
 * outline is the single source. Mouse focus stays quiet, since `:focus-visible`
 * does not match a clicked button.
 *
 * These pin the parts that make it visible at all. Delete any one of them and
 * keyboard users lose the only indicator they have.
 */
describe('keyboard focus indicator', () => {
  const focusVisibleRule = CSS.slice(
    CSS.indexOf('*:focus-visible:not(.skip-link)'),
    CSS.indexOf('}', CSS.indexOf('*:focus-visible:not(.skip-link)')),
  );
  const focusRule = CSS.slice(
    CSS.indexOf('*:focus:not(:focus-visible):not(.skip-link)'),
    CSS.indexOf('}', CSS.indexOf('*:focus:not(:focus-visible):not(.skip-link)')),
  );

  it('draws a thin token-coloured outline on keyboard focus', () => {
    // Marked !important: `focus:outline-none` on every Button and input
    // resolves to (0,2,0), the same as this rule, so without it the winner
    // would be emission order.
    expect(focusVisibleRule).toContain('outline: 2px solid var(--focus-ring) !important');
    expect(focusVisibleRule).toContain('outline-offset: 1px !important');
  });

  it('suppresses the ring box-shadow, so only one edge is ever drawn', () => {
    expect(focusVisibleRule).toContain('box-shadow: none !important');
  });

  it('leaves mouse focus quiet', () => {
    expect(focusRule).toContain('outline: none');
    expect(focusRule).toContain('box-shadow: none !important');
  });

  it('never suppresses the outline for every focus state at once', () => {
    // The rule this replaced was `*:focus, *:focus-visible { outline: none }`,
    // which cancelled the indicator for keyboard users too.
    expect(CSS).not.toContain('*:focus:not(.skip-link),\n*:focus-visible:not(.skip-link)');
  });

  it.each([
    ['light', ':root'],
    ['dark', '.dark'],
  ])('keeps the outline visible against every surface in the %s theme', (_theme, selector) => {
    const vars = readThemeBlock(selector);
    for (const background of ['surface', 'surface-alt', 'page', 'input-bg']) {
      // 1.4.11: the focus indicator is a non-text graphic and needs 3:1.
      expect(contrastRatio(vars['focus-ring'], vars[background])).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('contrastRatio', () => {
  it('returns 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#5C6479', '#5C6479')).toBeCloseTo(1, 5);
  });
});
