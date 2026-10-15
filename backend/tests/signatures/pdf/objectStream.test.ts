/**
 * Objects packed inside an object stream.
 *
 * PDF 1.5 puts many small objects into one compressed stream to save space, so
 * on a modern document MOST objects are reached this way rather than by a file
 * offset. A reader that only follows offsets sees an almost empty document.
 *
 * Every number involved comes from the file: which stream holds the object,
 * where in the stream it sits, how many the stream holds, and where the data
 * begins. Each is checked before it is used as an index, because an unchecked
 * one reads from an arbitrary place in the decoded buffer.
 */
import zlib from 'zlib';
import {
  getObject,
  readDocumentIndex,
  PdfStructureError,
} from '../../../src/modules/signatures/pdf/reader';
import type { PdfSource } from '../../../src/modules/signatures/pdf/types';

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

function xrefEntries(rows: Array<[number, number, number]>): Buffer {
  const out = Buffer.alloc(rows.length * 5);
  rows.forEach(([type, second, third], i) => {
    out.writeUInt8(type, i * 5);
    out.writeUInt16BE(second, i * 5 + 1);
    out.writeUInt16BE(third, i * 5 + 3);
  });
  return out;
}

/**
 * A document whose objects 3 and 4 live inside object stream 2.
 *
 * `overrides` lets a case corrupt one field to show what the check catches.
 */
