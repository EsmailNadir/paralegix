/**
 * Turning a field the signer positioned in the viewer into a spot on a real page.
 *
 * The viewer stores a field as PERCENTAGES of the page it displays, measured
 * from the page's top left. A percentage is only meaningful against the page a
 * viewer actually shows, which is the CROP box, turned by `/Rotate` and scaled
 * by `/UserUnit`. Every case here is a way that agreement breaks while the
 * response still says the signature was placed:
 *
 *   ROTATION ignored: a 90 degree scan shows a page whose width is the page's
 *   height, so a percentage taken against the raw MediaBox lands on its side.
 *
 *   CROP ORIGIN ignored: a page whose visible area starts at (50, 30) needs
 *   every placement shifted by that, or the field sits a margin away.
 *
 *   /UserUnit ignored: the percentage is scale free, so the same field on a
 *   scaled page has to resolve to the same user space rectangle. Multiplying it
 *   twice puts the field off the sheet.
 *
 *   A PAGE OR RECTANGLE THAT DOES NOT RESOLVE, skipped: the field silently does
 *   not appear, and the document completes as though the signer had signed it.
 */
import { readDocumentIndex } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages } from '../../../src/modules/signatures/pdf/pages';
import { planAppearance } from '../../../src/modules/signatures/pdf/appearances';
import {
  placeField,
  planFieldPlacements,
  preflightFieldPlacements,
  visibleRectToUserRect,
  findUnplaceableFields,
  signatureFormLayout,
  PdfFieldPlacementError,
} from '../../../src/modules/signatures/pdf/fieldPlacement';
import type { ResolvedPage } from '../../../src/modules/signatures/pdf/pages';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: 0 } });

/** A page with whatever geometry a case needs. */
function page(over: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    index: 0,
    ref: { objectNumber: 3, generationNumber: 0 },
    dictionary: dict({ Type: name('Page') }),
    mediaBox: { x0: 0, y0: 0, x1: 600, y1: 800 },
    cropBox: { x0: 0, y0: 0, x1: 600, y1: 800 },
    rotate: 0,
    resources: null,
    userUnit: 1,
    ...over,
  };
}

/**
 * The field every geometry case uses.
 *
 * Against a 600 x 800 display that is a box 60 from the left, 160 from the top,
 * 180 wide and 80 tall, so its bottom edge is 800 - 160 - 80 = 560 up from the
 * bottom of what the viewer shows.
 */
const FIELD = {
  id: 'f-1',
  page: 1,
  xPercent: 10,
  yPercent: 20,
  widthPercent: 30,
  heightPercent: 10,
};

const close = (rect: { x0: number; y0: number; x1: number; y1: number }) => ({
  x0: Number(rect.x0.toFixed(6)),
  y0: Number(rect.y0.toFixed(6)),
  x1: Number(rect.x1.toFixed(6)),
  y1: Number(rect.y1.toFixed(6)),
});

describe('the viewer contract', () => {
  it('reads a percent box against the page the viewer displays', () => {
    // What the viewer draws: left = 10% of 600, top = 20% of 800, 30% wide and
    // 10% tall. The placement is the same box measured from the BOTTOM, which
    // is the origin every PDF coordinate uses.
    const visibleWidth = 600;
    const visibleHeight = 800;
    const viewerLeft = (FIELD.xPercent / 100) * visibleWidth; // 60
    const viewerTop = (FIELD.yPercent / 100) * visibleHeight; // 160
    const viewerWidth = (FIELD.widthPercent / 100) * visibleWidth; // 180
    const viewerHeight = (FIELD.heightPercent / 100) * visibleHeight; // 80

    const { placement } = placeField(FIELD, [page()]);

    expect(placement.x).toBeCloseTo(viewerLeft, 9);
    expect(placement.width).toBeCloseTo(viewerWidth, 9);
    expect(placement.height).toBeCloseTo(viewerHeight, 9);
    expect(placement.y).toBeCloseTo(visibleHeight - viewerTop - viewerHeight, 9);
    expect(placement.y).toBeCloseTo(560, 9);
  });

  it('measures against the ROTATED size, not the raw MediaBox', () => {
    // An 800 x 600 page turned 90 degrees displays as 600 x 800, so the same
    // field is the same box on screen as on the unrotated 600 x 800 page.
    // Measuring against the MediaBox instead would give 80 wide by 60 tall.
    const landscape = page({
      mediaBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      cropBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      rotate: 90,
    });

    const { placement } = placeField(FIELD, [landscape]);

    expect(placement.x).toBeCloseTo(60, 9);
    expect(placement.y).toBeCloseTo(560, 9);
    expect(placement.width).toBeCloseTo(180, 9);
    expect(placement.height).toBeCloseTo(80, 9);
  });
});

