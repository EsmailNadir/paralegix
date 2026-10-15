/**
 * Stamping a signature onto a page without damaging it.
 *
 * Every case here is a way the page gets corrupted while the response still
 * says the signature was placed:
 *
 *   A RESOURCE NAME COLLISION replaces one of the page's own images with the
 *   signature, so the page renders with a signature where a logo was.
 *
 *   MISSING q/Q lets the appearance's colour or clip leak into everything drawn
 *   after it on that page.
 *
 *   REPLACING /Contents discards the page's own content entirely.
 *
 *   IGNORING ROTATION OR CROP puts the signature off the page or on its side.
 */
import {
  planAppearance,
  placementToUserSpace,
  uniqueResourceName,
  PdfAppearanceError,
} from '../../../src/modules/signatures/pdf/appearances';
import type { ResolvedPage } from '../../../src/modules/signatures/pdf/pages';
import type { PdfDict, PdfValue } from '../../../src/modules/signatures/pdf/types';

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: 0 } });

/** A letter page, with whatever overrides a case needs. */
function page(over: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    index: 0,
    ref: { objectNumber: 3, generationNumber: 0 },
    dictionary: dict({ Type: name('Page') }),
    mediaBox: { x0: 0, y0: 0, x1: 612, y1: 792 },
    cropBox: { x0: 0, y0: 0, x1: 612, y1: 792 },
    rotate: 0,
    resources: null,
    userUnit: 1,
    ...over,
  };
}

const plan = (over: Partial<Parameters<typeof planAppearance>[0]> = {}) => planAppearance({
  page: page(),
  placement: { x: 100, y: 100, width: 200, height: 50 },
  bbox: { width: 400, height: 100 },
  appearanceResources: dict({ Font: dict({ F1: ref(9) }) }),
  formRef: { objectNumber: 10, generationNumber: 0 },
  contentRef: { objectNumber: 11, generationNumber: 0 },
  ...over,
});

const invocationText = (p: ReturnType<typeof planAppearance>) =>
  Buffer.from(p.invocation).toString('latin1');

describe('the resource name', () => {
  it('avoids one the page already uses', () => {
    // Taking it replaces one of the page's own XObjects, and the page renders
    // with a signature where a logo was.
    const resources = dict({ XObject: dict({ ParalegixSig0: ref(5) }) });

    expect(uniqueResourceName(resources, 'ParalegixSig')).toBe('ParalegixSig1');
  });

  it('works on a page with no resources at all', () => {
    expect(uniqueResourceName(null, 'ParalegixSig')).toBe('ParalegixSig0');
  });

  it('is the one the invocation actually uses', () => {
    const resources = dict({ XObject: dict({ ParalegixSig0: ref(5) }) });
    const result = plan({ page: page({ resources }) });

    expect(result.resourceName).toBe('ParalegixSig1');
    expect(invocationText(result)).toContain('/ParalegixSig1 Do');
  });
});

describe('the invocation', () => {
  it('is wrapped in q/Q', () => {
    // Without the save and restore, whatever state the appearance sets leaks
    // into everything drawn after it on that page.
    const text = invocationText(plan());

    expect(text.startsWith('q\n')).toBe(true);
    expect(text.trimEnd().endsWith('Q')).toBe(true);
  });

  it('scales the appearance to the placement', () => {
    // The appearance is authored once at a natural size and fitted here, so a
    // 400x100 design placed in a 200x50 box is drawn at half scale.
    const text = invocationText(plan());

    expect(text).toContain('0.5 0 0 0.5 0 0 cm');
  });

  it('writes no exponent notation', () => {
    // PDF has no exponent form. A viewer that shrugs at `1e-7` is not the one
    // verifying the signature.
    const text = invocationText(plan({
      placement: { x: 0, y: 0, width: 0.0001, height: 0.0001 },
      bbox: { width: 1000, height: 1000 },
    }));

    expect(text).not.toMatch(/e-?\d/i);
  });
});