function documentWithObjectStream(overrides: {
  headerNumbers?: [number, number];
  n?: number;
  first?: number;
} = {}) {
  const bodies = ['<< /Type /Page /Order 1 >>', '<< /Type /Page /Order 2 >>'];
  const numbers = overrides.headerNumbers ?? [3, 4];

  // Header is `N` pairs of (object number, relative offset), then the objects.
  let payload = '';
  const offsets: number[] = [];
  for (const body of bodies) { offsets.push(payload.length); payload += `${body} `; }
  const header = `${numbers[0]} ${offsets[0]} ${numbers[1]} ${offsets[1]} `;
  const decoded = Buffer.from(header + payload, 'latin1');
  const compressed = zlib.deflateSync(decoded);

  let out = '%PDF-1.7\n';
  const catalogAt = out.length;
  out += '1 0 obj\n<< /Type /Catalog >>\nendobj\n';

  const objStmAt = out.length;
  const objStmDict = `<< /Type /ObjStm /N ${overrides.n ?? 2} /First ${overrides.first ?? header.length} `
    + `/Length ${compressed.length} /Filter /FlateDecode >>`;
  out += `2 0 obj\n${objStmDict}\nstream\n`;
  const head = Buffer.from(out, 'latin1');

  const afterStream = Buffer.from('\nendstream\nendobj\n', 'latin1');
  const xrefAt = head.length + compressed.length + afterStream.length;

  const table = zlib.deflateSync(xrefEntries([
    [0, 0, 65535],
    [1, catalogAt, 0],
    [1, objStmAt, 0],
    [2, 2, 0],   // object 3: in stream 2, position 0
    [2, 2, 1],   // object 4: in stream 2, position 1
    [1, xrefAt, 0],
  ]));
  const xref = Buffer.from(
    `5 0 obj\n<< /Type /XRef /W [1 2 2] /Size 6 /Length ${table.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1');

  return Buffer.concat([head, compressed, afterStream, xref, table, tail]);
}

describe('decoding each object stream once per index', () => {
  /** The same document, with every read of the container's payload counted. */
  function counted(bytes: Buffer) {
    const base = sourceOver(bytes);
    const payloadAt = bytes.indexOf(Buffer.from('/Type /ObjStm')) >= 0
      ? bytes.indexOf(Buffer.from('stream\n'), bytes.indexOf(Buffer.from('/Type /ObjStm'))) + 'stream\n'.length
      : -1;
    let payloadReads = 0;
    const source: PdfSource = {
      ...base,
      async read(start, length, s) {
        if (start === payloadAt) payloadReads += 1;
        return base.read(start, length, s);
      },
    };
    return { source, reads: () => payloadReads, payloadAt };
  }

  it('reads and inflates a container once for every object it holds', async () => {
    const { source, reads, payloadAt } = counted(documentWithObjectStream());
    expect(payloadAt).toBeGreaterThan(0);
    const index = await readDocumentIndex(source, signal);

    const first = await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal);
    const second = await getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal);

    // Proved first: both objects come back, and they are different objects.
    expect((first as any).entries.get('Order')).toBe(1);
    expect((second as any).entries.get('Order')).toBe(2);
    expect(reads()).toBe(1);
  });

  it('keeps nothing once a container is over the cache budget', async () => {
    const { source, reads } = counted(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);
    index.objectStreams!.budgetBytes = 1;

    await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal);
    await getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal);

    expect(index.objectStreams!.entries.size).toBe(0);
    expect(index.objectStreams!.bytes).toBe(0);
    // Uncached, so each object pays its own read, which is the old behaviour.
    expect(reads()).toBe(2);
  });
});

describe('reading a compressed object', () => {
  it('reads an object out of the stream that holds it', async () => {
    const source = sourceOver(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);

    const value = await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal) as any;

    expect(value.entries.get('Order')).toBe(1);
  });

  it('reads the SECOND object, not just the first', async () => {
    // Position within the stream has to be honoured. Always returning the first
    // object is a bug that a single-object fixture cannot see.
    const source = sourceOver(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);

    const value = await getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal) as any;

    expect(value.entries.get('Order')).toBe(2);
  });

  it('still reads an ordinary object by offset', async () => {
    // `getObject` is the one entry point, and which storage form was used is
    // not something a caller should have to know.
    const source = sourceOver(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);

    const value = await getObject(source, index, { objectNumber: 1, generationNumber: 0 }, signal) as any;

    expect(value.entries.get('Type')).toEqual({ kind: 'name', value: 'Catalog' });
  });

  it('records the containing stream separately from a file offset', async () => {
    // Conflating the two sends a read to an arbitrary place in the document.
    const index = await readDocumentIndex(sourceOver(documentWithObjectStream()), signal);

    const entry = index.entries.get(3)!;
    expect(entry.offset).toBeNull();
    expect(entry.inObjectStream).toEqual({ streamObjectNumber: 2, indexInStream: 0 });
  });
});

describe('what it refuses', () => {
  it('refuses when the stream holds a different object at that position', async () => {
    // The table said this position holds one object and the stream says
    // another. Trusting either reads an object the reference did not ask for.
    const source = sourceOver(documentWithObjectStream({ headerNumbers: [99, 4] }));
    const index = await readDocumentIndex(source, signal);

    await expect(getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal))
      .rejects.toThrow(/holds object 99/i);
  });

  it('refuses a position past the number the stream declares', async () => {
    const source = sourceOver(documentWithObjectStream({ n: 1 }));
    const index = await readDocumentIndex(source, signal);

    await expect(getObject(source, index, { objectNumber: 4, generationNumber: 0 }, signal))
      .rejects.toThrow(/position 1 in a stream holding 1/i);
  });

  it('refuses a /First past the end of the decoded data', async () => {
    const source = sourceOver(documentWithObjectStream({ first: 99999 }));
    const index = await readDocumentIndex(source, signal);

    await expect(getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal))
      .rejects.toThrow(/past the end/i);
  });

  it('refuses a non-zero generation for a compressed object', async () => {
    // An object inside a stream is generation 0 by definition, so a reference
    // asking for another generation is asking for a different object.
    const source = sourceOver(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);

    await expect(getObject(source, index, { objectNumber: 3, generationNumber: 2 }, signal))
      .rejects.toThrow(/generation 0/i);
  });

  it('refuses an object the document does not declare at all', async () => {
    const source = sourceOver(documentWithObjectStream());
    const index = await readDocumentIndex(source, signal);

    await expect(getObject(source, index, { objectNumber: 404, generationNumber: 0 }, signal))
      .rejects.toThrow(PdfStructureError);
  });
});
