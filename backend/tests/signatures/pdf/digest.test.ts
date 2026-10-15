/**
 * Hashing a document too large to hold.
 *
 * A PDF signature covers everything except the placeholder it occupies.
 * Computing that normally means having the bytes, which for a 2 GB scan is
 * exactly what cannot happen, so the bytes are streamed through the hash in
 * windows and discarded.
 *
 * The claim worth proving is that memory tracks the WINDOW, not the document.
 * The rest is about the byte range: a digest over the wrong bytes is a signature
 * that can never verify, with nothing to say why.
 */
import crypto from 'crypto';
import {
  assertValidByteRange,
  byteRangeAround,
  digestByteRange,
  DIGEST_WINDOW_BYTES,
  PdfDigestError,
} from '../../../src/modules/signatures/pdf/digest';
import type { PdfSource } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

/** A source that records the largest single read it was asked for. */
function sourceOver(bytes: Buffer) {
  const stats = { largestRead: 0, reads: 0 };
  const source: PdfSource = {
    ref: { objectPath: 'x.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      stats.reads += 1;
      stats.largestRead = Math.max(stats.largestRead, length);
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, end) { yield new Uint8Array(bytes.subarray(start, end)); },
    async close() {},
  };
  return { source, stats };
}

describe('streaming the digest', () => {
  it('matches a hash of the same bytes computed directly', async () => {
    const bytes = Buffer.from('the quick brown fox');
    const { source } = sourceOver(bytes);

    const digest = await digestByteRange(source, [{ start: 0, length: bytes.length }], signal);

    expect(digest).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('hashes two spans as if they were adjacent', async () => {
    // Which is exactly what a signature does: everything before the placeholder
    // followed by everything after it.
    const bytes = Buffer.from('AAAAHOLEBBBB');
    const { source } = sourceOver(bytes);

    const digest = await digestByteRange(
      source, [{ start: 0, length: 4 }, { start: 8, length: 4 }], signal,
    );

    expect(digest).toBe(crypto.createHash('sha256').update(Buffer.from('AAAABBBB')).digest('hex'));
  });

  it('never reads more than one window at a time', async () => {
    // The memory claim. A source asked for the whole span at once is the
    // document in the process again.
    const bytes = Buffer.alloc(DIGEST_WINDOW_BYTES * 3, 0x41);
    const { source, stats } = sourceOver(bytes);

    await digestByteRange(source, [{ start: 0, length: bytes.length }], signal);

    expect(stats.largestRead).toBeLessThanOrEqual(DIGEST_WINDOW_BYTES);
    expect(stats.reads).toBeGreaterThan(1);
  });

  it('stops when cancelled', async () => {
    const bytes = Buffer.alloc(DIGEST_WINDOW_BYTES * 3, 0x41);
    const { source } = sourceOver(bytes);
    const controller = new AbortController();
    controller.abort();

    await expect(digestByteRange(source, [{ start: 0, length: bytes.length }], controller.signal))
      .rejects.toThrow(/cancelled/i);
  });
});

describe('validating the range', () => {
  it('refuses spans that overlap', () => {
    // Overlapping hashes some bytes twice, so the digest covers a byte sequence
    // that does not exist in the file.
    expect(() => assertValidByteRange([{ start: 0, length: 10 }, { start: 5, length: 10 }], 100))
      .toThrow(/overlap/i);
  });

  it('refuses spans that run backwards', () => {
    expect(() => assertValidByteRange([{ start: 50, length: 10 }, { start: 0, length: 10 }], 100))
      .toThrow(/out of order/i);
  });

  it('refuses a span past the end of the document', () => {
    expect(() => assertValidByteRange([{ start: 90, length: 20 }], 100)).toThrow(/past the end/i);
  });

  it('refuses an empty range', () => {
    expect(() => assertValidByteRange([], 100)).toThrow(/covers nothing/i);
  });
});

describe('building the range around a placeholder', () => {
  it('covers everything on both sides', () => {
    const spans = byteRangeAround(100, 50, 1000);

    expect(spans).toEqual([{ start: 0, length: 100 }, { start: 150, length: 850 }]);
  });

  it('omits the trailing span when the placeholder ends the file', () => {
    // A zero-length span would be refused by the validator, so it must not be
    // emitted at all.
    const spans = byteRangeAround(100, 900, 1000);

    expect(spans).toEqual([{ start: 0, length: 100 }]);
  });

  it('refuses a placeholder past the end', () => {
    expect(() => byteRangeAround(900, 200, 1000)).toThrow(/past the end/i);
  });

  it('refuses a placeholder at the very start', () => {
    // Nothing would be covered before it, and a signature that covers only what
    // follows it is not a signature over the document.
    expect(() => byteRangeAround(0, 10, 1000)).toThrow(PdfDigestError);
  });
});
