/**
 * Appending a certificate page without rebuilding the page tree.
 *
 * A normal PDF library does this by loading the document and writing it out
 * again, which for a large scan is what cannot happen. Incrementally it is three
 * small objects, and the whole risk sits in ONE of them: the replacement root
 * `/Pages`.
 *
 * That node usually carries the inherited `/MediaBox` and `/Resources` for every
 * page beneath it. Building a fresh one loses them, every existing page becomes
 * sizeless, and the document is broken by the act of appending to it. So the
 * cases below are mostly about what the copy preserves.
 */
import { readDocumentIndex } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages } from '../../../src/modules/signatures/pdf/pages';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import {
  nextObjectNumber,
  planAppendedPages,
  PdfAppendError,
} from '../../../src/modules/signatures/pdf/appendPage';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';
import { minimalPdf } from '../../support/minimalPdf';

const signal = new AbortController().signal;
const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });

function sourceOver(bytes: Buffer): PdfSource {
  return {
    ref: { objectPath: 'test.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, end) { yield new Uint8Array(bytes.subarray(start, end)); },
    async close() {},
  };
}

/** A two-page document whose root /Pages carries the inherited geometry. */
function baseDocument(pagesExtra = '/MediaBox [0 0 612 792] /Resources << /ProcSet [/PDF] >>') {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  const objects: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] ${pagesExtra} >>`],
    [3, '<< /Type /Page /Parent 2 0 R >>'],
    [4, '<< /Type /Page /Parent 2 0 R >>'],
  ];
  for (const [n, body] of objects) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 5\n0000000000 65535 f \n';
  for (let n = 1; n <= 4; n += 1) out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: Buffer.from(out, 'latin1'), xrefAt };
}

const load = async (bytes: Buffer) => {
  const source = sourceOver(bytes);
  return { source, index: await readDocumentIndex(source, signal) };
};

describe('planning the append', () => {
  it('adds the new page to Kids and raises Count', async () => {
    const base = baseDocument();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: 5, generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    });

    expect((plan.pagesDictionary.entries.get('Kids') as any).values).toHaveLength(3);
    expect(plan.pagesDictionary.entries.get('Count')).toBe(3);
  });

  it('KEEPS the inherited geometry the root carries', async () => {
    // The failure this exists for. A freshly built node loses these, every
    // existing page becomes sizeless, and the document breaks by being appended
    // to.
    const base = baseDocument();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: 5, generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    });

    expect(plan.pagesDictionary.entries.get('MediaBox')).toBeDefined();
    expect(plan.pagesDictionary.entries.get('Resources')).toBeDefined();
  });

  it('gives the new page a /Parent', async () => {
    // A leaf without one is unreachable when a viewer walks UP from the page.
    const base = baseDocument();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: 5, generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    });

    expect(plan.pages[0].dictionary.entries.get('Parent')).toEqual(
      { kind: 'ref', value: { objectNumber: 2, generationNumber: 0 } },
    );
  });

  it('appends several pages at once, for a multi-page certificate', async () => {
    const base = baseDocument();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [
        { objectNumber: 5, generationNumber: 0 },
        { objectNumber: 6, generationNumber: 0 },
      ],
      newPages: [dict({ Type: name('Page') }), dict({ Type: name('Page') })],
    });

    expect(plan.pagesDictionary.entries.get('Count')).toBe(4);
    expect(plan.pages).toHaveLength(2);
  });

  it('refuses a page tree that is not an indirect object', async () => {
    // It cannot be replaced by object number, so the catalog would have to be
    // rewritten too. Refused rather than half-handled.
    let out = '%PDF-1.7\n';
    const at = out.length;
    out += '1 0 obj\n<< /Type /Catalog /Pages << /Type /Pages /Count 0 /Kids [] >> >>\nendobj\n';
    const xrefAt = out.length;
    out += `xref\n0 2\n0000000000 65535 f \n${String(at).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const { source, index } = await load(Buffer.from(out, 'latin1'));

    await expect(planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: 2, generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    })).rejects.toThrow(PdfAppendError);
  });
});

describe('the appended document reads back correctly', () => {
  it('has the new page, and the old ones still have their geometry', async () => {
    // The round trip is what proves the append did not break the document: the
    // reader refuses a sizeless page, so a lost /MediaBox shows up here.
    const base = baseDocument();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: nextObjectNumber(index), generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    });

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [
        { ref: plan.pagesRef, value: plan.pagesDictionary },
        ...plan.pages.map((p) => ({ ref: p.ref, value: p.dictionary })),
      ],
      trailer: index.trailer,
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const after = await load(composed);
    const pages = await resolvePages(after.source, after.index, signal);

    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.mediaBox.x1 === 612)).toBe(true);
  });
});

describe('choosing object numbers', () => {
  it('takes the next number after everything in use', async () => {
    const base = baseDocument();
    const { index } = await load(base.bytes);

    expect(nextObjectNumber(index)).toBe(5);
  });

  it('does not trust a /Size lower than what is indexed', async () => {
    // A /Size that is too low would have new objects overwrite existing ones.
    const base = baseDocument();
    const { index } = await load(base.bytes);
    const lying = { ...index, trailer: { kind: 'dict' as const, entries: new Map([['Size', 2 as PdfValue]]) } };

    expect(nextObjectNumber(lying)).toBe(5);
  });
});

describe('appending to an xref-stream source', () => {
  /**
   * A two-page document whose cross-reference section is an xref stream
   * (PDF 1.5+). This is what modern word processors and Adobe export, and the
   * format whose incremental update must use a matching xref stream so Apple
   * CoreGraphics does not blank the original pages.
   */
  const xrefStreamBase = () => minimalPdf({ pages: 2, xrefStream: true });

  it('all original pages keep their geometry after appending a certificate page', async () => {
    // This is the Apple CoreGraphics regression. When the incremental revision
    // uses a classic xref table on a stream-based source, CoreGraphics walks
    // off the chain and cannot resolve the original /Pages node, so every
    // pre-existing page renders blank. The fix is to match the source's xref
    // style, which this test exercises by reading back all pages and checking
    // their geometry is still present.
    const base = xrefStreamBase();
    const { source, index } = await load(base.bytes);

    const plan = await planAppendedPages({
      source, index, signal,
      pageRefs: [{ objectNumber: nextObjectNumber(index), generationNumber: 0 }],
      newPages: [dict({ Type: name('Page') })],
    });

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [
        { ref: plan.pagesRef, value: plan.pagesDictionary },
        ...plan.pages.map((p) => ({ ref: p.ref, value: p.dictionary })),
      ],
      trailer: index.trailer,
      xrefStyle: 'stream',
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const after = await load(composed);
    const pages = await resolvePages(after.source, after.index, signal);

    expect(pages).toHaveLength(3);
    // Every page must have a MediaBox -- a missing one is the CoreGraphics blank-page symptom.
    expect(pages.every((p) => p.mediaBox.x1 === 612)).toBe(true);
  });
});