describe('converting the visible box into page user space', () => {
  it('leaves an unrotated, uncropped page alone', () => {
    const { rect } = placeField(FIELD, [page()]);

    expect(close(rect)).toEqual({ x0: 60, y0: 560, x1: 240, y1: 640 });
  });

  it('maps a page rotated 90', () => {
    // The display is 600 x 800; its top left corner is the page's bottom left,
    // so ux = 800 - viewY and uy = viewX. The box spans viewY 560..640 and
    // viewX 60..240, which is ux 160..240 and uy 60..240.
    const rotated = page({
      mediaBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      cropBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      rotate: 90,
    });

    const { rect } = placeField(FIELD, [rotated]);

    expect(close(rect)).toEqual({ x0: 160, y0: 60, x1: 240, y1: 240 });
  });

  it('maps a page rotated 180', () => {
    // Both axes flip: ux = 600 - viewX, uy = 800 - viewY. A field near the top
    // left of the display is near the bottom right of the page.
    const { rect } = placeField(FIELD, [page({ rotate: 180 })]);

    expect(close(rect)).toEqual({ x0: 360, y0: 160, x1: 540, y1: 240 });
  });

  it('maps a page rotated 270', () => {
    // ux = viewY and uy = 600 - viewX. viewY 560..640 is ux 560..640, and
    // viewX 60..240 is uy 360..540.
    const rotated = page({
      mediaBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      cropBox: { x0: 0, y0: 0, x1: 800, y1: 600 },
      rotate: 270,
    });

    const { rect } = placeField(FIELD, [rotated]);

    expect(close(rect)).toEqual({ x0: 560, y0: 360, x1: 640, y1: 540 });
  });

  it('shifts by a nonzero CropBox origin', () => {
    // The visible area is still 600 x 800, but it starts at (50, 30) in user
    // space. Ignoring the origin puts the field a margin away, at 60 / 560.
    const cropped = page({
      mediaBox: { x0: 0, y0: 0, x1: 700, y1: 900 },
      cropBox: { x0: 50, y0: 30, x1: 650, y1: 830 },
    });

    const { rect } = placeField(FIELD, [cropped]);

    expect(close(rect)).toEqual({ x0: 110, y0: 590, x1: 290, y1: 670 });
  });

  it('divides /UserUnit back out, so a scaled page holds the field in the same place', () => {
    // A 300 x 400 page with /UserUnit 2 displays at 600 x 800. The percentages
    // are scale free, so the field has to land on exactly the same user space
    // rectangle as on the unscaled 300 x 400 page. Leaving the unit in doubles
    // it, to 60 / 280.
    const scaled = page({
      mediaBox: { x0: 0, y0: 0, x1: 300, y1: 400 },
      cropBox: { x0: 0, y0: 0, x1: 300, y1: 400 },
      userUnit: 2,
    });
    const unscaled = page({
      mediaBox: { x0: 0, y0: 0, x1: 300, y1: 400 },
      cropBox: { x0: 0, y0: 0, x1: 300, y1: 400 },
    });

    expect(close(placeField(FIELD, [scaled]).rect))
      .toEqual(close(placeField(FIELD, [unscaled]).rect));
    expect(close(placeField(FIELD, [scaled]).rect))
      .toEqual({ x0: 30, y0: 280, x1: 120, y1: 320 });
  });

  it('refuses a rectangle that runs off the visible page rather than clamping it', () => {
    // 90% from the left plus 30% wide is 720 on a 600 wide display. Clamping it
    // to the edge is a signature somewhere the signer did not put it.
    expect(() => visibleRectToUserRect(page(), { x: 540, y: 100, width: 180, height: 40 }))
      .toThrow(/does not fit/i);
  });
});

