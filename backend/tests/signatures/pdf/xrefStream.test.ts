/**
 * Cross-reference STREAMS, which is how PDF 1.5 and later store the table.
 *
 * A reader that handles only the classic `xref` keyword refuses most modern
 * documents, so this is not an optional extra.
 *
 * The table is now a compressed object, which means the file gets to choose how
 * much memory decoding it uses. That is the sharpest edge here: a few kilobytes
 * of zlib can inflate to gigabytes, so the ceiling has to apply DURING
 * decompression. Checking the length afterwards means the allocation it was
 * meant to prevent has already happened.
 */
import zlib from 'zlib';
import {
  readDocumentIndex,
  readObject,
  PdfStructureError,
} from '../../../src/modules/signatures/pdf/reader';
import { decodeStream, MAX_DECODED_BYTES, PdfFilterError } from '../../../src/modules/signatures/pdf/filters';
import type { PdfDict, PdfSource } from '../../../src/modules/signatures/pdf/types';

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

const dict = (entries: Record<string, any>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });

/** Three-byte-wide entries: type, offset, generation. */
function xrefEntries(rows: Array<[number, number, number]>): Buffer {
  const out = Buffer.alloc(rows.length * 5);
  rows.forEach(([type, second, third], i) => {
    out.writeUInt8(type, i * 5);
    out.writeUInt16BE(second, i * 5 + 1);
    out.writeUInt16BE(third, i * 5 + 3);
  });
  return out;
}

/** A document whose cross-reference is a stream object. */
function documentWithXrefStream(rows: Array<[number, number, number]>, overrides: Record<string, string> = {}) {
  let out = '%PDF-1.7\n';
  const catalogAt = out.length;
  out += '1 0 obj\n<< /Type /Catalog >>\nendobj\n';

  const payload = zlib.deflateSync(xrefEntries(rows));
  const xrefAt = out.length;
  const fields = {
    '/Type': '/XRef',
    '/W': '[1 2 2]',
    '/Size': String(rows.length),
    '/Length': String(payload.length),
    '/Filter': '/FlateDecode',
    ...overrides,
  };
  const dictText = Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(' ');
  out += `2 0 obj\n<< ${dictText} >>\nstream\n`;
  const head = Buffer.from(out, 'latin1');
  const tail = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1');
  return { bytes: Buffer.concat([head, payload, tail]), catalogAt, xrefAt };
}

describe('reading a cross-reference stream', () => {
  it('indexes the objects it declares', async () => {
    const { bytes, catalogAt, xrefAt } = documentWithXrefStream([
      [0, 0, 65535],      // object 0, free
      [1, 0, 0],          // object 1, offset patched below
      [1, 0, 0],          // object 2, the xref stream itself
    ]);
    // The offsets have to be the real ones, so rebuild with them known.
    const built = documentWithXrefStream([
      [0, 0, 65535],
      [1, catalogAt, 0],
      [1, xrefAt, 0],
    ]);
    const source = sourceOver(built.bytes);

    const index = await readDocumentIndex(source, signal);

    expect(index.entries.get(1)?.offset).toBe(catalogAt);
    expect(index.trailer.entries.get('Type')).toEqual({ kind: 'name', value: 'XRef' });
    void bytes;
  });

  it('keeps a free entry as a tombstone', async () => {
    const { catalogAt, xrefAt } = documentWithXrefStream([[0, 0, 0], [1, 0, 0], [1, 0, 0]]);
    const built = documentWithXrefStream([[0, 0, 65535], [1, catalogAt, 0], [1, xrefAt, 0]]);

    const index = await readDocumentIndex(sourceOver(built.bytes), signal);

    expect(index.entries.get(0)?.offset).toBeNull();
  });

  it('resolves an object the stream located', async () => {
    const { catalogAt, xrefAt } = documentWithXrefStream([[0, 0, 0], [1, 0, 0], [1, 0, 0]]);
    const built = documentWithXrefStream([[0, 0, 65535], [1, catalogAt, 0], [1, xrefAt, 0]]);
    const source = sourceOver(built.bytes);
    const index = await readDocumentIndex(source, signal);

    const value = await readObject(source, index, { objectNumber: 1, generationNumber: 0 }, signal) as any;

    expect(value.entries.get('Type')).toEqual({ kind: 'name', value: 'Catalog' });
  });

  it('refuses widths that do not describe three fields', async () => {
    const { catalogAt, xrefAt } = documentWithXrefStream([[0, 0, 0], [1, 0, 0], [1, 0, 0]]);
    const built = documentWithXrefStream(
      [[0, 0, 65535], [1, catalogAt, 0], [1, xrefAt, 0]], { '/W': '[1 2]' },
    );

    await expect(readDocumentIndex(sourceOver(built.bytes), signal))
      .rejects.toThrow(/three fields/i);
  });

  it('refuses a declared count that does not match the data', async () => {
    const { catalogAt, xrefAt } = documentWithXrefStream([[0, 0, 0], [1, 0, 0], [1, 0, 0]]);
    const built = documentWithXrefStream(
      [[0, 0, 65535], [1, catalogAt, 0], [1, xrefAt, 0]], { '/Size': '99' },
    );

    await expect(readDocumentIndex(sourceOver(built.bytes), signal))
      .rejects.toThrow(/declares more entries/i);
  });

  it('refuses an indirect /Length, which cannot be resolved yet', async () => {
    // Resolving it would need the index this section is building. The spec
    // requires a direct length here for exactly that reason.
    const { catalogAt, xrefAt } = documentWithXrefStream([[0, 0, 0], [1, 0, 0], [1, 0, 0]]);
    const built = documentWithXrefStream(
      [[0, 0, 65535], [1, catalogAt, 0], [1, xrefAt, 0]], { '/Length': '5 0 R' },
    );

    await expect(readDocumentIndex(sourceOver(built.bytes), signal))
      .rejects.toThrow(/direct \/Length/i);
  });
});

