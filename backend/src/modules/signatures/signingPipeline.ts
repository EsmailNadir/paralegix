/**
 * Producing the two executed artifacts, without the document in memory.
 *
 * The old path ran five whole-document passes through pdf-lib: stamp, flatten,
 * seal the delivery copy, append the certificate, seal the stored copy. It
 * peaked at 299 MB for a 20 MB document and 858 MB for a 48 MB one, against a
 * 512 MiB container. That is why the signing cap is 20 MB, and it is a cap on
 * the IMPLEMENTATION rather than on anything a law firm would recognise.
 *
 * Here nothing whole is ever held. Every step appends a suffix of kilobytes,
 * and storage joins that suffix to the immutable object it belongs to. The cost
 * of executing a document is the cost of its stamps, its certificate and two
 * signatures, whatever the document weighs.
 *
 * The ORDER is load-bearing and is the plan's, not a convenience:
 *
 * The stamped source is built ONCE and both artifacts are built on top of it,
 * so the two differ only in what comes after the last shared byte. That is what
 * lets a single saved hash state serve both seals.
 *
 * DELIVERY IS SEALED FIRST, because the certificate has to state the delivered
 * copy's hash. A page cannot state the hash of the file that contains it, so
 * the certificate names a file that real recipients actually hold.
 *
 * The certificate is appended to the UNSEALED stamped source, never to the
 * sealed delivery copy. Appending to a sealed document invalidates the seal it
 * already carries, and the result opens in a viewer showing a broken signature.
 *
 * Nothing is published until BOTH seals verify. A failure leaves the job
 * retryable, never a completed session pointing at an unsigned artifact.
 */
import { AppError } from '../../shared/errors/AppError';
import { openGcsPdfSource } from './pdf/gcsSource';
import { readDocumentIndex, readStartXref, getObject } from './pdf/reader';
import { resolvePages } from './pdf/pages';
import { planAppearance } from './pdf/appearances';
import { planFieldPlacements } from './pdf/fieldPlacement';
import { planCertificateContent } from './pdf/certificateContent';
import { planAppendedPages, nextObjectNumber } from './pdf/appendPage';
import { buildIncrementalUpdate, withEntries } from './pdf/writer';
import { composeParts, isPreconditionFailed } from './pdf/compose';
import { sealSuffix, verifySealedSuffix } from './pdf/seal';
import { createResumableDigest, resumeDigest } from './pdf/resumableDigest';
import type { SavedDigestState } from './pdf/resumableDigest';
import type { SigningIdentity } from './pdf/cms';
import type { AppendedObject } from './pdf/writer';
import type { CertificateData } from './pdf/certificateContent';
import type { FieldPlacementFailure, PlaceableField } from './pdf/fieldPlacement';
import type { ResolvedPage } from './pdf/pages';
import type { PdfDict, PdfRef, PdfValue, StoredPdf } from './pdf/types';

export class SigningPipelineError extends AppError {
  constructor(message: string, code = 'SIGNING_PIPELINE_FAILED') {
    super(message, 500, code);
  }
}

