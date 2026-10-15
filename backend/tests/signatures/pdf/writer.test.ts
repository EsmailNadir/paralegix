/**
 * Writing an incremental update, and reading the result back.
 *
 * This is the change that makes a large document signable: the original bytes
 * are never touched, and a suffix of new objects plus a new cross-reference is
 * appended. A suffix is kilobytes whatever the document weighs.
 *
 * The strongest case here is the round trip. A writer can produce something that
 * LOOKS right and that a forgiving viewer opens, while the offsets are wrong and
 * verification fails. So the tests below append, compose, and then read the
 * result with the real reader, which is the same thing a verifier does.
 *
 * The other rule is that the base is preserved BYTE FOR BYTE. An incremental
 * update that rewrites so much as a newline in the original invalidates any
 * signature already on it.
 */
import {
  buildIncrementalUpdate,
  serializeValue,
  withEntries,
  PdfWriteError,
} from '../../../src/modules/signatures/pdf/writer';
import { readDocumentIndex, getObject } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages } from '../../../src/modules/signatures/pdf/pages';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';
import { minimalPdf } from '../../support/minimalPdf';

const signal = new AbortController().signal;

function sourceOver(bytes: Buffer): PdfSource {
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

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number, g = 0): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: g } });

/** A minimal one-page document, plus where its cross-reference starts. */
function baseDocument() {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  const objects: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>'],
    [3, '<< /Type /Page /Parent 2 0 R >>'],
  ];
  for (const [n, body] of objects) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 4\n0000000000 65535 f \n';
  for (let n = 1; n <= 3; n += 1) out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: Buffer.from(out, 'latin1'), xrefAt };
}

const BASE_TRAILER = dict({ Size: 4, Root: ref(1) });

describe('serializing values', () => {
  it('writes each kind', () => {
    expect(serializeValue(null)).toBe('null');
    expect(serializeValue(true)).toBe('true');
    expect(serializeValue(42)).toBe('42');
    expect(serializeValue(name('Type'))).toBe('/Type');
    expect(serializeValue(ref(7, 2))).toBe('7 2 R');
    expect(serializeValue({ kind: 'array', values: [1, 2] })).toBe('[ 1 2 ]');
  });

  it('writes a real number without exponent notation', () => {
    // PDF has no exponent form. `1e-7` written raw is not a number a reader
    // accepts, and a viewer that shrugs at it is not the one verifying.
    expect(serializeValue(0.0000001)).not.toMatch(/e/i);
    expect(serializeValue(1.5)).toBe('1.5');
  });

  it('escapes what a name and a string may not carry raw', () => {
    expect(serializeValue(name('A B'))).toBe('/A#20B');
    const value = serializeValue({ kind: 'string', bytes: new Uint8Array(Buffer.from('a(b)c')) });
    expect(value).toBe('(a\\(b\\)c)');
  });

  it('refuses a number a reader cannot read', () => {
    expect(() => serializeValue(Infinity)).toThrow(PdfWriteError);
    expect(() => serializeValue(NaN)).toThrow(PdfWriteError);
  });
});

describe('appending an update', () => {
  it('leaves the base byte for byte', () => {
    // An incremental update that rewrites so much as a newline in the original
    // invalidates any signature already on it.
    const base = baseDocument();
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ Type: name('Annot') }) }],
      trailer: BASE_TRAILER,
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    expect(composed.subarray(0, base.bytes.length).equals(base.bytes)).toBe(true);
  });

  it('produces a document the real reader can walk', async () => {
    // The round trip is the strongest claim available. A writer can produce
    // something a forgiving viewer opens while the offsets are wrong, and that
    // failure looks like success until a verifier disagrees.
    const base = baseDocument();
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ Type: name('Annot'), Marker: 99 }) }],
      trailer: BASE_TRAILER,
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const source = sourceOver(composed);
    const index = await readDocumentIndex(source, signal);

    expect(index.revisions).toBe(2);
    const added = await getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal) as any;
    expect(added.entries.get('Marker')).toBe(99);
  });

  it('keeps the base objects reachable through /Prev', async () => {
    // Without the chain, the document is only what this update wrote.
    const base = baseDocument();
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ Type: name('Annot') }) }],
      trailer: BASE_TRAILER,
    });
    const source = sourceOver(Buffer.concat([base.bytes, Buffer.from(update.suffix)]));

    const pages = await resolvePages(source, await readDocumentIndex(source, signal), signal);

    expect(pages).toHaveLength(1);
    expect(pages[0].mediaBox.x1).toBe(612);
  });

  it('lets a later revision REPLACE an object', async () => {
    // The point of an incremental update: the newest definition wins, and the
    // original bytes stay where they were.
    const base = baseDocument();
    const replaced = dict({ Type: name('Page'), Parent: ref(2), Stamped: true });
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 3, generationNumber: 0 }, value: replaced }],
      trailer: BASE_TRAILER,
    });
    const source = sourceOver(Buffer.concat([base.bytes, Buffer.from(update.suffix)]));
    const index = await readDocumentIndex(source, signal);

    const page = await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal) as any;

    expect(page.entries.get('Stamped')).toBe(true);
  });

  it('survives two updates stacked on each other', async () => {
    const base = baseDocument();
    const first = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ Step: 1 }) }],
      trailer: BASE_TRAILER,
    });
    const afterFirst = Buffer.concat([base.bytes, Buffer.from(first.suffix)]);

    const second = buildIncrementalUpdate({
      baseSize: afterFirst.length,
      previousXrefOffset: first.xrefOffset,
      objects: [{ ref: { objectNumber: 5, generationNumber: 0 }, value: dict({ Step: 2 }) }],
      trailer: BASE_TRAILER,
    });
    const source = sourceOver(Buffer.concat([afterFirst, Buffer.from(second.suffix)]));
    const index = await readDocumentIndex(source, signal);

    expect(index.revisions).toBe(3);
    expect(((await getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal)) as any)
      .entries.get('Step')).toBe(1);
    expect(((await getObject(source, index, { objectNumber: 5, generationNumber: 0 }, signal)) as any)
      .entries.get('Step')).toBe(2);
  });

  it('writes a stream object whose payload survives the round trip', async () => {
    const base = baseDocument();
    const payload = Buffer.from('signature appearance');
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{
        ref: { objectNumber: 4, generationNumber: 0 },
        value: dict({ Length: payload.length }),
        streamBytes: new Uint8Array(payload),
      }],
      trailer: BASE_TRAILER,
    });
    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const source = sourceOver(composed);
    const index = await readDocumentIndex(source, signal);

    const { readStreamObject } = await import('../../../src/modules/signatures/pdf/reader');
    const { stream } = await readStreamObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal);

    expect(stream!.length).toBe(payload.length);
    const bytes = await source.read(stream!.start, stream!.length, signal);
    expect(Buffer.from(bytes).toString()).toBe('signature appearance');
  });

  it('reports the composed size and the absolute xref offset', () => {
    const base = baseDocument();
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({}) }],
      trailer: BASE_TRAILER,
    });

    // Absolute, from the start of the COMPOSED file. Relative offsets open in a
    // forgiving viewer and fail verification.
    expect(update.xrefOffset).toBeGreaterThan(base.bytes.length);
    expect(update.totalSize).toBe(base.bytes.length + update.suffix.length);
  });
});

