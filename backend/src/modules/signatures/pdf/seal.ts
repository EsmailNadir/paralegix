/**
 * Sealing: turning a prepared suffix into a signed revision.
 *
 * Every other file here does one part. This is the order they have to happen
 * in, and the order is the whole difficulty. Get it wrong and the result is not
 * an error, it is a document that opens in a viewer, shows a signature, and
 * fails verification everywhere. That is worse than a failure, because nobody
 * finds out until the document matters.
 *
 * The order:
 *
 * 1. The suffix is laid out with the two fields that cannot move, `/ByteRange`
 *    and `/Contents`, reserved at a fixed width. Sizes are final from here on.
 * 2. `/ByteRange` is written. It states which bytes the signature covers, so it
 *    has to be in the file BEFORE the file is hashed. Hashing first and patching
 *    afterwards signs a file that never existed.
 * 3. The covered bytes are hashed: everything except the `/Contents` token. The
 *    base contributes through a saved hash state, so it is never read again.
 * 4. That digest is signed, and the seal goes into the reserved hole. The hole
 *    is excluded from the hash, which is why writing into it now is legal.
 * 5. The whole artifact is hashed separately, hole included, as its identity.
 *
 * The base is never in memory at any step. Steps 3 and 5 both start from the
 * same saved state, so the cost of signing a 2 GB document is the cost of
 * hashing its suffix twice, and a suffix is kilobytes.
 */
import { AppError } from '../../../shared/errors/AppError';
import { signDigest, fitSignature, verifyDetachedSignature } from './cms';
import type { SigningIdentity, VerificationResult } from './cms';
import {
  assertDigestParity,
  createResumableDigest,
  resumeDigest,
  SourceChangedError,
} from './resumableDigest';
import type { SavedDigestState } from './resumableDigest';
import type { PdfSource } from './types';
import { patchByteRange, patchSignature } from './writer';
import type { IncrementalUpdate, SignatureArea } from './writer';

export class PdfSealError extends AppError {
  constructor(message: string) {
    super(message, 500, 'PDF_SEAL_FAILED');
  }
}

export interface SealedSuffix {
  /** The suffix, with both fields written. The base is untouched. */
  suffix: Uint8Array;
  /** Where the two fields ended up, for a caller that verifies afterwards. */
  area: SignatureArea;
  /** The four values written into `/ByteRange`. */
  byteRange: [number, number, number, number];
  /** SHA-256 of the covered bytes. This is what the seal signs. */
  signedDigestHex: string;
  /** SHA-256 of the whole composed artifact, including the seal. */
  artifactDigestHex: string;
  totalSize: number;
  /** False when the base had to be read again because no state was usable. */
  resumed: boolean;
}

/**
 * Sign a prepared incremental update.
 *
 * `savedDigest` is the state preparation left behind, covering exactly the base
 * object. When it is absent or unusable the base is streamed once instead. That
 * fallback is not a degraded mode to be tolerated: it is the path a first
 * signature takes, and it produces the same bytes, so it is tested the same way.
 * What it is not allowed to do is run after a SOURCE_CHANGED, because a state
 * that names different bytes means preparation measured a different document.
 */
export async function sealSuffix(options: {
  source: PdfSource;
  update: IncrementalUpdate;
  identity: SigningIdentity;
  signingTime?: Date;
  savedDigest?: SavedDigestState | null;
  signal: AbortSignal;
}): Promise<SealedSuffix> {
  const { source, update, identity, signingTime, savedDigest = null, signal } = options;

  // Independent verification with OpenSSL rests on this process's two SHA-256
  // implementations agreeing. Proven once, then free.
  await assertDigestParity();

  const area = update.signature;
  if (!area) throw new PdfSealError('This update reserved no signature area, so there is nothing to seal.');

  const baseSize = source.ref.sizeBytes;
  if (update.totalSize - update.suffix.length !== baseSize) {
    // The update was built against a different base length, so every absolute
    // offset in it is wrong by the difference.
    throw new PdfSealError(
      `The update was built for a base of ${update.totalSize - update.suffix.length} bytes, but the source is ${baseSize}.`,
    );
  }

  const holeStart = area.contentsStart;
  const holeEnd = area.contentsStart + area.contentsLength;
  if (holeStart < baseSize || holeEnd > update.totalSize) {
    throw new PdfSealError('The reserved signature area is not inside the appended suffix.');
  }

  // Two spans, on either side of the hole. The first always covers the entire
  // base plus the head of the suffix, because every appended object lands after
  // the original, so the hole cannot be anywhere but the suffix.
  const byteRange: [number, number, number, number] = [
    0,
    holeStart,
    holeEnd,
    update.totalSize - holeEnd,
  ];

  const suffix = Uint8Array.from(update.suffix);
  patchByteRange(suffix, area, baseSize, byteRange);

  const { state, resumed } = await baseDigestState(source, savedDigest, signal);

  const covered = await resumeDigest(state, source.ref);
  covered.update(suffix.subarray(0, holeStart - baseSize));
  covered.update(suffix.subarray(holeEnd - baseSize));
  if (covered.absorbed() !== byteRange[1] + byteRange[3]) {
    // The digest absorbed a different number of bytes than /ByteRange claims,
    // which means the two describe different files.
    throw new PdfSealError(
      `The digest covered ${covered.absorbed()} bytes but /ByteRange claims ${byteRange[1] + byteRange[3]}.`,
    );
  }
  const signedDigestHex = covered.digestHex();

  const cms = signDigest({ digestHex: signedDigestHex, identity, signingTime });
  patchSignature(suffix, area, baseSize, fitSignature(cms, (area.contentsLength - 2) / 2));

  const whole = await resumeDigest(state, source.ref);
  whole.update(suffix);
  if (whole.absorbed() !== update.totalSize) {
    throw new PdfSealError(`The artifact digest covered ${whole.absorbed()} bytes, not ${update.totalSize}.`);
  }
  const artifactDigestHex = whole.digestHex();

  return {
    suffix,
    area,
    byteRange,
    signedDigestHex,
    artifactDigestHex,
    totalSize: update.totalSize,
    resumed,
  };
}

