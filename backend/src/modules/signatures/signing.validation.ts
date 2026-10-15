import { z } from 'zod';
const { pageParam, offsetParam } = require('../../shared/validation/listQuery');

/**
 * The most a JSON signing completion body may be, and the same number in bytes.
 *
 * The completion carries consent plus the signer's own field values, and a
 * signature value is a base64 PNG inside that JSON. Per-image and total image
 * caps (`signingFieldValues.ts`) bound what is inside; this bounds the envelope,
 * and it is the only one of the three that can be enforced WITHOUT holding the
 * body: `express.json` compares it against the declared length and refuses while
 * the request is still being read.
 *
 * One mebibyte is half the API's global default. It fits the 512 KiB total image
 * budget once base64 has inflated it by a third, plus the consent fields and any
 * text values, with roughly 200 KiB of slack. It is deliberately BELOW the
 * global default rather than above it: this is the most exposed unauthenticated
 * write in the product, so it is the last place that should be allowed a larger
 * body than everything else.
 */
export const SIGNING_COMPLETION_BODY_LIMIT = '1mb';
export const SIGNING_COMPLETION_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The most field values one completion may carry, and the longest a single
 * value may be as a string.
 *
 * A session's fields are laid out by a human in a browser, so a few dozen is a
 * busy document. The character cap is sized for a base64 image at the per-image
 * byte cap: anything past it is refused by the image caps with a message that
 * names the real problem, so this only catches values that are not images at
 * all.
 */
const SIGNING_MAX_FIELD_VALUES = 200;
const SIGNING_FIELD_VALUE_MAX_CHARS = 400_000;

/**
 * The most a non-image field value may hold.
 *
 * A field is a box on a page. The text fitter measures every glyph at every
 * size step while it shrinks the text into that box, so a value the box could
 * never show still costs a measurement per character inside the request that
 * finalizes. Five thousand characters is far more than any field displays.
 * Signature and initials values are PNG data urls and keep the larger JSON
 * bound above; the image caps below are what bound those.
 */
export const SIGNING_TEXT_VALUE_MAX_CHARS = 5_000;

/**
 * The most one signature or initials image may be, decoded.
 *
 * A signature is a stroke capture on a transparent canvas, which compresses to
 * tens of kilobytes at any realistic pad size; 128 KiB is several times that.
 * The number is a MEMORY bound rather than a quality one: the value arrives
 * base64 inside a JSON body, so the API holds the encoded string, the decoded
 * buffer and the decoded bitmap at once, on a 512 MiB container serving 80
 * concurrent requests. The signing profile and the appearance engine read this
 * constant, so the route and the stamp can never apply different limits.
 */
export const SIGNING_IMAGE_MAX_BYTES = 128 * 1024;

/**
 * The most all of one submission's images may be, added up.
 *
 * A per-image cap alone bounds nothing: a signer owning twenty fields could
 * send twenty images each one byte under the limit. A signer fills their own
 * fields only, and a turn with more than a handful of signature fields is
 * already unusual, so 512 KiB leaves room without letting the count multiply
 * the ceiling.
 */
export const SIGNING_IMAGE_TOTAL_MAX_BYTES = 512 * 1024;

/**
 * The most pixels one image may DECLARE.
 *
 * Bytes do not bound memory on their own: PNG is compressed, so a few hundred
 * bytes can announce a bitmap of hundreds of millions of pixels and cost
 * gigabytes the moment anything decodes it. Four million pixels decode to about
 * 16 MB at four bytes each. A 1600x600 signature pad is under a million.
 */
export const SIGNING_IMAGE_MAX_PIXELS = 4_000_000;

const signingFieldValueSchema = z.object({
  fieldId: z.string().min(1).max(200),
  value: z.union([
    z.string().max(SIGNING_FIELD_VALUE_MAX_CHARS),
    z.boolean(),
    z.number(),
  ]),
});