describe('what it refuses to write', () => {
  const base = baseDocument();
  const build = (over: Partial<Parameters<typeof buildIncrementalUpdate>[0]>) =>
    buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 4, generationNumber: 0 }, value: dict({}) }],
      trailer: BASE_TRAILER,
      ...over,
    });

  it('refuses an encrypted document', () => {
    // Its strings and streams are encrypted with a key this writer does not
    // have, so anything appended is unreadable to a viewer that decrypts the rest.
    expect(() => build({ trailer: withEntries(BASE_TRAILER, { Encrypt: ref(9) }) }))
      .toThrow(/encrypted/i);
  });

  it('refuses a trailer with no /Root', () => {
    expect(() => build({ trailer: dict({ Size: 4 }) })).toThrow(/no \/Root/i);
  });

  it('refuses an update that changes nothing', () => {
    expect(() => build({ objects: [] })).toThrow(/changes nothing/i);
  });

  it('refuses two definitions of one object in a single update', () => {
    // The table can only point at one, so the other is silently lost.
    expect(() => build({
      objects: [
        { ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ A: 1 }) },
        { ref: { objectNumber: 4, generationNumber: 0 }, value: dict({ A: 2 }) },
      ],
    })).toThrow(/written twice/i);
  });

  it('refuses a /Prev that is not inside the base', () => {
    expect(() => build({ previousXrefOffset: base.bytes.length + 10 })).toThrow(/not inside the base/i);
  });
});

/**
 * A one-page document whose sole cross-reference section is an xref stream
 * (PDF 1.5+). This is the format modern Word and Adobe exports produce, and the
 * one Apple CoreGraphics fails on when an incremental update appends a classic
 * xref table instead of a matching stream.
 */
const xrefStreamDocument = () => minimalPdf({ pages: 1, xrefStream: true });

describe('xref-stream incremental updates', () => {
  it('reads back correctly after a stream-style update on an xref-stream source', async () => {
    // The key regression: Apple CoreGraphics blanks the original pages when a
    // classic xref table is appended to a stream-based source. This round-trip
    // verifies that xrefStyle "stream" produces a document the reader can fully
    // index, and that the original page tree remains reachable.
    const base = xrefStreamDocument();
    // The fixture really is stream-only: no classic table for a reader to fall
    // back on, so reading it at all goes through the stream.
    expect(base.bytes.toString('latin1')).toContain('/Type /XRef');
    expect(base.bytes.toString('latin1')).not.toMatch(/^xref$/m);
    const baseSrc = sourceOver(base.bytes);
    const baseIndex = await readDocumentIndex(baseSrc, signal);

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 5, generationNumber: 0 }, value: dict({ Marker: 77 }) }],
      trailer: baseIndex.trailer,
      xrefStyle: 'stream',
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const src = sourceOver(composed);
    const index = await readDocumentIndex(src, signal);

    // Two revisions: the base xref stream and the appended stream.
    expect(index.revisions).toBe(2);
    // The appended object is readable.
    const added = await getObject(src, index, { objectNumber: 5, generationNumber: 0 }, signal) as any;
    expect(added.entries.get('Marker')).toBe(77);
    // Crucially, the original page tree is still intact.
    const pages = await resolvePages(src, index, signal);
    expect(pages).toHaveLength(1);
    expect(pages[0].mediaBox.x1).toBe(612);
  });

  it('keeps the base bytes untouched when xrefStyle is stream', () => {
    const base = xrefStreamDocument();
    const baseSrc = { ref: { objectPath: 'test.pdf', generation: '1', sizeBytes: base.bytes.length } } as any;
    const trailer: PdfDict = dict({ Root: ref(1), Size: 5 });

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [{ ref: { objectNumber: 5, generationNumber: 0 }, value: dict({ X: 1 }) }],
      trailer,
      xrefStyle: 'stream',
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    expect(composed.subarray(0, base.bytes.length).equals(base.bytes)).toBe(true);
  });
});