function bucket() {
  const { admin } = require('../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const refValue = (ref: PdfRef): PdfValue => ({ kind: 'ref', value: ref });
const numbered = (n: number): PdfRef => ({ objectNumber: n, generationNumber: 0 });

/**
 * Bytes reserved for each seal. An RSA-2048 CMS blob is around 2 KB.
 *
 * A certificate CHAIN makes it larger, and how much larger is a property of the
 * provisioned certificate rather than of this code, so the reservation grows
 * rather than being guessed generously: a fixed 64 KiB hole in every signed
 * document is 64 KiB of nothing, and a fixed 8 KiB one refuses a chain that is
 * perfectly valid.
 */
const CONTENTS_CAPACITY = Number(process.env.SIGNING_CONTENTS_CAPACITY) || 8192;

/**
 * The ceiling the reservation may grow to.
 *
 * Growing at all is only safe because the whole suffix is rebuilt each time: the
 * offsets and the digest are recomputed from the new layout, never patched. The
 * ceiling exists so a certificate chain that is wrong rather than large fails
 * with a stated reason instead of enlarging the hole until something else
 * breaks.
 */
const MAX_CONTENTS_CAPACITY = Number(process.env.SIGNING_MAX_CONTENTS_CAPACITY) || 64 * 1024;

/** What one field's mark looks like, in the appearance's own coordinates. */
export interface FieldAppearance {
  /** The content stream that draws it. */
  content: Uint8Array;
  /** The appearance's own size, which the placement scales onto the page. */
  bbox: { width: number; height: number };
  /** Resources it needs, for instance its font or its image. */
  resources: PdfDict;
  /** Anything those resources point at, for instance an image XObject. */
  objects?: AppendedObject[];
}

/**
 * One field's mark: where it goes, and how to draw it.
 *
 * The appearance is a FUNCTION rather than a value for two reasons. An image
 * needs an object number, and only the pipeline knows which numbers are free,
 * so `allocate` hands out the next one. And the mark's size depends on the
 * field's box in POINTS, which the pipeline works out from the page geometry:
 * the font ceiling, the minimum stroke width and the signature layout all read
 * real point sizes, so a caller guessing the box would draw a different mark
 * from the one the signer previewed. Passing it here saves the caller opening
 * the document a second time purely to learn a number this function already has.
 */
export interface StampableField extends PlaceableField {
  appearance(allocate: () => PdfRef, box: { width: number; height: number }): FieldAppearance;
}

/** One produced artifact: where it is, and what it hashes to. */
export interface SealedArtifact {
  ref: StoredPdf;
  /** SHA-256 of the whole artifact, which is its identity. */
  digestHex: string;
  /** SHA-256 of the bytes the signature covers. */
  signedDigestHex: string;
}

/**
 * What one run produced, or why it produced nothing.
 *
 * `delivery` and `filed` are NULLABLE, and that is deliberate rather than
 * defensive: a run that could not place a field publishes nothing at all, and a
 * caller that reaches for the artifacts without looking at `failures` first
 * should not compile. Returning empty artifacts instead would let a session be
 * marked complete against documents that do not exist.
 */
export interface PipelineResult {
  /** Source plus stamps, unsealed. Both artifacts are built on this. */
  stamped: StoredPdf;
  /** What signers receive: no certificate page. Null when nothing was published. */
  delivery: SealedArtifact | null;
  /** What the firm files: certificate page included. Null when nothing was published. */
  filed: SealedArtifact | null;
  /** Fields that could not be placed. Non-empty means nothing was published. */
  failures: FieldPlacementFailure[];
}

/** Append field appearances to a stored PDF without reading the whole file. */
export async function stampStoredPdf(options: {
  source: StoredPdf;
  fields: StampableField[];
  destination: string;
  scratchPrefix: string;
  /**
   * The source's saved digest state. Given one, the stamped copy's hash is the
   * state resumed over the appended suffix, which costs the suffix rather than
   * a second read of the document.
   */
  savedDigest?: SavedDigestState | null;
  signal?: AbortSignal;
}): Promise<{ stamped: StoredPdf; failures: FieldPlacementFailure[]; digestHex: string | null }> {
  const signal = options.signal || new AbortController().signal;
  const prepared = openGcsPdfSource(options.source);
  try {
    const index = await readDocumentIndex(prepared, signal);
    const pages = await resolvePages(prepared, index, signal);
    const plan = await planStamps(prepared, index, pages, options.fields, signal);
    if (plan.failures.length > 0) return { stamped: options.source, failures: plan.failures, digestHex: null };
    // Resumed BEFORE the compose, so a state that does not describe this
    // source is refused before anything is written.
    const digest = options.savedDigest ? await resumeDigest(options.savedDigest, options.source) : null;
    const stamped = await composeSuffix({
      base: options.source,
      suffix: plan.update.suffix,
      destination: options.destination,
      scratchPrefix: options.scratchPrefix,
    });
    let digestHex: string | null = null;
    if (digest) {
      digest.update(plan.update.suffix);
      digestHex = digest.digestHex();
    }
    return { stamped, failures: [], digestHex };
  } finally {
    await prepared.close();
  }
}

/**
 * Build, seal and store both executed artifacts.
 *
 * `savedDigest` is the state preparation left over the prepared source. Without
 * it the source is streamed once here instead, which is correct and is the path
 * a source prepared before the state existed takes.
 */
export async function runSigningPipeline(options: {
  source: StoredPdf;
  savedDigest?: SavedDigestState | null;
  fields: StampableField[];
  /** Fieldless signing uploads already contain their visible marks. */
  allowUnstampedSource?: boolean;
  certificate: CertificateData;
  identity: SigningIdentity;
  signingTime?: Date;
  /** Prefix for intermediates. Everything under it is removed afterwards. */
  scratchPrefix: string;
  deliveryPath: string;
  filedPath: string;
  stampedPath: string;
  /**
   * Whether this worker still holds the job it is finalizing.
   *
   * Asked only when a destination is ALREADY THERE, which means an earlier
   * attempt composed it and then died before the session row could record it.
   * Nothing references those bytes, so replacing them is safe, but only for a
   * worker whose claim is still good: one whose lease expired may be looking at
   * an object the worker that replaced it has already published a reference to.
   *
   * Absent, a taken destination is refused rather than replaced.
   */
  claimStillHeld?: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<PipelineResult> {
  const {
    source, fields, certificate, identity, signingTime,
    scratchPrefix, deliveryPath, filedPath, stampedPath, signal,
  } = options;

  if (!scratchPrefix.endsWith('/')) throw new SigningPipelineError('A scratch prefix must end with "/".');

  const prepared = openGcsPdfSource(source);
  let stampPlan = null;
  try {
    const index = await readDocumentIndex(prepared, signal);
    const pages = await resolvePages(prepared, index, signal);
    stampPlan = fields.length === 0 && options.allowUnstampedSource
      ? null
      : await planStamps(prepared, index, pages, fields, signal);
    // With no plan, the browser already placed the freehand marks. The pipeline
    // still seals those exact bytes and appends the certificate.
    if (stampPlan && stampPlan.failures.length > 0) {
      // Nothing is published. A field that cannot be placed means the executed
      // document would be missing a mark the signer agreed to, and a signature
      // over that document is a signature on something else.
      return { stamped: source, failures: stampPlan.failures, delivery: null, filed: null };
    }
  } finally {
    await prepared.close();
  }

  // ONE read of the prepared source, resumed from the saved state when there is
  // one. Everything after this point hashes only appended bytes.
  const preparedState = options.savedDigest ?? await streamSourceState(source, signal);

  // Source plus stamps, composed once. Both artifacts share this prefix byte
  // for byte, which is what lets one saved state serve both seals.
  const stamped = stampPlan
    ? await composeSuffix({
      base: source,
      suffix: stampPlan.update.suffix,
      destination: stampedPath,
      scratchPrefix,
      claimStillHeld: options.claimStillHeld,
    })
    : source;
  const stampedState = stampPlan
    ? await extendState(preparedState, source, stampPlan.update.suffix, stamped)
    : preparedState;

  const stampedSource = openGcsPdfSource(stamped);
  let delivery: SealedArtifact;
  let filed: SealedArtifact;
  try {
    const stampedIndex = await readDocumentIndex(stampedSource, signal);
    const stampedPages = await resolvePages(stampedSource, stampedIndex, signal);
    const previousXref = await readStartXref(stampedSource, signal);
    const xrefStyle = sourceXrefStyle(stampedIndex);

    // Delivery first, because the certificate states this copy's hash.
    delivery = await sealArtifact({
      base: stampedSource,
      state: stampedState,
      objects: (capacity: number) => signatureObjects({
        source: stampedSource,
        index: stampedIndex,
        page: stampedPages[0],
        firstObjectNumber: nextObjectNumber(stampedIndex),
        contentsCapacity: capacity,
        signal,
      }),
      previousXref,
      trailer: carryTrailer(stampedIndex),
      xrefStyle,
      identity,
      signingTime,
      destination: deliveryPath,
      scratchPrefix,
      claimStillHeld: options.claimStillHeld,
      signal,
    });

    const certificatePlan = await planCertificateContent({
      data: {
        ...certificate,
        documentPageCount: stampedPages.length,
        // The DELIVERED copy's hash. A page cannot state the hash of the file
        // that contains it, and a value that exists only inside this function is
        // one nobody holding any artifact could reproduce.
        deliveryDocumentHash: delivery.digestHex,
      },
      geometry: { width: 612, height: 792, margin: 54 },
      firstObjectNumber: nextObjectNumber(stampedIndex),
    });

    const appended = await planAppendedPages({
      source: stampedSource,
      index: stampedIndex,
      newPages: certificatePlan.pages.map((p) => p.dictionary),
      pageRefs: certificatePlan.pages.map((_, i) => numbered(certificatePlan.nextObjectNumber + i)),
      signal,
    });

    const afterPages = certificatePlan.nextObjectNumber + certificatePlan.pages.length;
    const certificateObjects: AppendedObject[] = [
      ...certificatePlan.pages.map((p) => p.content),
      ...appended.pages.map((p) => ({ ref: p.ref, value: p.dictionary })),
      { ref: appended.pagesRef, value: appended.pagesDictionary },
    ];

    filed = await sealArtifact({
      base: stampedSource,
      state: stampedState,
      objects: async (capacity: number) => [
        ...certificateObjects,
        ...await signatureObjects({
          source: stampedSource,
          index: stampedIndex,
          page: stampedPages[0],
          firstObjectNumber: afterPages,
          contentsCapacity: capacity,
          signal,
        }),
      ],
      previousXref,
      trailer: carryTrailer(stampedIndex),
      xrefStyle,
      identity,
      signingTime,
      destination: filedPath,
      scratchPrefix,
      claimStillHeld: options.claimStillHeld,
      signal,
    });
  } finally {
    await stampedSource.close();
  }

  return { stamped, delivery, filed, failures: [] };
}

/**
 * Whether the document index's trailer came from a cross-reference stream.
 *
 * An xref stream's dictionary always carries `/Type /XRef`. The reader stores
 * the stream's dictionary as the trailer for that revision, so this check is
 * reliable for the topmost (newest) revision, which is what the incremental
 * revision chains from. When the source uses streams, the incremental update
 * must also emit a stream; Apple CoreGraphics refuses a mixed chain and blanks
 * the original pages.
 */
function sourceXrefStyle(index: any): 'classic' | 'stream' {
  const type = index.trailer.entries.get('Type');
  return (type && typeof type === 'object' && type.kind === 'name' && type.value === 'XRef')
    ? 'stream'
    : 'classic';
}

/**
 * Place every field and describe the appended revision that draws them.
 *
 * Several fields on one page are chained: each `planAppearance` is given the
 * page the previous one produced, so the resource names cannot collide and the
 * content array keeps every stream. Planning them independently and merging
 * afterwards is where a second signature silently replaces the first.
 */
async function planStamps(
  source: any,
  index: any,
  pages: ResolvedPage[],
  fields: StampableField[],
  signal: AbortSignal,
) {
  const { placed, failures } = planFieldPlacements(fields, pages);
  if (failures.length > 0) return { failures, update: null as never };

  const byId = new Map(fields.map((f) => [f.id, f]));
  const pageState = new Map<number, ResolvedPage>();
  const objects: AppendedObject[] = [];
  let next = nextObjectNumber(index);

  for (const mark of placed) {
    const field = byId.get(mark.fieldId)!;
    const current = pageState.get(mark.pageIndex) ?? mark.page;

    const allocate = (): PdfRef => { const ref = numbered(next); next += 1; return ref; };
    const appearance = field.appearance(allocate, {
      width: mark.placement.width,
      height: mark.placement.height,
    });

    const formRef = allocate();
    const contentRef = allocate();

    const plan = planAppearance({
      page: current,
      placement: mark.placement,
      bbox: appearance.bbox,
      appearanceResources: appearance.resources,
      formRef,
      contentRef,
    });

    objects.push({
      ref: formRef,
      value: withEntries(plan.formDictionary, { Length: appearance.content.length }),
      streamBytes: appearance.content,
    });
    objects.push({
      ref: contentRef,
      value: dict({ Length: plan.invocation.length }),
      streamBytes: plan.invocation,
    });
    objects.push(...(appearance.objects || []));

    pageState.set(mark.pageIndex, {
      ...current,
      dictionary: plan.updatedPage,
      resources: plan.updatedPage.entries.get('Resources') as PdfDict,
    });
  }

  for (const [, page] of pageState) {
    objects.push({ ref: page.ref, value: page.dictionary });
  }

  if (objects.length === 0) {
    throw new SigningPipelineError('A completed session produced no marks to stamp.');
  }

  return {
    failures,
    update: buildIncrementalUpdate({
      baseSize: source.ref.sizeBytes,
      previousXrefOffset: await readStartXref(source, signal),
      objects,
      trailer: carryTrailer(index),
      xrefStyle: sourceXrefStyle(index),
    }),
  };
}

/**
 * The signature dictionary, its widget, the AcroForm and the catalog.
 *
 * The catalog and the page are COPIES with entries added, so everything the
 * document already carried survives. Rebuilding either from scratch is how an
 * executed document loses its outline, its language or its own annotations.
 */
/** Follow a reference, or hand back a value that is already direct. */
async function follow(source: any, index: any, value: any, signal: AbortSignal): Promise<PdfValue | undefined> {
  if (value && typeof value === 'object' && (value as any).kind === 'ref') {
    return getObject(source, index, (value as any).value, signal);
  }
  return value as PdfValue | undefined;
}

/** The value as a dictionary, or undefined when it is anything else. */
function asDict(value: PdfValue | undefined): PdfDict | undefined {
  return (value && typeof value === 'object' && (value as any).kind === 'dict')
    ? value as PdfDict
    : undefined;
}

async function signatureObjects(options: {
  source: any;
  index: any;
  page: ResolvedPage;
  firstObjectNumber: number;
  contentsCapacity: number;
  signal: AbortSignal;
}): Promise<AppendedObject[]> {
  const { source, index, page, firstObjectNumber, contentsCapacity, signal } = options;

  const sigRef = numbered(firstObjectNumber);
  const widgetRef = numbered(firstObjectNumber + 1);
  const acroFormRef = numbered(firstObjectNumber + 2);

  const rootRef = index.trailer.entries.get('Root');
  if (!rootRef || typeof rootRef !== 'object' || (rootRef as any).kind !== 'ref') {
    throw new SigningPipelineError('This document has no catalog reference.');
  }
  const catalog = await getObject(source, index, (rootRef as any).value, signal);
  if (!catalog || typeof catalog !== 'object' || (catalog as any).kind !== 'dict') {
    throw new SigningPipelineError('This document has no catalog.');
  }

  // The document's own form, if it still has one. Preparation flattens forms,
  // so most documents arrive here without one. A session recorded before the
  // admission boundary existed has no prepared source, so its upload is sealed
  // as it stands, form and all.
  //
  // The seal ADDS its field to that form. Replacing the form with one holding
  // only the seal empties the document's field list, and every field the signer
  // filled stops being a field. Nothing errors and the widgets are still drawn,
  // so the loss shows up only to something that enumerates fields, which is the
  // same failure this function's own comment warns about one level up.
  const existingForm = asDict(await follow(source, index, (catalog as PdfDict).entries.get('AcroForm'), signal));
  const existingFields = await follow(source, index, existingForm?.entries.get('Fields'), signal);
  const carriedFields = (existingFields && typeof existingFields === 'object'
    && (existingFields as any).kind === 'array')
    ? (existingFields as any).values
    : [];
  const existingFlags = Number(existingForm?.entries.get('SigFlags') ?? 0) || 0;

  const annots = page.dictionary.entries.get('Annots');
  const updatedAnnots: PdfValue = (annots && typeof annots === 'object' && (annots as any).kind === 'array')
    ? { kind: 'array', values: [...(annots as any).values, refValue(widgetRef)] }
    : { kind: 'array', values: [refValue(widgetRef)] };

  return [
    {
      ref: sigRef,
      signaturePlaceholder: { contentsCapacity },
      value: dict({
        Type: name('Sig'),
        Filter: name('Adobe.PPKLite'),
        SubFilter: name('adbe.pkcs7.detached'),
      }),
    },
    {
      ref: widgetRef,
      value: dict({
        Type: name('Annot'),
        Subtype: name('Widget'),
        FT: name('Sig'),
        // A zero-area rectangle: the seal is a document-level signature, not a
        // second visible mark on top of the one the signer already placed.
        Rect: { kind: 'array', values: [0, 0, 0, 0] },
        T: { kind: 'string', bytes: new Uint8Array(Buffer.from('ParalegixSeal')) },
        V: refValue(sigRef),
        P: refValue(page.ref),
        // Bit 2 is Hidden, bit 3 Print. Hidden alone would let a viewer omit it
        // from the field list, and a signature nobody can see listed reads as
        // no signature at all.
        F: 132,
      }),
    },
    {
      ref: acroFormRef,
      // A COPY of the form the document had, with this field added, for the same
      // reason the catalog and the page are copies. `/DR` and `/DA` are what
      // every field without its own falls back to, and `forms.ts` takes care to
      // carry them through a flatten; rebuilding the form here would throw them
      // away one step later.
      value: withEntries(existingForm ?? dict({}), {
        Fields: { kind: 'array', values: [...carriedFields, refValue(widgetRef)] },
        // Bit 1: this document contains a signature field. Bit 2: no change is
        // permitted that would invalidate it. Added to whatever the document
        // already declared rather than replacing it.
        SigFlags: existingFlags | 3,
      }),
    },
    { ref: page.ref, value: withEntries(page.dictionary, { Annots: updatedAnnots }) },
    { ref: (rootRef as any).value, value: withEntries(catalog as PdfDict, { AcroForm: refValue(acroFormRef) }) },
  ];
}

/**
 * Seal one artifact and store it, refusing to publish one that does not verify.
 *
 * The verification is not ceremony. A seal that is written but wrong produces a
 * document that opens, shows a signature and fails everywhere else, which is
 * worse than a failure because nobody finds out until it matters.
 */
async function sealArtifact(options: {
  base: any;
  state: SavedDigestState;
  /** Built per attempt, because the reserved area is part of the layout. */
  objects: (contentsCapacity: number) => Promise<AppendedObject[]>;
  previousXref: number;
  trailer: PdfDict;
  /** Matches the source's xref form so the chain stays uniform across viewers. */
  xrefStyle: 'classic' | 'stream';
  identity: SigningIdentity;
  signingTime?: Date;
  destination: string;
  scratchPrefix: string;
  claimStillHeld?: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<SealedArtifact> {
  let capacity = CONTENTS_CAPACITY;
  let sealed;
  for (;;) {
    const update = buildIncrementalUpdate({
      baseSize: options.base.ref.sizeBytes,
      previousXrefOffset: options.previousXref,
      objects: await options.objects(capacity),
      trailer: options.trailer,
      xrefStyle: options.xrefStyle,
    });

    try {
      // eslint-disable-next-line no-await-in-loop -- one attempt at a time
      sealed = await sealSuffix({
        source: options.base,
        update,
        identity: options.identity,
        signingTime: options.signingTime,
        savedDigest: options.state,
        signal: options.signal,
      });
      break;
    } catch (err: any) {
      if (err?.code !== 'PDF_SIGNATURE_TOO_LARGE' || capacity >= MAX_CONTENTS_CAPACITY) throw err;
      // The WHOLE suffix is rebuilt at the larger size, so every offset and the
      // digest come from the new layout. Widening the hole in place would leave
      // a signature describing byte positions that moved.
      capacity = Math.min(capacity * 2, MAX_CONTENTS_CAPACITY);
    }
  }

  const verified = verifySealedSuffix({
    sealed,
    baseSize: options.base.ref.sizeBytes,
    digestHex: sealed.signedDigestHex,
  });
  if (!verified.valid) {
    throw new SigningPipelineError(
      `The seal for ${options.destination} did not verify: ${verified.reason}`,
      'SIGNING_SEAL_INVALID',
    );
  }

  const ref = await composeSuffix({
    base: options.base.ref,
    suffix: sealed.suffix,
    destination: options.destination,
    scratchPrefix: options.scratchPrefix,
    claimStillHeld: options.claimStillHeld,
  });
  if (ref.sizeBytes !== sealed.totalSize) {
    // The composed object is not the length the seal was computed for, so the
    // ByteRange describes bytes that are not there.
    throw new SigningPipelineError(
      `${options.destination} landed at ${ref.sizeBytes} bytes and the seal covers ${sealed.totalSize}.`,
    );
  }

  return { ref, digestHex: sealed.artifactDigestHex, signedDigestHex: sealed.signedDigestHex };
}


/**
 * Clear a destination an ABANDONED attempt left behind, if this worker may.
 *
 * The destinations are create-only, which is what stops one worker replacing
 * bytes another has already published a reference to. On its own, though, that
 * turns an interrupted attempt into a permanent stall: finalization is a queued
 * job, everything between composing the first artifact and recording BOTH on
 * the session row is a window a crash or a scale-in can land in, and every
 * retry afterwards fails at the same destination. The signers have signed, the
 * artifacts exist, and the session can never publish.
 *
 * Nothing references those bytes: the session row is written only after both
 * artifacts verify, and a job whose row already names them never rebuilds. So
 * replacing them loses nothing, and the ONE condition is that this worker still
 * holds the job. A worker whose lease expired may be looking at an object the
 * worker that replaced it has already published.
 */
async function clearAbandoned(
  destination: string,
  claimStillHeld: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const storage = bucket();
  // A source generation that no longer matches fails with the same 412, and the
  // error does not say which happened, so the destination's existence is the
  // only discriminator available. The difference decides everything: a taken
  // destination is an abandoned attempt, a replaced source is a document that
  // changed underneath this one and must never be composed over.
  //
  // No test reaches the source half. Every caller reads the source before it
  // composes, so a replaced source fails at that read, well before here. The
  // check stands on that reasoning rather than on a test, and it is two lines
  // against deleting a document for the wrong reason.
  const [exists] = await storage.file(destination).exists();
  if (!exists) return false;
  if (!claimStillHeld || !(await claimStillHeld())) return false;
  await storage.file(destination).delete().catch(() => {});
  return true;
}

async function composeSuffix(options: {
  base: StoredPdf;
  suffix: Uint8Array;
  destination: string;
  scratchPrefix: string;
  claimStillHeld?: () => Promise<boolean>;
}): Promise<StoredPdf> {
  const storage = bucket();
  const suffixPath = `${options.scratchPrefix}${options.destination.split('/').pop()}.suffix`;
  await storage.file(suffixPath).save(Buffer.from(options.suffix), {
    resumable: false,
    metadata: { contentType: 'application/pdf' },
  });
  try {
    const [meta] = await storage.file(suffixPath).getMetadata();
    const parts = [
      { objectPath: options.base.objectPath, generation: options.base.generation },
      { objectPath: suffixPath, generation: String(meta.generation) },
    ];
    const compose = () => composeParts({
      parts,
      destination: options.destination,
      scratchPrefix: options.scratchPrefix,
    });

    try {
      return await compose();
    } catch (err: any) {
      if (!isPreconditionFailed(err)) throw err;
      if (!(await clearAbandoned(options.destination, options.claimStillHeld))) {
        throw new SigningPipelineError(
          `${options.destination} already exists and this worker may not replace it.`,
          'SIGNING_ARTIFACT_EXISTS',
        );
      }
      // Once. A second loser at the same destination is another worker that is
      // actively producing this artifact, and racing it is what create-only
      // exists to prevent.
      return await compose();
    }
  } finally {
    await storage.file(suffixPath).delete().catch(() => {});
  }
}

/** Resume a state over an appended suffix and save it against the composed object. */
async function extendState(
  state: SavedDigestState,
  base: StoredPdf,
  suffix: Uint8Array,
  composed: StoredPdf,
): Promise<SavedDigestState> {
  const digest = await resumeDigest(state, base);
  digest.update(suffix);
  return digest.save(composed);
}

/** The fallback: read the source once and build the state here. */
async function streamSourceState(source: StoredPdf, signal: AbortSignal): Promise<SavedDigestState> {
  console.warn(`[signing:pipeline] Rebuilding the digest for ${source.objectPath}: no saved state.`);
  const pdf = openGcsPdfSource(source);
  try {
    const digest = await createResumableDigest();
    for await (const chunk of pdf.stream(0, source.sizeBytes, signal)) digest.update(chunk);
    return digest.save(source);
  } finally {
    await pdf.close();
  }
}

/** Trailer entries an appended revision has to carry forward. */
function carryTrailer(index: any): PdfDict {
  const entries = new Map<string, PdfValue>();
  for (const key of ['Root', 'Info', 'ID', 'Size']) {
    const value = index.trailer.entries.get(key);
    if (value !== undefined) entries.set(key, value);
  }
  return { kind: 'dict', entries };
}
