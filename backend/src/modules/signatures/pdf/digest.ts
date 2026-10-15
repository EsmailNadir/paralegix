/**
 * Hashing a document that is far too large to hold.
 *
 * A PDF signature covers a ByteRange: everything except the placeholder the
 * signature itself occupies. Computing that digest normally means having the
 * bytes, which for a 2 GB scan is exactly what cannot happen here.
 *
 * So the bytes are STREAMED through the hash in windows and discarded. Memory is
 * the window size, not the document size, and a 2 GB file costs the same as a
 * 2 MB one.
 *
 * The ByteRange is the part worth being careful about. It is two spans, before
 * and after the placeholder, and a digest that covers anything else is a
 * signature over a document nobody signed. Every span is checked against the
 * source length and against overlapping, because a malformed range that reads
 * the placeholder into the digest produces a signature that can never verify.
 */
import crypto from 'crypto';
import { AppError } from '../../../shared/errors/AppError';
import { createResumableDigest } from './resumableDigest';
import type { PdfSource } from './types';

/** Bytes pulled per iteration. Memory is this, whatever the document weighs. */
export const DIGEST_WINDOW_BYTES = Number(process.env.PDF_DIGEST_WINDOW_BYTES) || 4 * 1024 * 1024;

export class PdfDigestError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_DIGEST_ERROR');
  }
}

/** One `[start, length]` pair from a PDF ByteRange. */
export interface ByteSpan {
  start: number;
  length: number;
}

/**
 * Check the spans before any I/O.
 *
 * A range that overlaps, runs backwards, or reaches past the end is refused
 * here rather than producing a digest over the wrong bytes, which would be a
 * signature that can never verify and no way to tell why.
 */
export function assertValidByteRange(spans: ByteSpan[], sourceSize: number): void {
  if (spans.length === 0) throw new PdfDigestError('A byte range covers nothing.');

  let previousEnd = -1;
  for (const span of spans) {
    if (!Number.isSafeInteger(span.start) || span.start < 0) {
      throw new PdfDigestError(`Invalid byte range start ${span.start}.`);
    }
    if (!Number.isSafeInteger(span.length) || span.length <= 0) {
      throw new PdfDigestError(`Invalid byte range length ${span.length}.`);
    }
    if (span.start + span.length > sourceSize) {
      throw new PdfDigestError(
        `A byte range runs past the end of the document (${span.start} + ${span.length} > ${sourceSize}).`,
      );
    }
    if (span.start <= previousEnd) {
      // Overlapping or out of order. Either hashes some bytes twice, and the
      // digest then covers a byte sequence that does not exist in the file.
      throw new PdfDigestError('Byte range spans overlap or are out of order.');
    }
    previousEnd = span.start + span.length - 1;
  }
}

/**
 * SHA-256 over a set of byte spans, streamed.
 *
 * Windows are read in order and fed to the hash, then dropped. Nothing
 * accumulates, so this is the same cost on a 2 GB document as on a small one.
 */
export async function digestByteRange(
  source: PdfSource,
  spans: ByteSpan[],
  signal: AbortSignal,
): Promise<string> {
  assertValidByteRange(spans, source.ref.sizeBytes);

  const hash = crypto.createHash('sha256');
  for (const span of spans) {
    let read = 0;
    while (read < span.length) {
      if (signal.aborted) throw new PdfDigestError('That digest was cancelled.');
      const size = Math.min(DIGEST_WINDOW_BYTES, span.length - read);
      // eslint-disable-next-line no-await-in-loop -- one window at a time is the point
      const window = await source.read(span.start + read, size, signal);
      hash.update(window);
      read += size;
      // `window` goes out of scope here. Collecting the pieces to hash at the
      // end would be the whole document in memory again.
    }
  }
  return hash.digest('hex');
}

/**
 * The two spans a signature covers, from a placeholder's position.
 *
 * A PDF signature's `/Contents` is a hex string, and the digest covers
 * everything on either side of it. `placeholderStart` is the byte of the
 * opening `<`, and `placeholderLength` includes both delimiters.
 */
export function byteRangeAround(
  placeholderStart: number,
  placeholderLength: number,
  sourceSize: number,
): ByteSpan[] {
  const after = placeholderStart + placeholderLength;
  if (!Number.isSafeInteger(placeholderStart) || placeholderStart <= 0) {
    throw new PdfDigestError(`Invalid placeholder start ${placeholderStart}.`);
  }
  if (!Number.isSafeInteger(placeholderLength) || placeholderLength <= 0) {
    throw new PdfDigestError(`Invalid placeholder length ${placeholderLength}.`);
  }
  if (after > sourceSize) {
    throw new PdfDigestError('The signature placeholder runs past the end of the document.');
  }
  const spans: ByteSpan[] = [{ start: 0, length: placeholderStart }];
  // A placeholder at the very end leaves no trailing span. Emitting a
  // zero-length one would be refused by the validator above.
  if (after < sourceSize) spans.push({ start: after, length: sourceSize - after });
  return spans;
}

/**
 * The whole-file digest and the ByteRange digest from ONE read of the file.
 *
 * Verification needs both: the first proves the artifact is the one the
 * session recorded, the second is what the seal signed. They cover the same
 * bytes apart from the seal's own gap, so reading a 500 MB artifact twice for
 * them is a second full pass on a single vCPU for nothing.
 */
export async function digestWholeAndSpans(
  source: PdfSource,
  spans: ByteSpan[],
  signal: AbortSignal,
): Promise<{ wholeHex: string; spansHex: string }> {
  assertValidByteRange(spans, source.ref.sizeBytes);
  const whole = await createResumableDigest();
  const ranged = crypto.createHash('sha256');
  let offset = 0;
  for await (const chunk of source.stream(0, source.ref.sizeBytes, signal)) {
    whole.update(chunk);
    // Spans are ordered and disjoint (checked above), so feeding each chunk's
    // overlap with every span in order hashes exactly the span bytes, in order.
    for (const span of spans) {
      const from = Math.max(span.start, offset);
      const to = Math.min(span.start + span.length, offset + chunk.length);
      if (to > from) ranged.update(chunk.subarray(from - offset, to - offset));
    }
    offset += chunk.length;
  }
  if (offset !== source.ref.sizeBytes) {
    throw new PdfDigestError(`Read ${offset} bytes of a ${source.ref.sizeBytes}-byte document.`);
  }
  return { wholeHex: whole.digestHex(), spansHex: ranged.digest('hex') };
}
