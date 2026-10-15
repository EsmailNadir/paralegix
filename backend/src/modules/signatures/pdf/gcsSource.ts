/**
 * Bounded read access to a PDF that lives in storage.
 *
 * This is the floor the incremental design stands on. Everything above it reads
 * WINDOWS, so the cost of working with a document stays independent of its size:
 * a 2 GB file is not a Buffer on a 512 MiB instance, it is a sequence of small
 * reads against an object that stays where it is.
 *
 * There is deliberately no whole-file read. A `download()` here would be an
 * invitation that some caller above eventually accepts, and the first one to do
 * it puts the container back where it started.
 *
 * Two refusals are worth stating up front, because both are silent failures
 * otherwise:
 *
 * A read is pinned to one GCS GENERATION. A document replaced while it is being
 * signed would otherwise be read half from one version and half from the next,
 * and the signature would cover a file that never existed.
 *
 * A SHORT read is an error rather than a shorter answer. The reader above builds
 * offsets from what it was told it got, so a truncated fetch that returns
 * quietly becomes a misparse somewhere else entirely, with nothing pointing back
 * to the read.
 */
import { Readable } from 'stream';
import { AppError } from '../../../shared/errors/AppError';
import { isSafeOffset, type PdfSource, type StoredPdf } from './types';

/**
 * The most one `read` may ask for.
 *
 * The cap has to live here rather than with the caller: an uncapped `length` is
 * a whole-file read spelled differently, and the caller choosing it is exactly
 * the caller that cannot be trusted with it. 8 MiB is far above any structure
 * the reader fetches in one go (a tail window, an xref section, one object
 * stream) and far below what threatens the container.
 */
export const MAX_READ_BYTES = Number(process.env.PDF_MAX_READ_BYTES) || 8 * 1024 * 1024;

/** A read could not be served. Not a fault: the document or the request is wrong. */
export class PdfSourceError extends AppError {
  constructor(message: string, statusCode = 400, code = 'PDF_SOURCE_ERROR') {
    super(message, statusCode, code);
  }
}

