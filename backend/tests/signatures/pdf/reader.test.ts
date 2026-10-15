/**
 * Navigating a stored PDF through its cross-reference chain.
 *
 * The reader touches a few small windows near the end of the file rather than
 * the file, which is what keeps a 2 GB document workable on a 512 MiB instance.
 *
 * The refusals are the interesting part, because each one is a way a document
 * could steer the reader:
 *
 *   A REVISION CHAIN that loops, or is thousands long, is an unbounded walk the
 *   file controls.
 *
 *   A FREE-ENTRY tombstone means an object was deleted. Ignoring it resurrects
 *   the previous revision's version of a page that was signed.
 *
 *   A GENERATION mismatch means a reused object number. Resolving it anyway
 *   returns whatever now occupies the slot.
 *
 *   An OFFSET is a number the file chose, so it is checked against the size
 *   before it is used.
 */
import { openGcsPdfSource } from '../../../src/modules/signatures/pdf/gcsSource';
import {
  readDocumentIndex,
  readObject,
  readStartXref,
  readStreamObject,
  PdfStructureError,
} from '../../../src/modules/signatures/pdf/reader';
import type { PdfSource } from '../../../src/modules/signatures/pdf/types';

/** A source over an in-memory document, with the same bounded contract. */
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

const signal = new AbortController().signal;

/**
 * Build a one-revision document.
 *
 * Offsets are computed from the assembled text, so a case describes the shape it
 * wants rather than counting bytes.
 */