describe('placing it in user space', () => {
  it('leaves an unrotated page alone', () => {
    const { matrix } = placementToUserSpace(page(), { x: 100, y: 200, width: 50, height: 20 });

    expect(matrix).toEqual([1, 0, 0, 1, 100, 200]);
  });

  it('shifts by a nonzero crop origin', () => {
    // A page whose visible area starts at (20, 30) needs everything shifted, or
    // the signature sits a margin away from where the signer put it.
    const { matrix } = placementToUserSpace(
      page({ cropBox: { x0: 20, y0: 30, x1: 592, y1: 762 } }),
      { x: 100, y: 200, width: 50, height: 20 },
    );

    expect(matrix[4]).toBe(120);
    expect(matrix[5]).toBe(230);
  });

  it('rotates the transform for a rotated page', () => {
    // A viewer showing a page turned 90 degrees reports a width that is the
    // page's height, so a placement in what the user saw is not one in the page.
    const { matrix } = placementToUserSpace(page({ rotate: 90 }), { x: 0, y: 0, width: 50, height: 20 });

    expect(matrix.slice(0, 4)).toEqual([0, 1, -1, 0]);
  });

  /**
   * The rotation columns alone are not the transform.
   *
   * A wrong TRANSLATION still puts a signature on the page. It is simply a
   * box-dimension away from where the signer put it, which reads as a layout
   * quirk rather than as a defect, and the four rotation numbers are identical
   * either way. So these cases compare the user-space rectangle the matrix
   * actually draws into against the rectangle the placement occupies, derived
   * independently from the page's own display mapping.
   */
  describe('the translation, not just the rotation', () => {
    /** The user-space box the matrix maps the form's BBox onto. */
    function drawnRect(matrix: number[], width: number, height: number) {
      const [a, b, c, d, e, f] = matrix;
      const corners = [[0, 0], [width, 0], [0, height], [width, height]]
        .map(([s, t]) => [a * s + c * t + e, b * s + d * t + f]);
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      return {
        x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      };
    }

    /**
     * Where a visible rectangle sits in user space, worked out from the page's
     * display mapping rather than from the code under test.
     *
     * For /Rotate 90 the sheet is turned clockwise, so a user point (u, v)
     * appears at (v - y0, cropWidth - (u - x0)). Inverting that gives
     * u = x0 + cropWidth - Y and v = y0 + X. The other angles follow the same
     * way.
     */
    function expectedRect(
      rotate: number,
      box: { x: number; y: number; width: number; height: number },
      crop = { x0: 0, y0: 0, x1: 612, y1: 792 },
    ) {
      const cw = crop.x1 - crop.x0;
      const ch = crop.y1 - crop.y0;
      const { x, y, width, height } = box;
      if (rotate === 90) {
        return {
          x0: crop.x0 + cw - y - height, y0: crop.y0 + x,
          x1: crop.x0 + cw - y, y1: crop.y0 + x + width,
        };
      }
      if (rotate === 180) {
        return {
          x0: crop.x0 + cw - x - width, y0: crop.y0 + ch - y - height,
          x1: crop.x0 + cw - x, y1: crop.y0 + ch - y,
        };
      }
      if (rotate === 270) {
        return {
          x0: crop.x0 + y, y0: crop.y0 + ch - x - width,
          x1: crop.x0 + y + height, y1: crop.y0 + ch - x,
        };
      }
      return {
        x0: crop.x0 + x, y0: crop.y0 + y, x1: crop.x0 + x + width, y1: crop.y0 + y + height,
      };
    }

    const BOX = { x: 60, y: 560, width: 180, height: 80 };

    for (const rotate of [0, 90, 180, 270]) {
      it(`draws into the rectangle the placement occupies at /Rotate ${rotate}`, () => {
        // At /Rotate 90 the visible page is 792 by 612, so this box fits.
        const box = rotate === 90 || rotate === 270
          ? { x: 60, y: 160, width: 180, height: 80 }
          : BOX;

        const { matrix, width, height } = placementToUserSpace(page({ rotate }), box);

        expect(drawnRect(matrix, width, height)).toEqual(expectedRect(rotate, box));
      });
    }

    it('holds when the crop box does not start at the origin', () => {
      // A nonzero crop origin shifts every case, and it is the one a rotated
      // scan actually has.
      const crop = { x0: 20, y0: 30, x1: 632, y1: 822 };
      const box = { x: 40, y: 100, width: 120, height: 60 };

      const { matrix, width, height } = placementToUserSpace(
        page({ rotate: 90, cropBox: crop, mediaBox: crop }), box,
      );

      expect(drawnRect(matrix, width, height)).toEqual(expectedRect(90, box, crop));
    });
  });

  it('divides out UserUnit', () => {
    const { matrix } = placementToUserSpace(page({ userUnit: 2 }), { x: 100, y: 100, width: 50, height: 20 });

    expect(matrix[4]).toBe(50);
  });

  it('refuses a placement that does not fit, rather than clamping it', () => {
    // A clamped placement is a signature somewhere the signer did not put it,
    // which is worse than an error.
    expect(() => placementToUserSpace(page(), { x: 600, y: 100, width: 200, height: 50 }))
      .toThrow(/does not fit/i);
  });

  it('refuses a placement with no area', () => {
    expect(() => placementToUserSpace(page(), { x: 10, y: 10, width: 0, height: 50 }))
      .toThrow(PdfAppearanceError);
  });
});