describe('decoding is bounded', () => {
  it('refuses a decompression bomb DURING inflation', async () => {
    // A few kilobytes that inflate to far more than the ceiling. The point is
    // that this refuses without ever allocating the output: a length check on
    // the result happens after the damage.
    const bomb = zlib.deflateSync(Buffer.alloc(MAX_DECODED_BYTES + 1024, 0));

    await expect(decodeStream(dict({ Filter: { kind: 'name', value: 'FlateDecode' } }), new Uint8Array(bomb)))
      .rejects.toThrow();
  });

  it('refuses an unsupported filter rather than passing bytes through', async () => {
    // A stream that cannot be decoded has unknown contents, and treating
    // unknown bytes as an xref table lets the document choose what is believed.
    await expect(decodeStream(dict({ Filter: { kind: 'name', value: 'JPXDecode' } }), new Uint8Array([1, 2])))
      .rejects.toThrow(PdfFilterError);
  });

  it('decodes flate', async () => {
    const payload = Buffer.from('hello');
    const out = await decodeStream(
      dict({ Filter: { kind: 'name', value: 'FlateDecode' } }),
      new Uint8Array(zlib.deflateSync(payload)),
    );

    expect(Buffer.from(out).toString()).toBe('hello');
  });

  it('undoes a PNG predictor', async () => {
    // Xref streams almost always use one, because their columns are highly
    // repetitive. Skipping it yields plausible-looking nonsense rather than an
    // error, which is why it is not optional.
    const columns = 4;
    const rows = [[1, 2, 3, 4], [1, 2, 3, 4]];
    const raw: number[] = [];
    let prior = [0, 0, 0, 0];
    for (const row of rows) {
      raw.push(2); // Up
      for (let i = 0; i < columns; i += 1) raw.push((row[i] - prior[i]) & 0xff);
      prior = row;
    }

    const out = await decodeStream(
      dict({
        Filter: { kind: 'name', value: 'FlateDecode' },
        DecodeParms: dict({ Predictor: 12, Columns: columns, Colors: 1, BitsPerComponent: 8 }),
      }),
      new Uint8Array(zlib.deflateSync(Buffer.from(raw))),
    );

    expect(Array.from(out)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('refuses predicted data that is not a whole number of rows', async () => {
    await expect(decodeStream(
      dict({
        Filter: { kind: 'name', value: 'FlateDecode' },
        DecodeParms: dict({ Predictor: 12, Columns: 4, Colors: 1, BitsPerComponent: 8 }),
      }),
      new Uint8Array(zlib.deflateSync(Buffer.from([2, 1, 2]))),
    )).rejects.toThrow(/whole number of rows/i);
  });
});

describe('an unreadable section is refused, not guessed at', () => {
  it('refuses an offset that is neither a table nor a stream', async () => {
    const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nendobj\nstartxref\n9\n%%EOF\n', 'latin1');

    await expect(readDocumentIndex(sourceOver(bytes), signal)).rejects.toThrow(PdfStructureError);
  });
});