function document(objects: Array<{ n: number; g?: number; body: string }>, extraTrailer = '') {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const obj of objects) {
    offsets.set(obj.n, out.length);
    out += `${obj.n} ${obj.g ?? 0} obj\n${obj.body}\nendobj\n`;
  }
  const xrefAt = out.length;
  const max = Math.max(...objects.map((o) => o.n));
  out += 'xref\n';
  out += `0 ${max + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let n = 1; n <= max; n += 1) {
    const found = objects.find((o) => o.n === n);
    out += found
      ? `${String(offsets.get(n)).padStart(10, '0')} ${String(found.g ?? 0).padStart(5, '0')} n \n`
      : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${max + 1} ${extraTrailer} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

describe('finding the cross-reference', () => {
  it('reads startxref from the tail', async () => {
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));

    expect(await readStartXref(source, signal)).toBeGreaterThan(0);
  });

  it('refuses a file with no cross-reference pointer', async () => {
    // Searching the file for one means reading all of it, which is the cost
    // this whole design avoids.
    const source = sourceOver('%PDF-1.7\nnothing here\n');

    await expect(readStartXref(source, signal)).rejects.toThrow(/does not end with/i);
  });

  it('refuses a pointer outside the file', async () => {
    const source = sourceOver('%PDF-1.7\nstartxref\n999999\n%%EOF\n');

    await expect(readStartXref(source, signal)).rejects.toThrow(/outside the file/i);
  });
});

describe('building the index', () => {
  it('indexes the objects a document declares', async () => {
    const source = sourceOver(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Count 0 >>' },
    ]));

    const index = await readDocumentIndex(source, signal);

    expect(index.entries.get(1)?.offset).toBeGreaterThan(0);
    expect(index.entries.get(2)?.offset).toBeGreaterThan(0);
    expect(index.trailer.entries.get('Size')).toBe(3);
    expect(index.revisions).toBe(1);
  });

  it('keeps a free entry as a tombstone rather than dropping it', async () => {
    // Object 0 is always free. It has to be RECORDED, because a tombstone is
    // what hides an earlier revision's definition.
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));

    const index = await readDocumentIndex(source, signal);

    expect(index.entries.get(0)).toBeDefined();
    expect(index.entries.get(0)?.offset).toBeNull();
  });

  it('refuses a chain that points back at itself', async () => {
    // A cycle is an unbounded walk the document controls.
    const base = document([{ n: 1, body: '<< /Type /Catalog >>' }]);
    const at = /startxref\n(\d+)/.exec(base)![1];
    const looped = base.replace('/Size 2 ', `/Size 2 /Prev ${at} `);
    const source = sourceOver(looped);

    await expect(readDocumentIndex(source, signal)).rejects.toThrow(/points back at itself/i);
  });

  it('refuses a /Prev outside the file', async () => {
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }], '/Prev 999999'));

    await expect(readDocumentIndex(source, signal)).rejects.toThrow(/outside the file/i);
  });

  it('refuses a malformed table rather than rebuilding one', async () => {
    // No recovery scan: rebuilding means reading the whole file and trusting
    // bytes that already failed to parse.
    const broken = document([{ n: 1, body: '<< /Type /Catalog >>' }]).replace('xref\n', 'xrf\n');
    const source = sourceOver(broken);

    await expect(readDocumentIndex(source, signal)).rejects.toThrow(PdfStructureError);
  });
});

describe('reading an object', () => {
  it('reads the object a reference names', async () => {
    const source = sourceOver(document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages >>' },
    ]));
    const index = await readDocumentIndex(source, signal);

    const value = await readObject(source, index, { objectNumber: 2, generationNumber: 0 }, signal) as any;

    expect(value.entries.get('Type')).toEqual({ kind: 'name', value: 'Pages' });
  });

  it('refuses a generation that does not match', async () => {
    // `12 0 R` and `12 1 R` are different objects. Without this, a freed and
    // reused number resolves to whatever now sits there.
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));
    const index = await readDocumentIndex(source, signal);

    await expect(readObject(source, index, { objectNumber: 1, generationNumber: 3 }, signal))
      .rejects.toThrow(/generation/i);
  });

  it('refuses an object that a later revision deleted', async () => {
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));
    const index = await readDocumentIndex(source, signal);

    await expect(readObject(source, index, { objectNumber: 0, generationNumber: 65535 }, signal))
      .rejects.toThrow(/deleted/i);
  });

  it('refuses a reference to an object the document does not declare', async () => {
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));
    const index = await readDocumentIndex(source, signal);

    await expect(readObject(source, index, { objectNumber: 99, generationNumber: 0 }, signal))
      .rejects.toThrow(/not in this document/i);
  });

  it('refuses when the header at the offset names a different object', async () => {
    // The table said one thing and the object says another. Trusting either
    // means reading an object the reference did not ask for.
    const text = document([
      { n: 1, body: '<< /Type /Catalog >>' },
      { n: 2, body: '<< /Type /Pages >>' },
    ]);
    const index = await readDocumentIndex(sourceOver(text), signal);
    const tampered = { ...index, entries: new Map(index.entries) };
    tampered.entries.set(2, { ...tampered.entries.get(2)!, offset: tampered.entries.get(1)!.offset });

    await expect(readObject(sourceOver(text), tampered, { objectNumber: 2, generationNumber: 0 }, signal))
      .rejects.toThrow(/not at the offset/i);
  });
});

describe('the reader never reads the whole document', () => {
  it('touches only bounded windows', async () => {
    const text = document([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages >>' },
      // Filler, so the file is far larger than any window the reader takes.
      { n: 3, body: `(${'x'.repeat(256 * 1024)})` },
    ]);
    const source = sourceOver(text);
    let bytesRead = 0;
    const counting: PdfSource = {
      ...source,
      async read(start, length, s) { bytesRead += length; return source.read(start, length, s); },
    };

    const index = await readDocumentIndex(counting, signal);
    await readObject(counting, index, { objectNumber: 2, generationNumber: 0 }, signal);

    // The claim the design rests on. A reader that loaded the file would show a
    // total at or above the document size on a document this small.
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThan(source.ref.sizeBytes / 4);
  });
});

describe('stream objects', () => {
  /** A document holding one stream object with the given payload. */
  function withStream(payload: string, lengthField = String(payload.length)) {
    return document([
      { n: 1, body: '<< /Type /Catalog >>' },
      { n: 2, body: `<< /Length ${lengthField} >>\nstream\n${payload}\nendstream` },
    ]);
  }

  it('returns a stream as a RANGE, never as bytes', async () => {
    // A stream is a reference to bytes in storage. Returning a Buffer here puts
    // a 500 MB image in the process on a document that merely mentions one.
    const source = sourceOver(withStream('hello stream'));
    const index = await readDocumentIndex(source, signal);

    const { stream } = await readStreamObject(
      source, index, { objectNumber: 2, generationNumber: 0 }, signal,
    );

    expect(stream).not.toBeNull();
    expect(stream!.length).toBe('hello stream'.length);
    expect(stream!.start).toBeGreaterThan(0);
    expect((stream as any).bytes).toBeUndefined();
  });

  it('locates the payload from /Length, not by searching for endstream', async () => {
    // Stream bytes are arbitrary binary and can CONTAIN that keyword. Searching
    // for it lets the document choose where its own object ends.
    const payload = 'before endstream after';
    const source = sourceOver(withStream(payload));
    const index = await readDocumentIndex(source, signal);

    const { stream } = await readStreamObject(
      source, index, { objectNumber: 2, generationNumber: 0 }, signal,
    );

    expect(stream!.length).toBe(payload.length);
  });

  it('refuses a /Length that runs past the end of the file', async () => {
    const source = sourceOver(withStream('short', '999999'));
    const index = await readDocumentIndex(source, signal);

    await expect(readStreamObject(source, index, { objectNumber: 2, generationNumber: 0 }, signal))
      .rejects.toThrow(/past the end/i);
  });

  it('refuses a stream with no usable /Length', async () => {
    const source = sourceOver(document([
      { n: 1, body: '<< /Type /Catalog >>' },
      { n: 2, body: '<< /Filter /FlateDecode >>\nstream\nxx\nendstream' },
    ]));
    const index = await readDocumentIndex(source, signal);

    await expect(readStreamObject(source, index, { objectNumber: 2, generationNumber: 0 }, signal))
      .rejects.toThrow(/no usable \/Length/i);
  });

  it('resolves an indirect /Length', async () => {
    const source = sourceOver(document([
      { n: 1, body: '<< /Type /Catalog >>' },
      { n: 2, body: '<< /Length 3 0 R >>\nstream\nabcde\nendstream' },
      { n: 3, body: '5' },
    ]));
    const index = await readDocumentIndex(source, signal);

    const { stream } = await readStreamObject(
      source, index, { objectNumber: 2, generationNumber: 0 }, signal,
    );

    expect(stream!.length).toBe(5);
  });

  it('reads a plain object as before', async () => {
    const source = sourceOver(document([{ n: 1, body: '<< /Type /Catalog >>' }]));
    const index = await readDocumentIndex(source, signal);

    const { stream, value } = await readStreamObject(
      source, index, { objectNumber: 1, generationNumber: 0 }, signal,
    );

    expect(stream).toBeNull();
    expect((value as any).entries.get('Type')).toEqual({ kind: 'name', value: 'Catalog' });
  });
});

describe('the index budget', () => {
  /**
   * The cross-reference index is the one structure whose size follows the
   * DOCUMENT rather than the window being read, so it is the one that can still
   * put a large PDF on the heap after every other read was bounded.
   *
   * A measured `Map` entry with a small object value costs about 77 bytes, so
   * the old five million entry ceiling was around 400 MB of index inside a
   * 512 MiB container: reached, the process dies rather than refuses.
   */
  it('derives the entry ceiling from the byte budget rather than guessing one', () => {
    const { MAX_XREF_ENTRIES, MAX_XREF_BYTES } = require('../../../src/modules/signatures/pdf/reader');

    expect(MAX_XREF_ENTRIES).toBe(Math.floor(MAX_XREF_BYTES / 96));
    // A count that does not fit the container is a memory failure wearing a
    // limit's clothes.
    expect(MAX_XREF_ENTRIES * 96).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('REFUSES a document that declares more objects than the budget holds', async () => {
    // Explicitly, with a resource code. A truncated index resolves some objects
    // and reports the rest as missing, which reads as a corrupt document.
    jest.resetModules();
    process.env.PDF_MAX_XREF_BYTES = String(96 * 3);
    try {
      const reader = require('../../../src/modules/signatures/pdf/reader');
      expect(reader.MAX_XREF_ENTRIES).toBe(3);

      const source = sourceOver(document([
        { n: 1, body: '<< /Type /Catalog >>' },
        { n: 2, body: '<< /Type /Pages >>' },
        { n: 3, body: '<< /Type /Page >>' },
        { n: 4, body: '<< /Type /Page >>' },
      ]));

      await expect(reader.readDocumentIndex(source, signal))
        .rejects.toMatchObject({ code: 'PDF_RESOURCE_LIMIT' });
    } finally {
      delete process.env.PDF_MAX_XREF_BYTES;
      jest.resetModules();
    }
  });
});