describe('refusing before an invitation goes out', () => {
  it('refuses a field naming a page the document does not have', () => {
    // Not "skip it": the signer would sign a document missing the field they
    // were asked to fill, and nothing in the response would say so.
    const fields = [{ ...FIELD, id: 'f-off', page: 5 }];

    expect(() => preflightFieldPlacements(fields, [page()])).toThrow(PdfFieldPlacementError);
    try {
      preflightFieldPlacements(fields, [page()]);
    } catch (err) {
      expect((err as PdfFieldPlacementError).failures).toEqual([
        { fieldId: 'f-off', page: 5, reason: expect.stringMatching(/page 5/i) },
      ]);
    }
  });

  it('refuses a field whose rectangle falls outside the visible page', () => {
    const fields = [{ ...FIELD, id: 'f-wide', xPercent: 90, widthPercent: 30 }];

    expect(() => preflightFieldPlacements(fields, [page()])).toThrow(/does not fit/i);
  });

  it('reports every bad field at once rather than only the first', () => {
    const fields = [
      { ...FIELD, id: 'f-ok' },
      { ...FIELD, id: 'f-off', page: 5 },
      { ...FIELD, id: 'f-wide', xPercent: 90, widthPercent: 30 },
    ];

    try {
      preflightFieldPlacements(fields, [page()]);
      throw new Error('preflight should have refused');
    } catch (err) {
      expect((err as PdfFieldPlacementError).failures.map((f) => f.fieldId))
        .toEqual(['f-off', 'f-wide']);
    }
  });

  it('returns every placement when they all resolve', () => {
    const fields = [{ ...FIELD, id: 'f-a' }, { ...FIELD, id: 'f-b', yPercent: 50 }];

    const placed = preflightFieldPlacements(fields, [page()]);

    expect(placed.map((p) => p.fieldId)).toEqual(['f-a', 'f-b']);
    expect(close(placed[1].rect)).toEqual({ x0: 60, y0: 320, x1: 240, y1: 400 });
  });

  it('lists the problems without throwing, for a caller that wants to decide', () => {
    // The flattening stamper works from plain page sizes rather than resolved
    // pages, and has to reach the same verdict as the incremental writer.
    const sizes = [{ width: 600, height: 800 }];

    expect(findUnplaceableFields([FIELD], sizes)).toEqual([]);
    expect(findUnplaceableFields([{ ...FIELD, page: 5 }], sizes)).toEqual([
      { fieldId: 'f-1', page: 5, reason: expect.stringMatching(/page 5/i) },
    ]);
    expect(findUnplaceableFields([{ ...FIELD, xPercent: 90, widthPercent: 30 }], sizes)[0].reason)
      .toMatch(/does not fit/i);
  });

  it('treats a field with no page as page one, not as unplaceable', () => {
    // The oldest stored fields carry no page at all, and the stamper has always
    // read that as the first page.
    const { page: field, ...noPage } = FIELD;
    expect(field).toBe(1);
    expect(findUnplaceableFields([noPage as typeof FIELD], [{ width: 600, height: 800 }]))
      .toEqual([]);
    expect(close(placeField(noPage as typeof FIELD, [page()]).rect))
      .toEqual({ x0: 60, y0: 560, x1: 240, y1: 640 });
  });
});

describe('after consent, a bad field is recoverable rather than fatal', () => {
  it('places what it can and reports what it could not, without throwing', () => {
    // The signer has already consented. Refusing here discards that consent and
    // leaves the session with no way forward; the failure has to be carried out
    // so the document can be repaired and finalized again.
    const fields = [
      { ...FIELD, id: 'f-ok' },
      { ...FIELD, id: 'f-off', page: 9 },
      { ...FIELD, id: 'f-wide', xPercent: 90, widthPercent: 30 },
    ];

    const { placed, failures } = planFieldPlacements(fields, [page()]);

    expect(placed.map((p) => p.fieldId)).toEqual(['f-ok']);
    expect(failures.map((f) => f.fieldId)).toEqual(['f-off', 'f-wide']);
    expect(failures[0].page).toBe(9);
    expect(failures[1].reason).toMatch(/does not fit/i);
  });

  it('reports nothing when every field resolves', () => {
    const { placed, failures } = planFieldPlacements([FIELD], [page()]);

    expect(failures).toEqual([]);
    expect(placed).toHaveLength(1);
  });
});

