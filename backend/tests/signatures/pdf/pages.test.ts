/**
 * Finding a page and working out where it actually is.
 *
 * Pages are a TREE, and several attributes are inherited from ancestors rather
 * than repeated on every leaf. So "page 3" is a walk, and a page's size may be
 * stated three levels up.
 *
 * Every case here is a way a signature ends up in the wrong place while the
 * response still says success:
 *
 *   INHERITANCE lost: the page has no MediaBox of its own, so the size comes
 *   from an ancestor. Missed, the page looks sizeless.
 *
 *   ROTATION ignored: a rotated scan swaps width and height, so a placement
 *   computed from raw numbers lands off the page.
 *
 *   CROP ORIGIN ignored: a page whose visible area does not start at (0, 0)
 *   needs every placement shifted, or the signature sits a margin away.
 *
 *   /Count trusted: a corrupt count silently truncates the document.
 */
import { readDocumentIndex } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages, visibleGeometry, PdfPageError } from '../../../src/modules/signatures/pdf/pages';
import type { PdfSource } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

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
function document(objects: Array<{ n: number; body: string }>) {
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

const load = async (text: string) => {
  const source = sourceOver(text);
  return resolvePages(source, await readDocumentIndex(source, signal), signal);
};

describe('walking the tree', () => {
  it('finds pages in order across a nested tree', async () => {
    const pages = await load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 3 /Kids [3 0 R 6 0 R] /MediaBox [0 0 612 792] >>' },
      { n: 3, body: '<< /Type /Pages /Count 2 /Kids [4 0 R 5 0 R] >>' },
      { n: 4, body: '<< /Type /Page /Order 1 >>' },
      { n: 5, body: '<< /Type /Page /Order 2 >>' },
      { n: 6, body: '<< /Type /Page /Order 3 >>' },
    ]));

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.dictionary.entries.get('Order'))).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('inherits geometry from an ancestor', async () => {
    // The leaf has no MediaBox. Missed, the page looks sizeless.
    const pages = await load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>' },
      { n: 3, body: '<< /Type /Page >>' },
    ]));

    expect(pages[0].mediaBox).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('lets a leaf override what it inherits', async () => {
    // Mixed paper sizes in one document are ordinary: a letter body with one
    // A3 exhibit. Taking the ancestor's box places the signature off that page.
    const pages = await load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 612 792] >>' },
      { n: 3, body: '<< /Type /Page >>' },
      { n: 4, body: '<< /Type /Page /MediaBox [0 0 842 1191] >>' },
    ]));

    expect(pages[0].mediaBox.x1).toBe(612);
    expect(pages[1].mediaBox.x1).toBe(842);
  });

  it('inherits resources', async () => {
    const pages = await load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] /Resources << /ProcSet [/PDF] >> >>' },
      { n: 3, body: '<< /Type /Page >>' },
    ]));

    expect(pages[0].resources).not.toBeNull();
  });

  it('refuses a tree that points back at itself', async () => {
    const pages = load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>' },
      { n: 3, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    ]));

    await expect(pages).rejects.toThrow(/points back at itself/i);
  });

  it('refuses a /Count that disagrees with the tree', async () => {
    // Checked AFTER the walk rather than trusted before it, so a wrong count is
    // an error instead of a silently short document.
    const pages = load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 9 /Kids [3 0 R] /MediaBox [0 0 612 792] >>' },
      { n: 3, body: '<< /Type /Page >>' },
    ]));

    await expect(pages).rejects.toThrow(/says it has 9 pages/i);
  });
});

describe('geometry', () => {
  const withPage = (extra: string) => document([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    { n: 3, body: `<< /Type /Page /MediaBox [0 0 612 792] ${extra} >>` },
  ]);

  it('refuses a page with no MediaBox anywhere', async () => {
    // NOT defaulted to US Letter. A default puts the signature at coordinates
    // that are right for a page which does not exist.
    const pages = load(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
      { n: 3, body: '<< /Type /Page >>' },
    ]));

    await expect(pages).rejects.toThrow(/no usable MediaBox/i);
  });

  it('normalizes a box whose corners are the other way round', async () => {
    // The spec allows either order. Layout code that assumes x0 < x1 places a
    // signature off the page when they are reversed.
    const pages = await load(withPage('/MediaBox [612 792 0 0]'));

    expect(pages[0].mediaBox).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('defaults CropBox to MediaBox, which is in the spec', async () => {
    const pages = await load(withPage(''));

    expect(pages[0].cropBox).toEqual(pages[0].mediaBox);
  });

  it('swaps width and height for a rotated page', async () => {
    // A rotated scan is ordinary. A placement computed from raw numbers lands
    // off the page.
    const pages = await load(withPage('/Rotate 90'));

    const geometry = visibleGeometry(pages[0]);
    expect(geometry.width).toBe(792);
    expect(geometry.height).toBe(612);
  });

  it('folds a rotation outside 0..359', async () => {
    const pages = await load(withPage('/Rotate -90'));

    expect(pages[0].rotate).toBe(270);
  });

  it('refuses a rotation that is not a multiple of 90', async () => {
    await expect(load(withPage('/Rotate 45'))).rejects.toThrow(/multiple of 90/i);
  });

  it('carries a nonzero crop origin', async () => {
    // Every placement on this page has to shift by the origin, or the signature
    // sits a margin away from where it was put.
    const pages = await load(withPage('/CropBox [20 30 592 762]'));

    const geometry = visibleGeometry(pages[0]);
    expect(geometry.originX).toBe(20);
    expect(geometry.originY).toBe(30);
    expect(geometry.width).toBe(572);
  });

  it('applies UserUnit to the visible size', async () => {
    const pages = await load(withPage('/UserUnit 2'));

    expect(visibleGeometry(pages[0]).width).toBe(1224);
  });

  it('refuses a UserUnit that is not positive', async () => {
    await expect(load(withPage('/UserUnit 0'))).rejects.toThrow(/UserUnit/i);
  });

  it('refuses a box with no area', async () => {
    await expect(load(withPage('/MediaBox [10 10 10 10]'))).rejects.toThrow(/no area/i);
  });

  it('refuses a box that is not four numbers', async () => {
    await expect(load(withPage('/MediaBox [0 0 612]'))).rejects.toThrow(/four numbers/i);
  });
});