function bucket() {
  const { admin } = require('../../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

/** Turn a storage failure into something that names what went wrong. */
function asSourceError(err: any): PdfSourceError {
  if (err?.code === 404) {
    return new PdfSourceError('That document was not found.', 404, 'PDF_NOT_FOUND');
  }
  if (err?.code === 412) {
    return new PdfSourceError(
      'That document changed while it was being read. Start again.',
      409,
      'PDF_GENERATION_CHANGED',
    );
  }
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return new PdfSourceError('That read was cancelled.', 499, 'PDF_READ_CANCELLED');
  }
  return new PdfSourceError(err?.message || 'That document could not be read.', 502, 'PDF_READ_FAILED');
}

/**
 * Check a window against the document BEFORE any I/O.
 *
 * A `/Length` that runs past the end of the file is how a malformed document
 * turns into an unbounded read, and the check costs nothing here.
 */
function assertWindow(ref: StoredPdf, start: number, length: number) {
  if (!isSafeOffset(start)) {
    throw new PdfSourceError(`Invalid read offset: ${start}.`);
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new PdfSourceError(`Invalid read length: ${length}.`);
  }
  if (length > MAX_READ_BYTES) {
    throw new PdfSourceError(
      `That read is too large: ${length} bytes, and the limit is ${MAX_READ_BYTES}.`,
      400,
      'PDF_READ_TOO_LARGE',
    );
  }
  if (start + length > ref.sizeBytes) {
    throw new PdfSourceError(
      `That read runs past the end of the document (${start} + ${length} > ${ref.sizeBytes}).`,
    );
  }
}

/** A ranged read stream, pinned to the generation this source was opened at. */
function openRange(ref: StoredPdf, start: number, endInclusive: number): Readable {
  return bucket().file(ref.objectPath).createReadStream({
    start,
    end: endInclusive,
    // Pinned so a replaced object fails loudly rather than being read across
    // two versions. The SDK spells this both ways depending on the call.
    generation: ref.generation,
    preconditionOpts: { ifGenerationMatch: ref.generation },
  });
}

/** Abort a stream and let its close handlers run. */
function destroy(stream: Readable) {
  if (!stream.destroyed) stream.destroy();
}

/**
 * Open bounded access to one stored PDF.
 *
 * Nothing is fetched here: the source is a handle, and every read states its own
 * window.
 */
export function openGcsPdfSource(ref: StoredPdf): PdfSource {
  if (!ref?.objectPath) throw new PdfSourceError('A PDF source needs an object path.');
  if (!ref.generation) throw new PdfSourceError('A PDF source needs a pinned generation.');
  if (!isSafeOffset(ref.sizeBytes) || ref.sizeBytes === 0) {
    throw new PdfSourceError(`Invalid document size: ${ref.sizeBytes}.`);
  }

  const pinned: StoredPdf = {
    objectPath: ref.objectPath,
    // Kept as a STRING. A GCS generation is 64-bit, and coerced to a JS number
    // it rounds past 2^53, so two different versions compare equal.
    generation: String(ref.generation),
    sizeBytes: ref.sizeBytes,
  };

  return {
    ref: pinned,

    async read(start, length, signal) {
      if (signal.aborted) throw asSourceError({ name: 'AbortError' });
      assertWindow(pinned, start, length);

      const stream = openRange(pinned, start, start + length - 1);
      const onAbort = () => destroy(stream);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of stream) {
          chunks.push(chunk as Buffer);
          received += (chunk as Buffer).length;
          // Storage answering with more than the range asked for would let a
          // caller's window cap be exceeded by the thing it is capping.
          if (received > length) {
            throw new PdfSourceError('That read returned more bytes than were asked for.');
          }
        }
        if (signal.aborted) throw asSourceError({ name: 'AbortError' });
        if (received !== length) {
          throw new PdfSourceError(
            `Short read: asked for ${length} bytes at ${start} and got ${received}.`,
            502,
            'PDF_SHORT_READ',
          );
        }
        return new Uint8Array(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, received));
      } catch (err: any) {
        // Destroying a stream mid-iteration surfaces as ERR_STREAM_PREMATURE_CLOSE,
        // not as an abort error, so the signal is what says whether this was a
        // cancellation or a real failure. Reported the other way round, every
        // cancelled signing request looks like a storage fault.
        if (signal.aborted) throw asSourceError({ name: 'AbortError' });
        if (err instanceof PdfSourceError) throw err;
        throw asSourceError(err);
      } finally {
        signal.removeEventListener('abort', onAbort);
        destroy(stream);
      }
    },

    async *stream(start, endExclusive, signal) {
      const length = endExclusive - start;
      if (signal.aborted) throw asSourceError({ name: 'AbortError' });
      if (!isSafeOffset(start)) throw new PdfSourceError(`Invalid read offset: ${start}.`);
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new PdfSourceError(`Invalid read length: ${length}.`);
      }
      if (endExclusive > pinned.sizeBytes) {
        throw new PdfSourceError(
          `That read runs past the end of the document (${endExclusive} > ${pinned.sizeBytes}).`,
        );
      }

      const stream = openRange(pinned, start, endExclusive - 1);
      const onAbort = () => destroy(stream);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const chunk of stream) {
          if (signal.aborted) throw asSourceError({ name: 'AbortError' });
          yield new Uint8Array(chunk as Buffer);
        }
      } catch (err: any) {
        if (signal.aborted) throw asSourceError({ name: 'AbortError' });
        if (err instanceof PdfSourceError) throw err;
        throw asSourceError(err);
      } finally {
        // Runs on a `break` too, which is what stops a caller that has seen
        // enough from leaving the rest of a gigabyte in flight.
        signal.removeEventListener('abort', onAbort);
        destroy(stream);
      }
    },

    async close() {
      // Nothing is held open between reads: each one owns its stream and closes
      // it in a finally. Present so a caller can be written the same way
      // whatever a future source does.
    },
  };
}