describe('the appearance layout inside the field box', () => {
  it('flips the shared layout into the form own bottom up coordinates', () => {
    // signatureLayout measures from the box TOP, the way the browser stamper
    // draws. A Form XObject measures from its bottom left. For a 100 x 40
    // x-line box holding a 4:1 signature the shared layout puts the image at
    // y 15.25 from the top and 18.35 tall, so its bottom sits
    // 40 - 15.25 - 18.35 = 6.4 up from the bottom of the box.
    const layout = signatureFormLayout({
      boxWidth: 100,
      boxHeight: 40,
      imageAspectRatio: 4,
      style: 'x-line',
    });

    expect(layout.imageRect.x).toBeCloseTo(22.6, 6);
    expect(layout.imageRect.y).toBeCloseTo(6.4, 6);
    expect(layout.imageRect.width).toBeCloseTo(73.4, 6);
    expect(layout.imageRect.height).toBeCloseTo(18.35, 6);
    // The rule sits at 35.2 down from the top, so 4.8 up from the bottom.
    expect(layout.line?.y).toBeCloseTo(4.8, 6);
    // The X is drawn from its baseline: 22.6 down from the top of a 14pt glyph.
    expect(layout.xMark?.y).toBeCloseTo(3.4, 6);
    expect(layout.xMark?.fontSize).toBeCloseTo(14, 6);
  });

  it('keeps a standard layout inside the box', () => {
    const layout = signatureFormLayout({ boxWidth: 100, boxHeight: 40, imageAspectRatio: 4 });

    expect(layout.line).toBeUndefined();
    expect(layout.imageRect.y).toBeGreaterThanOrEqual(0);
    expect(layout.imageRect.y + layout.imageRect.height).toBeLessThanOrEqual(40);
  });
});

/** A source over a literal document, so a real page tree can be walked. */
function sourceOver(text: string): PdfSource {
  const bytes = Buffer.from(text, 'latin1');
  return {
    ref: { objectPath: 'test.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) { yield new Uint8Array(bytes.subarray(start, endExclusive)); },
    async close() {},
  };
}

/** A classic-xref document from a list of object bodies. */
function documentText(objects: Array<{ n: number; body: string }>) {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const obj of objects) {
    offsets.set(obj.n, out.length);
    out += `${obj.n} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefAt = out.length;
  const max = Math.max(...objects.map((o) => o.n));
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n += 1) {
    out += offsets.has(n)
      ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

describe('a leaf page that inherits its resources', () => {
  it('carries the inherited resources onto the leaf and keeps every entry it had', async () => {
    // The leaf has an /Annots array, a /Parent and a /Contents of its own but no
    // /Resources: its font comes from the ancestor. Writing the signature's
    // XObject into the ANCESTOR would add it to every page that shares it, and
    // replacing the leaf outright would drop its annotations.
    const source = sourceOver(documentText([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      {
        n: 2,
        body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 600 800] '
          + '/Resources << /Font << /F1 9 0 R >> >> >>',
      },
      {
        n: 3,
        body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [7 0 R] /Tabs /S >>',
      },
    ]));
    const pages = await resolvePages(source, await readDocumentIndex(source, signal), signal);
    const { page: leaf, placement } = placeField(FIELD, pages);

    const result = planAppearance({
      page: leaf,
      placement,
      bbox: { width: 180, height: 80 },
      appearanceResources: dict({}),
      formRef: { objectNumber: 10, generationNumber: 0 },
      contentRef: { objectNumber: 11, generationNumber: 0 },
    });

    const resources = result.updatedPage.entries.get('Resources') as PdfDict;
    expect(resources.entries.get('Font')).toEqual(dict({ F1: ref(9) }));
    expect((resources.entries.get('XObject') as PdfDict).entries.get(result.resourceName))
      .toEqual(ref(10));

    // Everything the leaf already had survives.
    expect(result.updatedPage.entries.get('Annots')).toEqual({ kind: 'array', values: [ref(7)] });
    expect(result.updatedPage.entries.get('Parent')).toEqual(ref(2));
    expect(result.updatedPage.entries.get('Tabs')).toEqual(name('S'));
    expect(result.updatedPage.entries.get('Type')).toEqual(name('Page'));

    // The ancestor is untouched, so no other page gains this signature.
    const ancestorResources = pages[0].resources as PdfDict;
    expect(ancestorResources.entries.has('XObject')).toBe(false);
  });

  it('refuses a field on a page the real document does not have', async () => {
    const source = sourceOver(documentText([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 600 800] >>' },
      { n: 3, body: '<< /Type /Page >>' },
    ]));
    const pages = await resolvePages(source, await readDocumentIndex(source, signal), signal);

    expect(() => placeField({ ...FIELD, page: 2 }, pages)).toThrow(PdfFieldPlacementError);
  });
});