describe('updating the page', () => {
  it('appends to /Contents rather than replacing it', () => {
    // Replacing it discards the page.
    const original = dict({ Type: name('Page'), Contents: ref(4) });
    const result = plan({ page: page({ dictionary: original }) });

    const contents = result.updatedPage.entries.get('Contents') as any;
    expect(contents.kind).toBe('array');
    expect(contents.values).toHaveLength(2);
    expect(contents.values[0]).toEqual(ref(4));
  });

  it('extends an existing /Contents array', () => {
    const original = dict({
      Type: name('Page'),
      Contents: { kind: 'array', values: [ref(4), ref(5)] },
    });
    const result = plan({ page: page({ dictionary: original }) });

    expect((result.updatedPage.entries.get('Contents') as any).values).toHaveLength(3);
  });

  it('creates /Contents when the page has none', () => {
    const result = plan({ page: page({ dictionary: dict({ Type: name('Page') }) }) });

    expect(result.updatedPage.entries.get('Contents')).toEqual(ref(11));
  });

  it('keeps the page own other entries', () => {
    const original = dict({ Type: name('Page'), Parent: ref(2), Annots: { kind: 'array', values: [] } });
    const result = plan({ page: page({ dictionary: original }) });

    expect(result.updatedPage.entries.get('Parent')).toEqual(ref(2));
    expect(result.updatedPage.entries.get('Annots')).toBeDefined();
  });

  it('does not mutate the original page dictionary', () => {
    // The page came from the reader and may be shared. Editing it in place
    // changes what every other caller sees.
    const original = dict({ Type: name('Page') });
    plan({ page: page({ dictionary: original }) });

    expect(original.entries.has('Contents')).toBe(false);
  });

  it('materializes inherited resources on the leaf', () => {
    // Editing the INHERITED dictionary in place would add this signature's
    // XObject to every page that shares it.
    const inherited = dict({ Font: dict({ F1: ref(9) }) });
    const result = plan({ page: page({ resources: inherited }) });

    const resources = result.updatedPage.entries.get('Resources') as PdfDict;
    expect(resources.entries.get('Font')).toBeDefined();
    expect(resources.entries.get('XObject')).toBeDefined();
    expect(inherited.entries.has('XObject')).toBe(false);
  });

  it('keeps the page existing XObjects alongside the new one', () => {
    const resources = dict({ XObject: dict({ Logo: ref(7) }) });
    const result = plan({ page: page({ resources }) });

    const xobjects = (result.updatedPage.entries.get('Resources') as PdfDict)
      .entries.get('XObject') as PdfDict;
    expect(xobjects.entries.get('Logo')).toEqual(ref(7));
    expect(xobjects.entries.get(result.resourceName)).toEqual(ref(10));
  });
});

describe('the form', () => {
  it('carries its own resources and bbox', () => {
    // Self-contained, which is what keeps it from interfering with the page it
    // lands on.
    const result = plan();

    expect(result.formDictionary.entries.get('Subtype')).toEqual(name('Form'));
    expect(result.formDictionary.entries.get('Resources')).toBeDefined();
    expect((result.formDictionary.entries.get('BBox') as any).values).toEqual([0, 0, 400, 100]);
  });
});
