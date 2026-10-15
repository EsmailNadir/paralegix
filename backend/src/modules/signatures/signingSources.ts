/**
 * The admission boundary for documents sent for signature.
 *
 * Three routes can put a document in front of a signer: a direct upload, a file
 * the firm already owns, and a template. Each used to decide for itself whether
 * the bytes were signable, and the three disagreed. One checked the leading
 * bytes and the stored size, one trusted a file the firm owned, and the template
 * route checked neither, so a template built on an encrypted PDF failed at the
 * point a signer had already been invited and emailed.
 *
 * This module makes admission a ROW rather than a code path. A session or
 * template names a source, a source carries a status, and nothing reads bytes
 * for a signer until that status is `ready`. A new entry point cannot skip the
 * check, because there is nothing else to point a session at.
 *
 * Two rules hold throughout. Nothing here reads a whole document: inspection
 * walks the cross-reference and the page tree through bounded windows, so a
 * 2 GB file costs what a 2 MB one costs. And every read pins the generation the
 * source row recorded, so a document replaced between admission and signing
 * fails loudly instead of being signed in its new form under a decision made
 * about its old bytes.
 */
import { AppError } from '../../shared/errors/AppError';
import { openGcsPdfSource } from './pdf/gcsSource';
import { readDocumentIndex, getObject } from './pdf/reader';
import { resolvePages } from './pdf/pages';
import type { PdfDict, PdfSource, PdfValue, StoredPdf } from './pdf/types';
import { createResumableDigest, resumeDigest, DIGEST_STATE_VERSION } from './pdf/resumableDigest';
import { SIGNING_PROFILE, describeBytes } from './signingProfile';
import { flattenAcroForm } from './pdf/forms';
import { composeParts, isPreconditionFailed } from './pdf/compose';

const repo = require('./signatures.repository');
const { registerJobHandler } = require('./signingJobs');

/**
 * The bucket, resolved per call rather than at module load.
 *
 * A handle taken at load time initializes the storage client the moment this
 * file is required, which pulls credentials into the graph of every test and
 * every request that never touches storage. The lazy-init guard fails a build
 * that does it.
 */
