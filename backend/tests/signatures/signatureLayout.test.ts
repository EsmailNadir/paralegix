const {
  calculateSignatureLayout,
  calculateStandardSignatureLayout,
  calculateXLineSignatureLayout,
} = require('../../src/modules/signatures/signatureLayout');

describe('signatureLayout', () => {
  test('fits a wide standard signature inside the safe area', () => {
    const layout = calculateStandardSignatureLayout({
      boxWidth: 100,
      boxHeight: 40,
      imageAspectRatio: 4,
    });

    expect(layout.style).toBe('standard');
    expect(layout.imageRect).toEqual({
      x: 14,
      y: 11,
      width: 72,
      height: 18,
    });
  });

  test('fits a tall signature by height and centers it', () => {
    const layout = calculateStandardSignatureLayout({
      boxWidth: 100,
      boxHeight: 40,
      imageAspectRatio: 0.5,
    });

    expect(layout.imageRect.x).toBeCloseTo(43.2);
    expect(layout.imageRect.y).toBeCloseTo(6.4);
    expect(layout.imageRect.width).toBeCloseTo(13.6);
    expect(layout.imageRect.height).toBeCloseTo(27.2);
  });

  test('returns x-line geometry with the image above the line', () => {
    const layout = calculateXLineSignatureLayout({
      boxWidth: 220,
      boxHeight: 60,
      imageAspectRatio: 3.2,
    });

    expect(layout.style).toBe('x-line');
    expect(layout.line.x).toBeCloseTo(23.2);
    expect(layout.line.y).toBeCloseTo(52.8);
    expect(layout.line.width).toBeCloseTo(196.8);
    expect(layout.line.thickness).toBeCloseTo(1.5);
    expect(layout.xMark.fontSize).toBe(16);
    expect(layout.imageRect.y + layout.imageRect.height).toBeLessThan(layout.line.y);
  });

  test('keeps the signature inside a short field, resting on the line', () => {
    const layout = calculateXLineSignatureLayout({
      boxWidth: 200,
      boxHeight: 24,
      imageAspectRatio: 3.5,
    });

    // Contained: never spills above the box top.
    expect(layout.imageRect.y).toBeGreaterThanOrEqual(0);
    // Rests on (above) the line.
    expect(layout.imageRect.y + layout.imageRect.height).toBeLessThanOrEqual(layout.line.y + 0.001);
    // Fills most of the field's height rather than a thin strip.
    expect(layout.imageRect.height).toBeGreaterThan(24 * 0.6);
    // Stays within the line's width.
    expect(layout.imageRect.width).toBeLessThanOrEqual(layout.line.width + 0.001);
  });

  test('routes style selection through the shared entry point', () => {
    const standard = calculateSignatureLayout({
      boxWidth: 120,
      boxHeight: 48,
      imageAspectRatio: 2.8,
      style: 'standard',
    });
    const xLine = calculateSignatureLayout({
      boxWidth: 120,
      boxHeight: 48,
      imageAspectRatio: 2.8,
      style: 'x-line',
    });

    expect(standard.style).toBe('standard');
    expect(standard.line).toBeUndefined();
    expect(xLine.style).toBe('x-line');
    expect(xLine.line).toBeDefined();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
