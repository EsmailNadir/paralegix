/**
 * Preserved-record archive reads and writes - pure unit tests over a fake bucket.
 *
 * `tests/shared/recordArchive.test.js` pins where artifacts land. This pins what
 * happens when the bucket misbehaves, which is where a preserved record is
 * actually at risk.
 *
 * The distinction that matters: callers treat a null read as "nothing was ever
 * archived" and fall back to rebuilding, or to a copy the firm can edit. So a
 * transient read failure reported as null is not a degraded read, it is a
 * silent invitation to overwrite evidence with whatever the fallback produces.
 * A missing object and a failed read must not look the same.
 *
 * These hit no server and no real bucket. Run alone with:
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/recordArchiveIo.test.js
 */

const mockFile = {
  save: jest.fn(),
  download: jest.fn(),
};

jest.mock('../../src/shared/database/firebase', () => ({
  admin: {
    storage: () => ({
      bucket: () => ({ file: () => mockFile }),
    }),
  },
}));

const archive = require('../../src/shared/storage/recordArchive');

const PATH = 'lawfirmids/1354e5d3-1b94-46b2-b78d-0e04faece7d4/signatures/tok/signed-document.pdf';
const BYTES = Buffer.from('%PDF-1.7 executed');

function gcsError(code: any) {
  const err: any = new Error(`simulated ${code}`);
  err.code = code;
  return err;
}

beforeEach(() => {
  mockFile.save.mockReset();
  mockFile.download.mockReset();
});

describe('getArtifact', () => {
  test('returns the bytes when the object is there', async () => {
    mockFile.download.mockResolvedValue([BYTES]);
    expect(await archive.getArtifact(PATH)).toEqual(BYTES);
  });

  test('returns null when the object does not exist', async () => {
    // The genuine "this record predates the archive" case, which is the only one
    // a caller may answer by rebuilding or backfilling.
    mockFile.download.mockRejectedValue(gcsError(404));
    expect(await archive.getArtifact(PATH)).toBeNull();
  });

  test('THROWS when the read fails for any other reason', async () => {
    // The regression this guards: a 500/503/timeout used to be swallowed into
    // null, making a momentary outage indistinguishable from an empty archive.
    // Downstream that meant serving the mutable filed copy as the executed
    // document and then writing it over an archive that was fine all along.
    for (const code of [500, 503, 429, 'ECONNRESET']) {
      mockFile.download.mockRejectedValue(gcsError(code));
      await expect(archive.getArtifact(PATH)).rejects.toThrow(`simulated ${code}`);
    }
  });

  test('an empty object reads as nothing archived', async () => {
    mockFile.download.mockResolvedValue([Buffer.alloc(0)]);
    expect(await archive.getArtifact(PATH)).toBeNull();
  });

  test('no path reads as nothing rather than throwing', async () => {
    expect(await archive.getArtifact('')).toBeNull();
    expect(mockFile.download).not.toHaveBeenCalled();
  });
});

describe('putArtifact', () => {
  test('overwrites by default', async () => {
    mockFile.save.mockResolvedValue(undefined);
    expect(await archive.putArtifact(PATH, BYTES)).toBe(true);
    expect(mockFile.save.mock.calls[0][1].preconditionOpts).toBeUndefined();
  });

  test('overwrite:false makes the write create-only', async () => {
    mockFile.save.mockResolvedValue(undefined);
    expect(await archive.putArtifact(PATH, BYTES, {}, { overwrite: false })).toBe(true);
    expect(mockFile.save.mock.calls[0][1].preconditionOpts).toEqual({ ifGenerationMatch: 0 });
  });

  test('losing a create-only race reports success', async () => {
    // Another writer archived this record first. Their bytes ARE the record, and
    // the caller asked for an archived artifact at this path, which is what is
    // there. Reporting failure would send the caller off to "fix" it by
    // overwriting the very copy that won.
    for (const code of [412, 409]) {
      mockFile.save.mockRejectedValue(gcsError(code));
      expect(await archive.putArtifact(PATH, BYTES, {}, { overwrite: false })).toBe(true);
    }
  });

  test('a real write failure reports failure without throwing', async () => {
    // Archiving must never fail the operation that produced the bytes: the signer
    // has already signed and the invoice has already been emailed.
    mockFile.save.mockRejectedValue(gcsError(500));
    expect(await archive.putArtifact(PATH, BYTES, {}, { overwrite: false })).toBe(false);
    expect(await archive.putArtifact(PATH, BYTES)).toBe(false);
  });

  test('nothing to store is not an error', async () => {
    expect(await archive.putArtifact(PATH, null)).toBe(false);
    expect(await archive.putArtifact(PATH, Buffer.alloc(0))).toBe(false);
    expect(await archive.putArtifact('', BYTES)).toBe(false);
    expect(mockFile.save).not.toHaveBeenCalled();
  });
});

describe('signing artifacts are archived create-only', () => {
  // The executed PDF and its certificate are written once: at finalize, or by the
  // first read that finds the archive empty. A later rebuild must not replace
  // evidence someone may already have downloaded and cited.
  const signingArchive = require('../../src/modules/signatures/signingArchive');
  const FIRM = '1354e5d3-1b94-46b2-b78d-0e04faece7d4';
  const TOKEN = 'test-sess-3c77439e77370b64';

  test.each([
    ['signed document', (buf: any) => signingArchive.putSignedDocument(FIRM, TOKEN, buf)],
    ['certificate', (buf: any) => signingArchive.putCertificate(FIRM, TOKEN, buf)],
    ['delivered document', (buf: any) => signingArchive.putDeliveredDocument(FIRM, TOKEN, buf)],
  ])('%s write is create-only', async (_label, put) => {
    mockFile.save.mockResolvedValue(undefined);
    expect(await put(BYTES)).toBe(true);
    expect(mockFile.save.mock.calls[0][1].preconditionOpts).toEqual({ ifGenerationMatch: 0 });
  });

  test('the filed and delivered copies are separate artifacts', () => {
    // They are different bytes with different hashes: the filed copy carries the
    // certificate page, the delivered copy is what recipients hold. One
    // overwriting the other would destroy the only copy a recipient can verify.
    const filed = signingArchive.signingArchivePath(FIRM, TOKEN, signingArchive.SIGNED_DOCUMENT_ARTIFACT);
    const delivered = signingArchive.signingArchivePath(FIRM, TOKEN, signingArchive.DELIVERED_DOCUMENT_ARTIFACT);
    expect(filed).not.toBe(delivered);
    expect(delivered).toBe(`lawfirmids/${FIRM}/signatures/${TOKEN}/delivered-document.pdf`);
  });

  test('a failed archive read propagates instead of reading as unarchived', async () => {
    mockFile.download.mockRejectedValue(gcsError(503));
    await expect(signingArchive.getSignedDocument(FIRM, TOKEN)).rejects.toThrow('simulated 503');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
