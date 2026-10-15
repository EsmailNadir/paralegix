/**
 * Signing archive paths - pure unit tests.
 *
 * The archive is what makes a completed signing session still answerable years
 * later: it holds the executed PDF and the Certificate of Completion outside the
 * firm's browsable document tree, where an ordinary file delete cannot reach them.
 *
 * What is asserted here is the SIGNING side of that: which artifacts a session
 * keeps and where they land. The shared placement rules and the guard that
 * protects every preserved record (including these paths) are pinned in
 * tests/shared/recordArchive.test.js.
 *
 * These hit no server and no bucket. Run alone with:
 *
 *   __TEST_TOKEN__=offline npx jest tests/signatures/signingArchive.test.js
 */

const signingArchive = require('../../src/modules/signatures/signingArchive');

const FIRM = '1354e5d3-1b94-46b2-b78d-0e04faece7d4';
const TOKEN = 'test-sess-3c77439e77370b64';

describe('signingArchivePath', () => {
  test('files both artifacts under the firm, then the session token', () => {
    // Two distinct paths: the executed document and its certificate answer
    // different questions and are produced at different moments, so one must
    // never overwrite the other. The token in each keeps sessions apart.
    expect(signingArchive.signingArchivePath(FIRM, TOKEN, signingArchive.CERTIFICATE_ARTIFACT))
      .toBe(`lawfirmids/${FIRM}/signatures/${TOKEN}/certificate-of-completion.pdf`);
    expect(signingArchive.signingArchivePath(FIRM, TOKEN, signingArchive.SIGNED_DOCUMENT_ARTIFACT))
      .toBe(`lawfirmids/${FIRM}/signatures/${TOKEN}/signed-document.pdf`);
  });

  test('every artifact sits under the session prefix', () => {
    const prefix = signingArchive.signingArchivePrefix(FIRM, TOKEN);
    for (const artifact of [signingArchive.CERTIFICATE_ARTIFACT, signingArchive.SIGNED_DOCUMENT_ARTIFACT]) {
      expect(signingArchive.signingArchivePath(FIRM, TOKEN, artifact).startsWith(prefix)).toBe(true);
    }
  });
});

describe('archive guards', () => {
  test('writing without a firm, a token or bytes stores nothing', async () => {
    // Returns false rather than throwing: the signer has already signed, so a
    // storage problem must not fail their request.
    const buf = Buffer.from('x');
    expect(await signingArchive.putCertificate(null, TOKEN, buf)).toBe(false);
    expect(await signingArchive.putCertificate(FIRM, null, buf)).toBe(false);
    expect(await signingArchive.putSignedDocument(FIRM, TOKEN, null)).toBe(false);
    expect(await signingArchive.putSignedDocument(FIRM, TOKEN, Buffer.alloc(0))).toBe(false);
  });

  test('reading without a firm or token yields nothing rather than throwing', async () => {
    expect(await signingArchive.getCertificate(null, TOKEN)).toBeNull();
    expect(await signingArchive.getSignedDocument(FIRM, null)).toBeNull();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
