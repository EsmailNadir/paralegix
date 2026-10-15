/**
 * Checking a stored artifact's seal, without holding the artifact.
 *
 * A verifier does the same work as a signer, in reverse: find the signature,
 * read which bytes it says it covers, hash those bytes, and check the signature
 * against that hash. None of it needs the document in memory, because hashing
 * is a stream and everything else is a few small windows.
 *
 * Two results come out of this, and keeping them apart is the whole point:
 *
 * IDENTITY is "these bytes are the artifact we recorded". It is a hash lookup.
 * It says nothing about whether anyone signed anything, and reporting a hash
 * match as tamper-evidence is how an unsealed document gets described as
 * verified.
 *
 * SEAL VALIDITY is "a signature over these bytes checks out against the
 * certificate in it". That is a mathematical fact about the bytes in front of
 * you. It is still not a claim about public trust or about a timestamp: a
 * self-signed certificate verifies perfectly and proves only that whoever holds
 * that key signed this.
 *
 * The third thing checked here is COVERAGE. A signature whose ByteRange stops
 * short of the end of the file is valid over the bytes it covers, and those are
 * not the bytes anybody is reading: a revision appended after signing sits
 * outside the range and changes what the document says. Every viewer that
 * reports "signed" without checking coverage can be shown a document that says
 * anything.
 */
import { AppError } from '../../../shared/errors/AppError';
import { verifyDetachedSignature } from './cms';
import { assertValidByteRange, digestByteRange, type ByteSpan } from './digest';
import { getObject, readDocumentIndex } from './reader';
import { trimDer } from './seal';
import type { PdfDict, PdfSource, PdfValue } from './types';

export class PdfVerifyError extends AppError {
  constructor(message: string, code = 'PDF_VERIFY_FAILED') {
    super(message, 400, code);
  }
}

export interface SealVerification {
  /** Whether the document carries a signature at all. */
  sealed: boolean;
  /** Whether that signature checks out against the bytes it covers. */
  sealValid: boolean;
  /** Whether it covers every byte of the file. */
  coversWholeFile: boolean;
  /** SHA-256 of the covered bytes, which is what the signature signs. */
  signedDigestHex?: string;
  signerCommonName?: string;
  signingTime?: Date;
  /** Why it failed, when it did. Never a reason to treat it as valid. */
  reason?: string;
}

const asDict = (value: PdfValue | null): PdfDict | null =>
  (value && typeof value === 'object' && (value as any).kind === 'dict') ? value as PdfDict : null;

const isRef = (value: PdfValue | undefined): boolean =>
  !!value && typeof value === 'object' && (value as any).kind === 'ref';

/** Resolve one indirect hop, or hand back what was already a value. */
async function deref(source: PdfSource, index: any, value: PdfValue | undefined, signal: AbortSignal) {
  if (!isRef(value)) return value ?? null;
  return getObject(source, index, (value as any).value, signal);
}

/**
 * Verify the signature on a stored artifact.
 *
 * Every failure is reported rather than thrown, because "this document is not
 * signed" and "this signature does not check out" are both answers a caller has
 * to show a user. A thrown error would make them indistinguishable from the
 * service being broken.
 */
export async function verifySealedArtifact(
  source: PdfSource,
  signal: AbortSignal,
): Promise<SealVerification> {
  const read = await readSealLayout(source, signal);
  if ('verification' in read) return read.verification;
  const signedDigestHex = await digestByteRange(source, read.layout.spans, signal);
  return finishVerification(read.layout, signedDigestHex);
}

/** What a seal claims, read before the document body is touched. */
export interface SealLayout {
  spans: ByteSpan[];
  cms: Uint8Array;
  coversWholeFile: boolean;
}

/**
 * Everything verification needs that is not the document body.
 *
 * The index, the signature dictionary and the CMS blob are all bounded reads.
 * Splitting them from the ByteRange digest lets a caller that ALSO needs the
 * whole-file digest take both from one pass over the body, instead of this
 * reading the body once and the caller reading it again.
 *
 * A document that fails before the digest (unsealed, unreadable, a malformed
 * range) comes back as a finished verification rather than a layout.
 */
