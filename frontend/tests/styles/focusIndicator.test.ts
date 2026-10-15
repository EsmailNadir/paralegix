import { readFileSync } from 'fs';
import { join } from 'path';
import { sourceFiles } from '../support/sourceScan';

/**
 * One focus indicator, on the element that has focus.
 *
 * `global.css` draws a 2px outline on `:focus-visible` for everything. Anything
 * that ALSO changes on focus draws a second edge inside or beside the first,
 * which is what put two rings around the search bar: the field recoloured its
 * own border to the accent and the outline landed 1px outside it.
 *
 * So a focus style anywhere else is a bug now, not a preference. This walks the
 * source for the shapes that compete: a border recolour on focus in a
 * `className`, and a `border-color` under a `:focus` selector in the stylesheet.
 */
const SRC = join(__dirname, '../../src');
const CSS = readFileSync(join(SRC, 'styles/global.css'), 'utf8');

/** `focus:border-x` and `focus-within:border-x`, but not `border-x` on its own. */
const COMPETING = /\bfocus(?:-within|-visible)?:border-(?!collapse\b|separate\b)[a-z0-9[\]/.-]+/g;

describe('focus indicator is not doubled', () => {
  const files = sourceFiles(SRC);

  it('finds the source tree, so an empty pass cannot look like a clean one', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('has no component recolouring its own border on focus', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(COMPETING)) {
        hits.push(`${file.slice(SRC.length + 1)}: ${match[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('has no border-color under a focus selector in the stylesheet', () => {
    const rules = [...CSS.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)];
    const recolouring = rules
      .filter(([, , body]) => /border-color/.test(body))
      .map(([, selector]) => selector.trim());
    expect(recolouring).toEqual([]);
  });

  it('draws the outline from one rule, plus the skip link it excludes', () => {
    const drawing = [...CSS.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline:\s*\d/.test(body))
      .map(([, selector]) => selector.trim());
    // `.skip-link` is the one element the global rule skips: it is invisible
    // until focused, so it owns its whole appearance including the outline.
    expect(drawing).toEqual(['*:focus-visible:not(.skip-link)', '.skip-link:focus']);
  });
});

/**
 * The other shape that doubles the indicator: a wrapper that rings itself on
 * `focus-within` while the child it wraps still takes the global outline. That
 * is fine when the child is hidden (a `sr-only` radio, an `opacity-0`
 * checkbox), because a hidden element paints no outline. It is a bug when the
 * child is a visible cell of a fused cluster, which is what put a box around
 * the flat fee description inside a ring around the whole row.
 *
 * `.fused-field-group` is the fix, so this requires the marker wherever the
 * ring is not covering a hidden control.
 */
describe('a focus-within ring does not double with the child outline', () => {
  /** Wrappers whose only focusable child is hidden, so nothing doubles. */
  const HIDDEN_CONTROL = [
    'components/ui/Checkbox.tsx', // native checkbox is `opacity-0` over the box
    'components/billingComp/PaymentPlanFields.tsx', // `sr-only` radio
    'app/lawfirm/[lawFirmId]/client-invoice/[invoiceId]/page.tsx', // `sr-only` radio
  ];

  /**
   * The marker and the ring live in one `className` string, so a window around
   * the ring is enough to pair them without parsing JSX.
   */
  const WINDOW_BEFORE = 300;
  const WINDOW_AFTER = 100;

  const rings = sourceFiles(SRC).flatMap((file) => {
    const rel = file.slice(SRC.length + 1);
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/focus-within:ring/g)].map((match) => ({
      rel,
      window: text.slice(
        Math.max(0, match.index - WINDOW_BEFORE),
        match.index + WINDOW_AFTER,
      ),
    }));
  });

  it('finds the rings, so an empty pass cannot look like a clean one', () => {
    expect(rings.length).toBeGreaterThan(5);
    expect(rings.some(({ rel }) => rel.endsWith('HoursMinutesInput.tsx'))).toBe(true);
  });

  it('marks every fused cluster, so its cells drop their own outline', () => {
    const unmarked = rings
      .filter(({ rel }) => !HIDDEN_CONTROL.includes(rel))
      .filter(({ window }) => !window.includes('fused-field-group'))
      .map(({ rel }) => rel);
    expect(unmarked).toEqual([]);
  });

  it('drops the cell outline from the stylesheet, over the global !important', () => {
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const suppressing = [...bare.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline:\s*none\s*!important/.test(body))
      .map(([, selector]) => selector.trim());
    expect(suppressing.sort()).toEqual([
      '.fused-field-group :is(input, select, textarea, .fused-field-cell):focus-visible',
      PROGRAMMATIC_TARGET,
    ].sort());
  });
});

/**
 * Focus moved by script onto a non-interactive target, such as the intake
 * form's title on load or an error banner after a failed save, so a screen
 * reader announces it. Nothing there can be operated, so the outline only reads
 * as a stray box around a heading. Controls keep theirs even at tabindex -1.
 */
const PROGRAMMATIC_TARGET =
  '[tabindex="-1"]:not(:is(a, button, input, select, textarea, [role="option"], [role="menuitem"], [role="tab"])):focus-visible';

describe('a script-focused heading or message draws no outline', () => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...bare.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)]
    .find(([, selector]) => selector.trim() === PROGRAMMATIC_TARGET);

  it('suppresses the outline on tabindex -1 targets, over the global !important', () => {
    expect(rule?.[2]).toMatch(/outline:\s*none\s*!important/);
  });

  it('comes after the global rule, so it wins the equal !important', () => {
    expect(bare.indexOf(PROGRAMMATIC_TARGET)).toBeGreaterThan(bare.indexOf('*:focus-visible:not(.skip-link)'));
  });
});
