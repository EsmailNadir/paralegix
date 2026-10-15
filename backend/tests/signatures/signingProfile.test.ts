/**
 * What this service will and will not sign, stated once.
 *
 * The limits used to be spread across whichever route happened to need one: a
 * byte cap in the upload validator, a page assumption in the layout code, a
 * nesting depth inside the lexer. Each was reasonable alone and together they
 * were not a policy. The template route enforced none of them, and "small
 * enough" was decided by byte length, which says nothing about what a document
 * costs to open: a 4 MB PDF of a deeply nested object graph is more expensive
 * than a 400 MB scan.
 *
 * Two things have to be true for the profile to be worth having, and both are
 * tested below. It has to report the limits the engine ACTUALLY enforces rather
 * than a copy that drifts. And no caller may admit a document above it.
 */
import crypto from 'crypto';
import { putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';
import { installRichBucket, resetRichBucket } from '../files/richBucket';

installRichBucket();

const {
  SIGNING_PROFILE, maxTotalPages, describeBytes,
} = require('../../src/modules/signatures/signingProfile');
const { admitStoredUpload } = require('../../src/modules/signatures/signingSources');
const reader = require('../../src/modules/signatures/pdf/reader');
const lexer = require('../../src/modules/signatures/pdf/lexer');
const filters = require('../../src/modules/signatures/pdf/filters');

let firm: Firm;
let owner: Actor;

function land(body: Buffer): string {
  const path = `signing-uploads/${firm.id}/${crypto.randomUUID()}/agreement.pdf`;
  putObject(path, { body, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });
  return path;
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('the profile describes what is enforced', () => {
  it('takes every engine limit from the engine, not from a copy', () => {
    // A restated number is a policy the code does not enforce, and nothing
    // notices when one of the two moves.
    expect(SIGNING_PROFILE.maxObjects).toBe(reader.MAX_XREF_ENTRIES);
    expect(SIGNING_PROFILE.maxRevisions).toBe(reader.MAX_REVISIONS);
    expect(SIGNING_PROFILE.maxNestingDepth).toBe(lexer.MAX_NESTING_DEPTH);
    expect(SIGNING_PROFILE.maxDecodedStreamBytes).toBe(filters.MAX_DECODED_BYTES);
    expect(SIGNING_PROFILE.maxEncodedStreamBytes).toBe(filters.MAX_ENCODED_BYTES);
  });

  it('admits the whole 1,000-page corpus with room for a certificate', () => {
    // The fixture corpus contains a 1,000-page document. Refusing it would mean
    // the corpus proves something the product does not do.
    expect(SIGNING_PROFILE.maxSourcePages).toBeGreaterThanOrEqual(1000);
    expect(SIGNING_PROFILE.maxCertificatePages).toBeGreaterThan(0);
    // Counted SEPARATELY from source pages: a source accepted at exactly the
    // total would fail at the end, and the user would be told their document is
    // too long by the system that made it longer.
    expect(maxTotalPages()).toBe(
      SIGNING_PROFILE.maxSourcePages + SIGNING_PROFILE.maxCertificatePages,
    );
  });

  it('describes a size the way a refusal has to say it', () => {
    expect(describeBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(describeBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
    expect(describeBytes(512 * 1024)).toBe('512 KB');
  });
});

describe('no caller may admit above the profile', () => {
  it('refuses a source over the byte ceiling even when the caller asks for more', () => {
    // A route that wants a LOOSER limit is asking to admit a document the rest
    // of the system is not sized for.
    return expect(admitStoredUpload({
      lawFirmId: firm.id,
      uploadedBy: owner.uid,
      objectPath: land(minimalPdfBytes({ padToBytes: SIGNING_PROFILE.maxSourceBytes + 1 })),
      maxSizeBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toMatchObject({ refusalCode: 'FILE_TOO_LARGE' });
  });

  it('applies the profile when the caller names no limit at all', async () => {
    // The template route used to enforce nothing, which is how an encrypted
    // PDF reached a signer who had already been invited.
    const source = await admitStoredUpload({
      lawFirmId: firm.id,
      uploadedBy: owner.uid,
      objectPath: land(minimalPdfBytes()),
    });

    expect(source.profileVersion).toBe(SIGNING_PROFILE.version);
  });

  it('refuses a document with more pages than the source ceiling', async () => {
    const tight = SIGNING_PROFILE.maxSourcePages;
    SIGNING_PROFILE.maxSourcePages = 2;
    try {
      await expect(admitStoredUpload({
        lawFirmId: firm.id,
        uploadedBy: owner.uid,
        objectPath: land(minimalPdfBytes({ pages: 3 })),
      })).rejects.toMatchObject({ refusalCode: 'PDF_RESOURCE_LIMIT' });
    } finally {
      SIGNING_PROFILE.maxSourcePages = tight;
    }
  });
});

describe('the image limits the profile advertises', () => {
  it('are exactly the limits the submit route enforces', () => {
    // One policy, one number. The profile said 512 KiB and 40M pixels while the
    // route refused past 128 KiB and 4M, and the appearance engine read the
    // profile, so the two halves of one completion applied different limits.
    const { SIGNING_PROFILE: profile } = require('../../src/modules/signatures/signingProfile');
    const values = require('../../src/modules/signatures/signingFieldValues');
    expect(values.SIGNING_IMAGE_MAX_BYTES).toBeGreaterThan(0);
    expect(profile.maxSignatureImageBytes).toBe(values.SIGNING_IMAGE_MAX_BYTES);
    expect(profile.maxSignatureImageBytesTotal).toBe(values.SIGNING_IMAGE_TOTAL_MAX_BYTES);
    expect(profile.maxImagePixels).toBe(values.SIGNING_IMAGE_MAX_PIXELS);
  });
});