export async function readSealLayout(
  source: PdfSource,
  signal: AbortSignal,
): Promise<{ layout: SealLayout } | { verification: SealVerification }> {
  const unsealed = (reason: string) => ({
    verification: { sealed: false, sealValid: false, coversWholeFile: false, reason } as SealVerification,
  });

  let index;
  try {
    index = await readDocumentIndex(source, signal);
  } catch (err: any) {
    return unsealed(`This document could not be read: ${err.message}`);
  }

  const signature = await findSignatureDictionary(source, index, signal);
  if (!signature) return unsealed('This document carries no signature.');

  const byteRange = readByteRange(signature);
  if (!byteRange) {
    return {
      verification: { sealed: true, sealValid: false, coversWholeFile: false, reason: 'The signature has no usable /ByteRange.' },
    };
  }

  const spans = [
    { start: byteRange[0], length: byteRange[1] },
    { start: byteRange[2], length: byteRange[3] },
  ].filter((span) => span.length > 0);

  try {
    // Overlapping or out-of-order spans hash some bytes twice, so the digest
    // would cover a byte sequence that does not exist in the file.
    assertValidByteRange(spans, source.ref.sizeBytes);
  } catch (err: any) {
    return { verification: { sealed: true, sealValid: false, coversWholeFile: false, reason: err.message } };
  }

  // A gap that is not exactly the `/Contents` token means the signature skips
  // bytes that are part of the document.
  const holeStart = byteRange[0] + byteRange[1];
  const holeEnd = byteRange[2];
  const coversWholeFile = byteRange[0] === 0
    && byteRange[2] + byteRange[3] === source.ref.sizeBytes;

  try {
    const cms = await readContents(source, holeStart, holeEnd, signal);
    return { layout: { spans, cms, coversWholeFile } };
  } catch (err: any) {
    return { verification: { sealed: true, sealValid: false, coversWholeFile, reason: err.message } };
  }
}

/** Check the CMS against a ByteRange digest the caller computed. */
export function finishVerification(layout: SealLayout, signedDigestHex: string): SealVerification {
  const result = verifyDetachedSignature({ cms: layout.cms, digestHex: signedDigestHex });
  return {
    sealed: true,
    sealValid: result.valid && layout.coversWholeFile,
    coversWholeFile: layout.coversWholeFile,
    signedDigestHex,
    signerCommonName: result.signerCommonName,
    signingTime: result.signingTime,
    reason: result.valid
      ? (layout.coversWholeFile ? undefined : 'The signature does not cover the whole file.')
      : result.reason,
  };
}

/**
 * The signature dictionary, found the way a viewer finds it.
 *
 * Through the catalog's AcroForm rather than by searching for `/Type /Sig`,
 * because a document may contain an object that looks like a signature and is
 * not referenced by any field. What a viewer shows is what is reachable from
 * the form.
 */
async function findSignatureDictionary(source: PdfSource, index: any, signal: AbortSignal) {
  const catalog = asDict(await deref(source, index, index.trailer.entries.get('Root'), signal));
  if (!catalog) return null;

  const acroForm = asDict(await deref(source, index, catalog.entries.get('AcroForm'), signal));
  if (!acroForm) return null;

  const fields = await deref(source, index, acroForm.entries.get('Fields'), signal);
  if (!fields || typeof fields !== 'object' || (fields as any).kind !== 'array') return null;

  for (const entry of (fields as any).values) {
    const field = asDict(await deref(source, index, entry, signal));
    if (!field) continue;
    const type = field.entries.get('FT');
    if (!type || typeof type !== 'object' || (type as any).value !== 'Sig') continue;
    const value = asDict(await deref(source, index, field.entries.get('V'), signal));
    if (value) return value;
  }
  return null;
}

/** `/ByteRange [a b c d]`, as four safe integers. */
function readByteRange(signature: PdfDict): [number, number, number, number] | null {
  const raw = signature.entries.get('ByteRange');
  if (!raw || typeof raw !== 'object' || (raw as any).kind !== 'array') return null;
  const values = (raw as any).values;
  if (values.length !== 4) return null;
  if (!values.every((v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return null;
  return values as [number, number, number, number];
}

/**
 * The CMS blob, read from the gap the ByteRange leaves.
 *
 * Taken from the FILE rather than from the parsed dictionary. The parsed value
 * is what the lexer made of the token; this is the token itself, in the exact
 * span the signature says it skipped, which is what a verifier has to check.
 */
async function readContents(
  source: PdfSource,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = end - start;
  if (length <= 2) throw new PdfVerifyError('The signature leaves no room for a seal.');
  if (length > 1024 * 1024) {
    // A reserved area this large is not a signature, it is an invitation to
    // allocate whatever the document asks for.
    throw new PdfVerifyError(`The reserved signature area is ${length} bytes.`);
  }
  const token = Buffer.from(await source.read(start, length, signal)).toString('latin1');
  if (!token.startsWith('<') || !token.endsWith('>')) {
    throw new PdfVerifyError('The gap the /ByteRange leaves is not a hex string.');
  }
  return trimDer(new Uint8Array(Buffer.from(token.slice(1, -1), 'hex')));
}
