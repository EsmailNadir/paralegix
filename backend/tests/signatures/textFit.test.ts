/**
 * Signature field text fitting - pure unit tests.
 *
 * A signer types a value into a field of fixed size; this decides the font size
 * and the line breaks it is stamped with. The same algorithm exists twice, in
 * `frontend/src/lib/utils/textFit.ts` for the on-screen preview and here for the
 * authoritative executed PDF, so what it returns is what the signer is shown
 * AND what the signed document says.
 *
 * Two ways that goes wrong, both silent: text that overflows its box paints over
 * neighbouring content in the final PDF, and text truncated without an ellipsis
 * changes what the document says without looking truncated. So the assertions
 * below are mostly invariants over the RESULT (every line fits, the block fits,
 * the size stays in range) rather than expected strings, which would only pin
 * the one font metric the test happens to use.
 *
 * `measure` is a parameter, so a stub stands in for the PDF font metrics.
 *
 *   __TEST_TOKEN__=offline npx jest tests/signatures/textFit.test.ts
 */

const { fitTextToBox } = require('../../src/modules/signatures/textFit');

/** A monospace metric: every glyph is half the font size wide. */
const measure = (text: string, fontSize: number) => text.length * fontSize * 0.5;

/** The box padding the module reserves before wrapping. */
const usableWidth = (boxWidth: number) => Math.max(1, boxWidth - 8);

/** Asserts the three properties the caller stamps against. */
function expectFits(
  result: any,
  { boxWidth, boxHeight, maxFontSize, minFontSize = 5 }: any,
) {
  for (const line of result.lines) {
    expect({ line, width: measure(line, result.fontSize) <= usableWidth(boxWidth) })
      .toEqual({ line, width: true });
  }
  expect(result.lines.length * result.lineHeight).toBeLessThanOrEqual(boxHeight);
  expect(result.fontSize).toBeLessThanOrEqual(Math.max(minFontSize, maxFontSize));
  expect(result.fontSize).toBeGreaterThanOrEqual(minFontSize);
  expect(result.lineHeight).toBeCloseTo(result.fontSize * 1.15, 10);
}

describe('fitTextToBox', () => {
  test('short text in a roomy box keeps the requested size on one line', () => {
    const box = { boxWidth: 400, boxHeight: 100, maxFontSize: 14 };
    const result = fitTextToBox('Jane Doe', box.boxWidth, box.boxHeight, box.maxFontSize, measure);

    expect(result.lines).toEqual(['Jane Doe']);
    expect(result.fontSize).toBe(14);
    expectFits(result, box);
  });

  test('text too wide for one line is wrapped at word boundaries', () => {
    const box = { boxWidth: 120, boxHeight: 200, maxFontSize: 12 };
    const result = fitTextToBox(
      'the quick brown fox jumps over the lazy dog',
      box.boxWidth, box.boxHeight, box.maxFontSize, measure,
    );

    expect(result.lines.length).toBeGreaterThan(1);
    // Wrapping must not lose or invent words.
    expect(result.lines.join(' ').split(/\s+/).filter(Boolean))
      .toEqual('the quick brown fox jumps over the lazy dog'.split(' '));
    expectFits(result, box);
  });

  test('a short box shrinks the font rather than overflowing', () => {
    const box = { boxWidth: 120, boxHeight: 24, maxFontSize: 14 };
    const result = fitTextToBox(
      'the quick brown fox jumps over the lazy dog',
      box.boxWidth, box.boxHeight, box.maxFontSize, measure,
    );

    expect(result.fontSize).toBeLessThan(14);
    expectFits(result, box);
  });

  test('a single word wider than the box is broken by character', () => {
    // The one case word-wrapping alone cannot solve. Without the hard break the
    // line would be returned over-wide and paint outside the field.
    const box = { boxWidth: 40, boxHeight: 200, maxFontSize: 12 };
    const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
    const result = fitTextToBox(word, box.boxWidth, box.boxHeight, box.maxFontSize, measure);

    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.join('')).toBe(word); // every character survives, in order
    expectFits(result, box);
  });

  test('an explicit newline starts a new line even when the text would fit', () => {
    const box = { boxWidth: 400, boxHeight: 200, maxFontSize: 12 };
    const result = fitTextToBox('first\nsecond', box.boxWidth, box.boxHeight, box.maxFontSize, measure);

    expect(result.lines).toEqual(['first', 'second']);
    expectFits(result, box);
  });

  test('a blank paragraph is kept as a blank line', () => {
    // Dropping it would close up the spacing a signer deliberately typed.
    const box = { boxWidth: 400, boxHeight: 200, maxFontSize: 12 };
    const result = fitTextToBox('a\n\nb', box.boxWidth, box.boxHeight, box.maxFontSize, measure);

    expect(result.lines).toEqual(['a', '', 'b']);
  });

  test('text that cannot fit at the smallest size is truncated WITH an ellipsis', () => {
    // Silent truncation would change what the executed document says while
    // looking like the complete answer.
    const box = { boxWidth: 60, boxHeight: 12, maxFontSize: 12, minFontSize: 5 };
    const result = fitTextToBox(
      'a very long answer that simply cannot be made to fit inside this tiny field',
      box.boxWidth, box.boxHeight, box.maxFontSize, measure, box.minFontSize,
    );

    expect(result.fontSize).toBe(5); // shrank all the way first
    expect(result.lines[result.lines.length - 1]).toMatch(/…$/);
    expectFits(result, box);
  });

  test('the ellipsis itself is counted, so the truncated line still fits', () => {
    // Appending "…" after measuring the line is the obvious way to overflow by
    // exactly one glyph.
    const box = { boxWidth: 30, boxHeight: 10, maxFontSize: 10, minFontSize: 5 };
    const result = fitTextToBox(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      box.boxWidth, box.boxHeight, box.maxFontSize, measure, box.minFontSize,
    );

    expect(result.lines[result.lines.length - 1]).toMatch(/…$/);
    expectFits(result, box);
  });

  test('a box too short for even one line still yields one line', () => {
    // Returning zero lines would stamp an empty field where the signer answered.
    const result = fitTextToBox('answer', 100, 1, 12, measure);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].length).toBeGreaterThan(0);
  });

  test('a maxFontSize below the floor is raised to the floor, not honoured', () => {
    // Otherwise the loop starts below its own minimum and never runs.
    const result = fitTextToBox('x', 400, 200, 2, measure, 5);
    expect(result.fontSize).toBe(5);
  });

  test('empty and whitespace-only input do not throw', () => {
    expect(fitTextToBox('', 100, 50, 12, measure).lines).toEqual(['']);
    expect(fitTextToBox('   ', 100, 50, 12, measure).lines).toEqual(['']);
  });

  test('a wider box never needs a smaller font than a narrower one', () => {
    // Monotonicity: more room can only ever help. A break in this is how a
    // "fixed" field ends up rendering smaller than the one beside it.
    const text = 'the quick brown fox jumps over the lazy dog';
    let previous = 0;
    for (const boxWidth of [60, 120, 240, 480, 960]) {
      const { fontSize } = fitTextToBox(text, boxWidth, 40, 14, measure);
      expect({ boxWidth, monotonic: fontSize >= previous }).toEqual({ boxWidth, monotonic: true });
      previous = fontSize;
    }
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