function bucket() {
  const { admin } = require('../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

/**
 * Every way admission can say no.
 *
 * The set is closed and is mirrored by a CHECK on `signature_sources`. A route
 * turns one of these into user copy; parser internals never reach a person,
 * because "unexpected token at offset 918233" tells a paralegal nothing and
 * tells an attacker something.
 */
export type SourceRefusalCode =
  | 'PDF_INVALID'
  | 'PDF_ENCRYPTED'
  | 'PDF_EXISTING_SIGNATURE'
  | 'PDF_UNSUPPORTED_FORM'
  | 'PDF_RESOURCE_LIMIT'
  | 'FILE_TOO_LARGE'
  | 'SOURCE_CHANGED';

const REFUSAL_COPY: Record<SourceRefusalCode, string> = {
  PDF_INVALID: 'This file is not a PDF we can read. Try opening it and saving it again as a PDF.',
  PDF_ENCRYPTED: 'This PDF is password protected. Remove the protection and upload it again.',
  PDF_EXISTING_SIGNATURE: 'This PDF is already digitally signed. Signing it again would break the existing signature.',
  PDF_UNSUPPORTED_FORM: 'This PDF has form fields we cannot prepare for signing. Flatten the form and upload it again.',
  PDF_RESOURCE_LIMIT: 'This PDF is too complex to prepare for signing.',
  FILE_TOO_LARGE: 'This file is larger than the limit for a document sent for signature.',
  SOURCE_CHANGED: 'This document changed while it was being prepared. Select it again.',
};

/** A refusal a route can return directly, carrying a stable code. */
export class SourceRefused extends AppError {
  readonly refusalCode: SourceRefusalCode;

  /** Kept for the source row and the log. Never sent to a signer. */
  readonly detail: string | undefined;

  constructor(code: SourceRefusalCode, detail?: string) {
    super(REFUSAL_COPY[code], code === 'FILE_TOO_LARGE' ? 413 : 422, code);
    this.refusalCode = code;
    this.detail = detail;
  }
}

/**
 * The admission policy this build applies.
 *
 * Recorded on every source, which is what makes changing a limit safe: a
 * document admitted under version 1 is never silently treated as if it had
 * passed version 2's checks.
 */
export const SOURCE_PROFILE_VERSION = SIGNING_PROFILE.version;

const asDict = (value: PdfValue | null): PdfDict | null =>
  (value && typeof value === 'object' && (value as any).kind === 'dict') ? value as PdfDict : null;

/**
 * What storage says landed, pinned to one version.
 *
 * The generation comes back as a string because a GCS generation is 64-bit. The
 * `getMetadata` call is the only place the value is read, so it is the only
 * place that has to resist being turned into a number.
 */
export async function pinStoredObject(objectPath: string): Promise<StoredPdf> {
  const file = bucket().file(objectPath);
  const [exists] = await file.exists();
  if (!exists) throw new SourceRefused('SOURCE_CHANGED', `${objectPath} is not in storage.`);
  const [meta] = await file.getMetadata();
  const generation = String(meta.generation ?? '');
  const sizeBytes = Number(meta.size ?? 0);
  if (!generation) throw new SourceRefused('SOURCE_CHANGED', `${objectPath} reported no generation.`);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new SourceRefused('PDF_INVALID', `${objectPath} reported a size of ${meta.size}.`);
  }
  return { objectPath, generation, sizeBytes };
}

/**
 * Inspect a stored PDF's structure without reading it.
 *
 * Every check here answers a question that decides whether a signature on this
 * document would mean anything. An encrypted document's streams use a key the
 * writer does not have, so anything appended to it is unreadable. A document
 * that already carries a signature cannot take another one through this path,
 * because the append would invalidate the first and the first signer never
 * agreed to that. A form has to be flattened before a signer sees it, or the
 * value shown at signing time is not the value that gets sealed.
 */
export async function inspectStoredPdf(source: PdfSource, signal: AbortSignal): Promise<{
  pageCount: number;
  hasAcroForm: boolean;
}> {
  // Clamped, because an object shorter than the window is a refusal about the
  // content, not a read error about the request.
  const head = await source.read(0, Math.min(8, source.ref.sizeBytes), signal);
  if (Buffer.from(head.subarray(0, 4)).toString('latin1') !== '%PDF') {
    // The leading bytes, not the name. A non-PDF stored under a .pdf path
    // dead-ends every viewer downstream, all of which trust the stored type.
    throw new SourceRefused('PDF_INVALID', 'The file does not begin with %PDF.');
  }

  let index;
  try {
    index = await readDocumentIndex(source, signal);
  } catch (err: any) {
    throw refusalFor(err, 'PDF_INVALID');
  }

  if (index.trailer.entries.has('Encrypt')) {
    throw new SourceRefused('PDF_ENCRYPTED', 'The trailer carries /Encrypt.');
  }

  let catalog: PdfDict | null;
  try {
    const root = index.trailer.entries.get('Root');
    if (!root || typeof root !== 'object' || (root as any).kind !== 'ref') {
      throw new SourceRefused('PDF_INVALID', 'The trailer has no /Root reference.');
    }
    catalog = asDict(await getObject(source, index, (root as any).value, signal));
  } catch (err: any) {
    throw refusalFor(err, 'PDF_INVALID');
  }
  if (!catalog) throw new SourceRefused('PDF_INVALID', 'The /Root is not a dictionary.');

  const acroFormRef = catalog.entries.get('AcroForm');
  let hasAcroForm = false;
  if (acroFormRef) {
    const acroForm = asDict(
      typeof acroFormRef === 'object' && (acroFormRef as any).kind === 'ref'
        ? await getObject(source, index, (acroFormRef as any).value, signal)
        : acroFormRef,
    );
    if (acroForm) {
      if (acroForm.entries.has('XFA')) {
        // An XFA form's appearance is generated by the viewer from XML this code
        // does not interpret. Flattening it would mean rendering it, and a
        // rendering that differs from the signer's viewer signs a different
        // document than the one they read.
        throw new SourceRefused('PDF_UNSUPPORTED_FORM', 'The AcroForm carries /XFA.');
      }
      const fields = acroForm.entries.get('Fields');
      hasAcroForm = !!fields && typeof fields === 'object'
        && (fields as any).kind === 'array' && (fields as any).values.length > 0;
      if (hasAcroForm && signedFieldFlag(acroForm)) {
        throw new SourceRefused('PDF_EXISTING_SIGNATURE', 'The AcroForm /SigFlags marks an existing signature.');
      }
    }
  }

  let pageCount: number;
  try {
    const pages = await resolvePages(source, index, signal);
    pageCount = pages.length;
  } catch (err: any) {
    throw refusalFor(err, 'PDF_INVALID');
  }
  if (pageCount === 0) throw new SourceRefused('PDF_INVALID', 'The document has no pages.');
  if (pageCount > SIGNING_PROFILE.maxSourcePages) {
    // The SOURCE ceiling, not the total. The service appends its own
    // certificate afterwards, and a document accepted at exactly the total
    // would then fail because this system made it longer.
    throw new SourceRefused(
      'PDF_RESOURCE_LIMIT',
      `${pageCount} pages, and the limit is ${SIGNING_PROFILE.maxSourcePages}.`,
    );
  }

  return { pageCount, hasAcroForm };
}

/**
 * `/SigFlags` bit 1 means the document contains at least one signature field.
 *
 * A field alone is not a signature, but a document that declares one and was
 * built by a signing tool is one this path must not append to. The stricter
 * reading is deliberate: refusing a document that could have been signed costs
 * an upload, and accepting one that was already signed silently voids someone
 * else's signature.
 */
function signedFieldFlag(acroForm: PdfDict): boolean {
  const flags = acroForm.entries.get('SigFlags');
  return typeof flags === 'number' && (flags & 1) === 1;
}

/**
 * Turn a parser error into a refusal, keeping a resource ceiling distinct from
 * a malformed file.
 *
 * The two are different answers for the user. "Too complex" means the document
 * is valid and this service will not spend the memory; "not a PDF we can read"
 * means saving it again may fix it.
 */
function refusalFor(err: any, fallback: SourceRefusalCode): SourceRefused {
  if (err instanceof SourceRefused) return err;
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  // A layer below may already have decided which refusal this is. Re-deciding
  // from its message would turn a precise "this form cannot be flattened" into
  // "this is not a PDF", which sends the user to fix the wrong thing.
  if ((REFUSAL_COPY as Record<string, string>)[code]) {
    return new SourceRefused(code as SourceRefusalCode, message);
  }
  if (code === 'PDF_FILTER_ERROR' || /too many|exceeds|limit|deep|nesting/i.test(message)) {
    return new SourceRefused('PDF_RESOURCE_LIMIT', message);
  }
  return new SourceRefused(fallback, message);
}

/**
 * Admit a stored object, or record why not.
 *
 * `uploadedBy` is never approval on its own. It says who put the bytes there,
 * which is a question about access, not about whether the bytes are a document
 * this service can sign. Both answers are needed and they are separate.
 *
 * A refusal is WRITTEN to the row before it is thrown, so a second attempt at
 * the same object does not re-inspect it and a support question has an answer.
 */
export async function admitStoredUpload(options: {
  lawFirmId: string;
  uploadedBy?: string | null;
  objectPath: string;
  declaredSizeBytes?: number | null;
  /** Defaults to the profile, so a caller cannot admit above the policy. */
  maxSizeBytes?: number;
  /**
   * An inspection the caller already ran over these exact bytes: the same
   * object, or a copy pinned to the generation it inspected. Given one,
   * admission records it instead of walking the document a second time.
   */
  inspection?: { pageCount: number } | null;
  signal?: AbortSignal;
}) {
  const { lawFirmId, uploadedBy, objectPath, declaredSizeBytes } = options;
  // The profile is the ceiling whatever the caller passes. A route that wants a
  // TIGHTER limit may have one; one that wants a looser one is asking to admit
  // a document the rest of the system is not sized for.
  const maxSizeBytes = Math.min(
    options.maxSizeBytes ?? SIGNING_PROFILE.maxSourceBytes,
    SIGNING_PROFILE.maxSourceBytes,
  );
  const signal = options.signal || new AbortController().signal;

  const source = await repo.createSource(lawFirmId, {
    uploadedBy: uploadedBy || null,
    objectPath,
    profileVersion: SOURCE_PROFILE_VERSION,
  });
  if (source.status === 'ready') return source;

  try {
    const ref = await pinStoredObject(objectPath);

    if (ref.sizeBytes > maxSizeBytes) {
      throw new SourceRefused(
        'FILE_TOO_LARGE',
        `${ref.sizeBytes} bytes, limit ${maxSizeBytes} (${describeBytes(maxSizeBytes)}).`,
      );
    }
    if (typeof declaredSizeBytes === 'number' && declaredSizeBytes !== ref.sizeBytes) {
      // The declaration is what the size ceiling was checked against at init.
      // A different length landed, so that check was made about other bytes.
      throw new SourceRefused(
        'SOURCE_CHANGED',
        `${ref.sizeBytes} bytes landed against a declared ${declaredSizeBytes}.`,
      );
    }

    let inspection = options.inspection ?? null;
    if (!inspection) {
      const pdf = openGcsPdfSource(ref);
      try {
        inspection = await inspectStoredPdf(pdf, signal);
      } finally {
        await pdf.close();
      }
    }

    const admitted = await repo.updateSource(lawFirmId, source.id, {
      objectGeneration: ref.generation,
      sizeBytes: ref.sizeBytes,
      pageCount: inspection.pageCount,
      status: 'pending',
      failureCode: null,
      failureDetail: null,
    });

    // The preparation job is committed WITH the admission, not after it. A job
    // enqueued once the response is on its way is lost by a process that dies
    // in between, and the source then sits `pending` for ever with nothing owed
    // and nobody looking.
    const job = await repo.enqueueProcessingJob(lawFirmId, {
      sourceId: admitted.id,
      kind: 'prepare',
      inputRevision: ref.generation,
    });
    return { ...admitted, jobId: job?.id || null };
  } catch (err: any) {
    const refusal = err instanceof SourceRefused ? err : refusalFor(err, 'PDF_INVALID');
    // The detail names what the parser objected to. It never reaches the user,
    // and without it here a refused upload is unanswerable in support.
    console.warn(`[signing] ${objectPath} refused: ${refusal.refusalCode} (${refusal.detail || refusal.message})`);
    await repo.updateSource(lawFirmId, source.id, {
      status: 'failed',
      failureCode: refusal.refusalCode,
      failureDetail: String(refusal.detail || refusal.message).slice(0, 500),
    });
    throw refusal;
  }
}

/**
 * Hash the prepared source once, and save the hash state at the end of it.
 *
 * ONE pass yields both facts sealing needs: the document hash that identifies
 * the source, and the resumable state that lets the seal digest the appended
 * suffix without reading the document again. Doing them separately would mean
 * two full reads of what may be gigabytes, on the instance that also serves
 * requests.
 *
 * `save()` is called before `digest()`, because a digest ends the hash. The
 * state is written to the row only with the completed digest, never partially:
 * a half-written state that loads cleanly is the one failure nothing downstream
 * can detect.
 */
export async function prepareSource(options: {
  lawFirmId: string;
  sourceId: string;
  operationId: string;
  signal?: AbortSignal;
}) {
  const { lawFirmId, sourceId, operationId } = options;
  const signal = options.signal || new AbortController().signal;

  const claimed = await repo.claimSourceForPreparation(lawFirmId, sourceId, operationId);
  if (!claimed) {
    // Either another worker holds it, or it already reached a terminal status.
    const current = await repo.getSource(lawFirmId, sourceId);
    if (current?.status === 'ready') return current;
    throw new SourceRefused('SOURCE_CHANGED', `Source ${sourceId} could not be claimed for preparation.`);
  }

  try {
    // The generation is re-pinned rather than trusted. Between admission and
    // preparation the object could have been replaced, and preparing the new
    // bytes under a decision made about the old ones is the exact mistake the
    // generation exists to prevent.
    const ref = await pinStoredObject(claimed.objectPath);
    if (claimed.objectGeneration && claimed.objectGeneration !== ref.generation) {
      throw new SourceRefused(
        'SOURCE_CHANGED',
        `${claimed.objectPath} is now generation ${ref.generation}, admitted at ${claimed.objectGeneration}.`,
      );
    }

    const pdf = openGcsPdfSource(ref);
    let uploadHash: string;
    let prepared: StoredPdf;
    let preparedHash: string;
    let state;
    try {
      // The form is flattened FIRST, because the digest has to cover the bytes
      // the signer will see. A signer who reads an editable field and a seal
      // over the un-flattened original are two different documents.
      const flatten = await flattenAcroForm({
        source: pdf,
        index: await readDocumentIndex(pdf, signal),
        signal,
      });

      // ONE read of the upload. The digest is resumed over the appended suffix
      // rather than restarted, so the prepared hash costs the suffix, not the
      // document.
      const digest = await createResumableDigest();
      for await (const chunk of pdf.stream(0, ref.sizeBytes, signal)) digest.update(chunk);
      if (digest.absorbed() !== ref.sizeBytes) {
        throw new SourceRefused(
          'SOURCE_CHANGED',
          `Read ${digest.absorbed()} bytes of a ${ref.sizeBytes}-byte object.`,
        );
      }
      // `save()` before `digest()`, because a digest ends the hash.
      const uploadState = digest.save(ref);
      uploadHash = digest.digestHex();

      if (!flatten.flattened) {
        // Nothing to rewrite, so the prepared source IS the upload: same object,
        // same generation, same digest. An empty appended revision would change
        // the bytes for no reason, and the completed PDF has to carry the
        // prepared bytes unchanged.
        prepared = ref;
        preparedHash = uploadHash;
        state = uploadState;
      } else {
        prepared = await composeFlattened(lawFirmId, sourceId, ref, flatten.update.suffix);
        const resumed = await resumeDigest(uploadState, ref);
        resumed.update(flatten.update.suffix);
        state = resumed.save(prepared);
        preparedHash = resumed.digestHex();
      }
    } finally {
      await pdf.close();
    }

    return await repo.updateSource(lawFirmId, sourceId, {
      status: 'ready',
      documentHash: uploadHash,
      preparedObjectPath: prepared.objectPath,
      preparedGeneration: prepared.generation,
      preparedSizeBytes: prepared.sizeBytes,
      preparedHash,
      digestAlgorithm: 'sha256',
      digestLibraryVersion: DIGEST_STATE_VERSION,
      digestState: Buffer.from(state.state).toString('base64'),
      digestStateBytes: state.bytes,
      digestStateGeneration: prepared.generation,
      failureCode: null,
      failureDetail: null,
    });
  } catch (err: any) {
    const refusal = err instanceof SourceRefused ? err : refusalFor(err, 'PDF_INVALID');
    console.warn(
      `[signing] preparation of source ${sourceId} failed: ${refusal.code} (${refusal.detail || refusal.message})`,
    );
    await repo.updateSource(lawFirmId, sourceId, {
      status: 'failed',
      failureCode: refusal.refusalCode,
      failureDetail: String(refusal.detail || refusal.message).slice(0, 500),
    });
    throw refusal;
  }
}

/**
 * Write the flattened suffix and compose it onto the immutable upload.
 *
 * The upload is never rewritten and never passes through this process: GCS
 * joins the two objects server-side, so the cost is independent of the
 * document's size. The scratch suffix is removed afterwards, and on failure
 * too, because a stray part is billed storage nobody can identify.
 */
async function composeFlattened(
  lawFirmId: string,
  sourceId: string,
  upload: StoredPdf,
  suffix: Uint8Array,
): Promise<StoredPdf> {
  const prefix = `signing-uploads/${lawFirmId}/prepared/${sourceId}/`;
  const suffixPath = `${prefix}form-suffix`;
  const storage = bucket();

  await storage.file(suffixPath).save(Buffer.from(suffix), {
    resumable: false,
    metadata: { contentType: 'application/pdf' },
  });
  try {
    const [meta] = await storage.file(suffixPath).getMetadata();
    const destination = `${prefix}source.pdf`;
    const compose = () => composeParts({
      parts: [
        { objectPath: upload.objectPath, generation: upload.generation },
        { objectPath: suffixPath, generation: String(meta.generation) },
      ],
      destination,
      scratchPrefix: prefix,
    });
    try {
      return await compose();
    } catch (err: any) {
      if (!isPreconditionFailed(err)) throw err;
      // The destination is taken and this source is still `preparing`, which
      // is only possible when an earlier attempt of THIS preparation composed
      // and died before recording it. Nothing reads a prepared object until
      // the row says `ready`, so replacing it loses nothing. The claim above
      // is what makes this worker the only one inside the preparation. Once:
      // a second collision means something else is writing here, and racing
      // it is what create-only exists to prevent.
      await storage.file(destination).delete().catch(() => {});
      return await compose();
    }
  } finally {
    await storage.file(suffixPath).delete().catch(() => {});
  }
}

/**
 * The source a route is allowed to act on, or a refusal.
 *
 * Callers pass the generation they believe they are working with. Omitting it
 * is allowed only where the caller has no generation yet; passing a stale one
 * is `SOURCE_CHANGED`, which is the whole point of recording it.
 */
export async function requireReadySource(lawFirmId: string, sourceId: string, expectedGeneration?: string | null) {
  const source = await repo.getSource(lawFirmId, sourceId);
  if (!source) throw new SourceRefused('SOURCE_CHANGED', `Source ${sourceId} does not exist for this firm.`);
  if (source.status === 'failed' && source.failureCode) {
    throw new SourceRefused(source.failureCode as SourceRefusalCode, source.failureDetail || undefined);
  }
  if (source.status !== 'ready') {
    const err: any = new AppError(
      'This document is still being prepared for signing.',
      409,
      'SOURCE_NOT_READY',
    );
    err.details = { sourceId, status: source.status, operationId: source.operationId };
    throw err;
  }
  if (expectedGeneration && String(expectedGeneration) !== String(source.preparedGeneration)) {
    throw new SourceRefused(
      'SOURCE_CHANGED',
      `Expected generation ${expectedGeneration}, prepared at ${source.preparedGeneration}.`,
    );
  }
  return source;
}

/**
 * The saved hash state for a ready source, in the shape the seal resumes.
 *
 * Returns null when the row carries no usable state. That is not an error: the
 * seal streams the source instead, which is the path a source prepared before
 * this existed always takes.
 */
export function savedDigestStateOf(source: any) {
  if (!source?.digestState || !source.digestStateBytes || !source.digestStateGeneration) return null;
  if (source.digestAlgorithm !== 'sha256') return null;
  return {
    version: String(source.digestLibraryVersion || ''),
    state: new Uint8Array(source.digestState),
    bytes: Number(source.digestStateBytes),
    objectPath: String(source.preparedObjectPath || source.objectPath),
    generation: String(source.digestStateGeneration),
  };
}

/**
 * A display filename for a confirmed PDF that arrived without an extension.
 *
 * The name is cosmetic and is corrected only after the content check has
 * already passed. A MIME type or an extension never stands in for that check:
 * both are supplied by whoever uploaded the file.
 */
export function pdfDisplayName(fileName: string | null | undefined, fallback = 'document.pdf'): string {
  const name = String(fileName || '').trim() || fallback;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}


/**
 * Preparation, as a durable job.
 *
 * Registered here rather than in the worker so that requiring the worker does
 * not pull the whole PDF engine into every process that runs the drain.
 *
 * The job's `inputRevision` is the generation admission pinned. Preparing a
 * different one would hash bytes nobody inspected, so the mismatch is
 * SOURCE_CHANGED and the job settles rather than retrying: a replaced object
 * will still be replaced on the next attempt.
 */
registerJobHandler('prepare', async (job: any, context: any) => {
  if (job.inputRevision) {
    const source = await repo.getSource(job.lawFirmId, job.sourceId);
    if (source?.objectGeneration && source.objectGeneration !== job.inputRevision) {
      throw new SourceRefused(
        'SOURCE_CHANGED',
        `The job was committed for generation ${job.inputRevision}, and the source is at ${source.objectGeneration}.`,
      );
    }
  }
  await prepareSource({
    lawFirmId: job.lawFirmId,
    sourceId: job.sourceId,
    operationId: job.id,
  });
  // The publish already happened inside `prepareSource`, which writes the row.
  // The checkpoint records that this phase is durable, so a resumed job knows
  // not to redo it.
  await context.checkpoint('prepared', { sourceId: job.sourceId });
});