/**
 * The hash state covering the base, resumed or rebuilt.
 *
 * A state that names another object or another length is `SOURCE_CHANGED` and
 * stops the operation. A state that is merely unreadable, missing or stamped by
 * another build is a reason to do the work again, not a reason to fail: those
 * say nothing about whether the document is the right one.
 */
async function baseDigestState(
  source: PdfSource,
  savedDigest: SavedDigestState | null,
  signal: AbortSignal,
): Promise<{ state: SavedDigestState; resumed: boolean }> {
  if (savedDigest) {
    try {
      // Loaded and discarded. This proves the state is usable before the
      // decision to trust it, so the fallback is chosen here rather than
      // halfway through a digest.
      await resumeDigest(savedDigest, source.ref);
      return { state: savedDigest, resumed: true };
    } catch (err: any) {
      if (err instanceof SourceChangedError) throw err;
      console.warn(
        `[pdf:seal] Rebuilding the digest for ${source.ref.objectPath}: saved state unusable (${err?.message || err}).`,
      );
    }
  } else {
    console.warn(`[pdf:seal] Rebuilding the digest for ${source.ref.objectPath}: no saved state.`);
  }

  const digest = await createResumableDigest();
  for await (const chunk of source.stream(0, source.ref.sizeBytes, signal)) {
    digest.update(chunk);
  }
  if (digest.absorbed() !== source.ref.sizeBytes) {
    throw new PdfSealError(
      `Reading the source produced ${digest.absorbed()} bytes, not the ${source.ref.sizeBytes} its index reports.`,
    );
  }
  return { state: digest.save(source.ref), resumed: false };
}

/**
 * Read the two fields back out of a sealed suffix.
 *
 * This deliberately reads the BYTES rather than returning what the seal was
 * told to write. A check that reports what the writer intended proves nothing
 * about what a verifier will find.
 */
export function readSealedSignature(
  suffix: Uint8Array,
  area: SignatureArea,
  baseSize: number,
): { cms: Uint8Array; byteRange: number[] } {
  const rangeAt = area.byteRangeStart - baseSize;
  const rangeText = Buffer.from(
    suffix.subarray(rangeAt, rangeAt + area.byteRangeLength),
  ).toString('latin1');
  const match = rangeText.match(/^\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]$/);
  if (!match) throw new PdfSealError(`The /ByteRange field does not read back as four numbers: ${rangeText}`);
  const byteRange = match.slice(1, 5).map(Number);

  const at = area.contentsStart - baseSize;
  const token = Buffer.from(suffix.subarray(at, at + area.contentsLength)).toString('latin1');
  if (!token.startsWith('<') || !token.endsWith('>')) {
    throw new PdfSealError('The /Contents field is not a hex string.');
  }
  const raw = Buffer.from(token.slice(1, -1), 'hex');
  return { cms: trimDer(raw), byteRange };
}

/**
 * Cut the zero padding off a DER structure.
 *
 * The reserved hole is filled to its full width, so the bytes after the
 * signature are zeros. A CMS parser given the padded buffer either refuses it or
 * reads past the structure, so the real length is taken from the DER header
 * rather than guessed by trimming zeros: a signature may legitimately end in a
 * zero byte.
 */
export function trimDer(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2) throw new PdfSealError('The seal is too short to be a DER structure.');
  const first = bytes[1];
  if (first < 0x80) return bytes.subarray(0, 2 + first);
  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4 || bytes.length < 2 + lengthBytes) {
    throw new PdfSealError('The seal does not begin with a readable DER length.');
  }
  let length = 0;
  for (let i = 0; i < lengthBytes; i += 1) length = length * 256 + bytes[2 + i];
  const end = 2 + lengthBytes + length;
  if (end > bytes.length) throw new PdfSealError('The seal claims a length past the reserved area.');
  return bytes.subarray(0, end);
}

/**
 * Check a sealed suffix the way a verifier would.
 *
 * It re-reads both fields from the bytes, confirms the covered ranges are the
 * ones the hole implies, and checks the signature mathematically. The digest is
 * supplied rather than recomputed here, because recomputing it from the same
 * state that produced it would test nothing: a defect in the resume path would
 * cancel out. Re-streaming the composed artifact is a separate, bounded audit.
 */
export function verifySealedSuffix(options: {
  sealed: SealedSuffix;
  baseSize: number;
  digestHex: string;
}): VerificationResult {
  const { sealed, baseSize, digestHex } = options;
  const { cms, byteRange } = readSealedSignature(sealed.suffix, sealed.area, baseSize);

  const expected = sealed.byteRange;
  if (byteRange.length !== 4 || byteRange.some((value, i) => value !== expected[i])) {
    return { valid: false, reason: `The written /ByteRange is [${byteRange}], not [${expected}].` };
  }
  const holeStart = sealed.area.contentsStart;
  const holeEnd = holeStart + sealed.area.contentsLength;
  if (byteRange[0] !== 0 || byteRange[0] + byteRange[1] !== holeStart || byteRange[2] !== holeEnd) {
    return { valid: false, reason: 'The covered ranges do not sit either side of the signature.' };
  }
  if (byteRange[2] + byteRange[3] !== sealed.totalSize) {
    return { valid: false, reason: 'The covered ranges stop before the end of the document.' };
  }

  return verifyDetachedSignature({ cms, digestHex });
}