/**
 * POST /signing/:token/complete, sent as JSON.
 *
 * `consentAgreed` is a real boolean here, not the string the multipart schema
 * above has to transform. That distinction is the point of the type: a truthy
 * check accepts the string `"false"`, which is exactly what a browser sends for
 * a signer who declined, and the document would be executed for someone who
 * said no.
 *
 * `sourceRevision` is the fingerprint the signer's view carried, echoed back so
 * a sender edit made while the page was open is caught instead of applied.
 * `idempotencyKey` lets a retried submission be recognised as the same
 * submission rather than a second signature on a turn that is already over.
 */
export const completeSigningJsonSchema = z.object({
  consentAgreed: z
    .boolean({ message: 'You must agree to sign electronically' })
    .refine((value) => value === true, { message: 'You must agree to sign electronically' }),
  consentName: z.string().trim().min(1, 'Full legal name is required').max(200),
  consentTimestamp: z.string().min(1, 'Consent timestamp is required').max(100),
  sourceRevision: z.string().min(1, 'The document revision is required').max(200),
  idempotencyKey: z.string().min(8, 'An idempotency key is required').max(200),
  fieldValues: z.array(signingFieldValueSchema).max(SIGNING_MAX_FIELD_VALUES).default([]),
  /**
   * The object a FIELDLESS session uploaded its executed document to.
   *
   * Only that kind of session has one: its marks were drawn freehand in the
   * browser, so nothing on the server can reproduce them. Bounded here, and
   * checked against the session's own working prefix by the route, because the
   * path decides which bytes become an executed legal document.
   */
  signedObjectPath: z.string().min(1).max(1024).optional(),
});

/**
 * GET /signing/pending-for-client. The route answers account-wide, so `lawFirmId`
 * narrows it to one firm's waiting documents and the paging params window the
 * result. Omitting `limit` returns every waiting document, the same opt-in
 * contract the other paged reads use.
 */
export const pendingForClientQuerySchema = z.object({
  query: z.object({
    lawFirmId: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: offsetParam,
    page: pageParam,
  }),
});

/**
 * The most a document sent for signature may be. 500 MB.
 *
 * MEASURED, not chosen. The whole lifecycle (admission, flatten, resumable
 * digest, stamp, both seals) ran inside a 512 MiB container with swap disabled,
 * against real persisted bytes through a GCS-compatible endpoint, with
 * `scripts/run-signing-benchmark.sh`. What it showed:
 *
 *     size      process baseline   peak      SIGNING COSTS   bytes it read
 *     100 MiB   101 MiB            129 MiB   28 MiB          53,481 (7 ranges)
 *     500 MiB   102 MiB            134 MiB   32 MiB          53,481 (7 ranges)
 *
 * The baseline is what the process costs before any signing happens: the Node
 * runtime, the loaded application graph and V8's own heap. It is there whether
 * anything is being signed or not, so the column that matters is the third one,
 * and a five-fold increase in document size did not move it. The reads are
 * identical byte for byte, because the engine resolves the cross-reference
 * chain and the page it stamps through bounded windows and then APPENDS: it
 * never reads the document to seal it, and storage joins the parts server side.
 *
 * One heavy transfer runs per instance (`transferSlot.ts`), so a container
 * holds the baseline plus ONE of those working sets, not one per request.
 *
 * The old value was 20 MB, and it described the old implementation rather than
 * anything a law firm would recognise. That path ran five whole-document passes
 * through pdf-lib and peaked at 299 MB for a 20 MB document, 502 MB at 32 MB
 * and 858 MB at 48 MB, against the same 512 MiB container.
 *
 * WHY NOT HIGHER, given that memory does not move with size: 500 MiB is the
 * largest fixture the local harness can build. `fake-gcs-server` drops the
 * connection partway through a larger upload and cannot compose one either, so
 * a 2 GiB run measures the emulator rather than this code. The engine's own
 * ceiling is far above: `writer.ts` reserves a fixed-width `/ByteRange`, which
 * caps a sealable document at 10^10 - 1 bytes. Raising this past 500 MB means
 * producing a fixture some other way and running the same script, not editing
 * this constant.
 */
export const SIGNING_MAX_FILE_BYTES = 500 * 1024 * 1024;
export const SIGNING_MAX_FILE_LABEL = '500 MB';

