/**
 * What this service will and will not sign, stated once and versioned.
 *
 * The limits used to be spread across the routes that happened to need them: a
 * byte cap in the upload validator, a page assumption in the layout code, a
 * nesting depth inside the lexer. Each was reasonable alone, and together they
 * were not a policy: the template route enforced none of them, and "small
 * enough" was decided by byte length, which says nothing about how much memory
 * a document costs to open. A 4 MB PDF of a single deeply nested object graph
 * is more expensive than a 400 MB scan.
 *
 * So the limits live here, as a numbered profile. The number is recorded on
 * every admitted source, which is what makes a change to these values safe: a
 * document admitted under version 1 is not silently treated as if it had passed
 * version 2's checks.
 *
 * The two page limits are separate on purpose. A source that is accepted at
 * exactly the page ceiling would otherwise fail at the end, when the service
 * appends its own certificate, and the user would be told their document is too
 * long by a system that made it longer.
 */

export interface SigningProfile {
  version: number;
  /** The largest source this service will admit. */
  maxSourceBytes: number;
  /** Pages in the SOURCE. The certificate's own pages are counted separately. */
  maxSourcePages: number;
  /** Pages the service may append on top of a source at the ceiling. */
  maxCertificatePages: number;
  /** Objects one document may declare, which is what the index budget allows. */
  maxObjects: number;
  /** Revisions in the cross-reference chain. */
  maxRevisions: number;
  /** Container nesting depth in the object graph. */
  maxNestingDepth: number;
  /** Decoded bytes one stream may produce, enforced DURING inflation. */
  maxDecodedStreamBytes: number;
  /** Encoded bytes one stream may hold before it is decoded. */
  maxEncodedStreamBytes: number;
  /** Pixels in one raster image, which bounds a decompression bomb. */
  maxImagePixels: number;
  /** Bytes of one signature or initials image a signer may submit. */
  maxSignatureImageBytes: number;
  /** Bytes of signature imagery across every field in one completion. */
  maxSignatureImageBytesTotal: number;
  /** The JSON body a completion may carry. */
  maxCompletionRequestBytes: number;
}

/**
 * The current profile.
 *
 * The values come from the engine's own ceilings rather than being restated, so
 * a change to one of those cannot leave this file describing a policy the code
 * does not enforce.
 */
export const SIGNING_PROFILE: SigningProfile = {
  version: 1,
  // READ from the cap rather than restated beside it. Two numbers for one
  // policy drift, and the one that drifted would decide silently.
  // eslint-disable-next-line global-require -- required lazily; validation reads this module back
  maxSourceBytes: Number(process.env.SIGNING_MAX_SOURCE_BYTES)
    || require('./signing.validation').SIGNING_MAX_FILE_BYTES,
  // The fixture corpus contains a 1,000-page document, which has to be
  // admitted: refusing it would mean the corpus proves something the product
  // does not do.
  maxSourcePages: Number(process.env.SIGNING_MAX_SOURCE_PAGES) || 2_000,
  maxCertificatePages: Number(process.env.SIGNING_MAX_CERTIFICATE_PAGES) || 20,
  maxObjects: 0,
  maxRevisions: 0,
  maxNestingDepth: 0,
  maxDecodedStreamBytes: 0,
  maxEncodedStreamBytes: 0,
  // The same three constants the submit route enforces. The appearance engine
  // reads these, so a profile that restated them could let a stamp accept an
  // image the route would have refused.
  /* eslint-disable global-require -- required lazily; validation reads this module back */
  maxImagePixels: require('./signing.validation').SIGNING_IMAGE_MAX_PIXELS,
  maxSignatureImageBytes: require('./signing.validation').SIGNING_IMAGE_MAX_BYTES,
  maxSignatureImageBytesTotal: require('./signing.validation').SIGNING_IMAGE_TOTAL_MAX_BYTES,
  /* eslint-enable global-require */
  maxCompletionRequestBytes: Number(process.env.SIGNING_MAX_COMPLETION_BYTES) || 8 * 1024 * 1024,
};

// Filled from the engine at load, so the profile reports the limits that are
// actually enforced rather than a copy of them that can drift.
{
  const reader = require('./pdf/reader');
  const lexer = require('./pdf/lexer');
  const filters = require('./pdf/filters');
  SIGNING_PROFILE.maxObjects = reader.MAX_XREF_ENTRIES;
  SIGNING_PROFILE.maxRevisions = reader.MAX_REVISIONS;
  SIGNING_PROFILE.maxNestingDepth = lexer.MAX_NESTING_DEPTH;
  SIGNING_PROFILE.maxDecodedStreamBytes = filters.MAX_DECODED_BYTES;
  SIGNING_PROFILE.maxEncodedStreamBytes = filters.MAX_ENCODED_BYTES;
}

/**
 * The total page count the writer may have to address, source plus certificate.
 *
 * Read this wherever the question is "can the finished document exist", and
 * `maxSourcePages` wherever it is "may we admit this upload".
 */
export function maxTotalPages(profile: SigningProfile = SIGNING_PROFILE): number {
  return profile.maxSourcePages + profile.maxCertificatePages;
}

/** A human-readable size, for the copy a refusal shows. */
export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