/**
 * The largest non-PDF source accepted for conversion to PDF before signing.
 *
 * It depends on where the conversion runs, read per request because that is a
 * deploy setting (`DOCUMENT_CONVERTER`):
 *
 *   On the document worker, 100 MB, the converter's own ceiling. The API only
 *   signs storage URLs and never holds the file, and a 92 MB image-heavy DOCX
 *   converted there in 4.2 s at 564 of the worker's 1024 MiB.
 *
 *   Inside the API (any other value), 25 MB. The local adapter reads the whole
 *   source into a 512 MiB container that serves eighty requests at once, which
 *   is the allocation this cap was first set against.
 *
 * `SIGNING_UPLOAD_BUFFER_BYTES` overrides both. The converted output still faces
 * the signing source cap afterwards, so this bounds conversion input only.
 */
export function signingConversionCapBytes(): number {
  const configured = Number(process.env.SIGNING_UPLOAD_BUFFER_BYTES);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return process.env.DOCUMENT_CONVERTER === 'worker' ? 100 * 1024 * 1024 : 25 * 1024 * 1024;
}

/**
 * The refusal for a non-PDF source over that cap.
 *
 * It names the conversion as the reason, because the same document saved as a
 * PDF is accepted up to `SIGNING_MAX_FILE_LABEL`, and a plain "too large" reads
 * as a limit on signing itself.
 */
export function signingConversionTooLargeMessage(sizeBytes: number): string {
  const { formatBytes } = require('../../shared/utils/storageUsage');
  return `This file is ${formatBytes(sizeBytes)}. Word and other documents are converted to PDF before signing, `
    + `which works up to ${formatBytes(signingConversionCapBytes())}. `
    + `Save it as a PDF to send files up to ${SIGNING_MAX_FILE_LABEL}.`;
}

/**
 * The largest source whose preparation runs inside the finalize request.
 *
 * Preparation hashes the whole document. Doing that behind an interactive
 * request works while documents are small and stops working exactly when it
 * matters: the request times out, the caller sees a failure, and the work
 * carries on invisibly until the instance is killed. Past this the route
 * answers 202 with a job id and the client polls.
 *
 * Well under the 40 second interactive deadline at any realistic hash rate, and
 * deliberately independent of the source cap: raising what may be signed must
 * not silently move what is hashed while someone waits.
 */
export const SIGNING_INLINE_PREPARE_BYTES = Number(process.env.SIGNING_INLINE_PREPARE_BYTES)
  || 8 * 1024 * 1024;

/**
 * The largest source whose FINALIZE runs inside the last signer's request.
 *
 * Finalizing appends: the source is never read, so the work is the stamps, the
 * certificate and two signatures whatever the document weighs. What still grows
 * with the document is what happens AFTER the seals, above all the archive and
 * filing copies storage has to make. Those are server-side, but a very large
 * one takes long enough that holding the signer's request open for it turns a
 * successful signature into a timeout on their screen.
 *
 * Past this the completion answers 202 and the drain finishes the document. The
 * signer's consent is already committed either way, so nothing is lost by not
 * waiting; what changes is only whether they watch it happen.
 *
 * Deliberately separate from the preparation threshold and from the source cap:
 * these are three different waits, and moving one must not silently move the
 * others.
 */
export const SIGNING_INLINE_FINALIZE_BYTES = Number(process.env.SIGNING_INLINE_FINALIZE_BYTES)
  || 32 * 1024 * 1024;

/** POST /signing/upload-init. PDFs use this path; non-PDFs use convert-upload-init. */
export const signingUploadInitSchema = z.object({
  body: z.object({
    lawFirmId: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
    size: z.coerce.number().int().min(0),
    contentType: z.string().max(200).optional(),
  }),
});

/** POST /signing/upload-finalize. The path the init call handed back. */
export const signingUploadFinalizeSchema = z.object({
  body: z.object({
    lawFirmId: z.string().min(1).max(100),
    objectPath: z.string().min(1).max(1000),
  }),
});
