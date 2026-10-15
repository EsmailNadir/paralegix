/**
 * The CMS blob that IS the signature.
 *
 * A PDF signature's `/Contents` holds a DETACHED CMS structure: certificates, a
 * signing time, and a signature over a digest. Detached means the document bytes
 * are not inside it, which is what lets a 2 GB file be signed by a few kilobytes.
 *
 * The thing that makes this different from ordinary signing code is that the
 * digest arrives already computed by the streamed hash. The bytes were never
 * held, so they cannot be handed to a library that expects content.
 *
 * The case that matters most is the negative one: change a covered byte and the
 * signature must fail. A signing path that cannot demonstrate that has proved
 * nothing, because a structure that merely EXISTS looks identical to one that is
 * correct.
 */
import crypto from 'crypto';
import {
  fitSignature,
  signDigest,
  verifyDetachedSignature,
  PdfSignatureError,
} from '../../../src/modules/signatures/pdf/cms';

/** A self-signed identity, generated once for the file. */
function makeIdentity() {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Paralegix Test Signer' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

let identity: ReturnType<typeof makeIdentity>;
beforeAll(() => { identity = makeIdentity(); });

const digestOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('signing a digest', () => {
  it('produces a signature that verifies against the same digest', () => {
    const digestHex = digestOf('the document');

    const cms = signDigest({ digestHex, identity });
    const result = verifyDetachedSignature({ cms, digestHex });

    expect(result.valid).toBe(true);
    // `valid` is the only field that decides anything, so a passing result
    // carries no reason a caller could mistake for a failure.
    expect(result.reason).toBeUndefined();
  });

  it('FAILS against a digest of altered bytes', () => {
    // The case that matters. A structure that merely exists looks identical to
    // one that is correct, so this is the only thing that separates them.
    const cms = signDigest({ digestHex: digestOf('the document'), identity });

    const result = verifyDetachedSignature({ cms, digestHex: digestOf('the documenT') });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not cover this document/i);
  });

  it('carries the signer and the signing time', () => {
    const digestHex = digestOf('x');
    const signingTime = new Date('2026-03-15T10:00:00Z');

    const result = verifyDetachedSignature({ cms: signDigest({ digestHex, identity, signingTime }), digestHex });

    expect(result.signerCommonName).toBe('Paralegix Test Signer');
    expect(result.signingTime?.toISOString()).toBe(signingTime.toISOString());
  });

  it('is small whatever the document weighs', () => {
    // Detached, so the content is absent. A signature that embedded the
    // document could not be produced for a file too large to hold.
    const cms = signDigest({ digestHex: digestOf('x'), identity });

    expect(cms.length).toBeLessThan(8192);
  });

  it('refuses a digest that is not a SHA-256 hex string', () => {
    expect(() => signDigest({ digestHex: 'not-a-digest', identity })).toThrow(PdfSignatureError);
    expect(() => signDigest({ digestHex: 'ABC', identity })).toThrow(/64 lowercase hex/i);
  });

  it('refuses a key that does not match the certificate', () => {
    // Signing with a mismatched pair produces a structure that looks right and
    // fails every verification, which is the worst way to find out.
    const other = makeIdentity();

    expect(() => signDigest({
      digestHex: digestOf('x'),
      identity: { certificatePem: identity.certificatePem, privateKeyPem: other.privateKeyPem },
    })).toThrow(/does not match the certificate/i);
  });

  it('refuses an unreadable identity', () => {
    expect(() => signDigest({
      digestHex: digestOf('x'),
      identity: { certificatePem: 'not a pem', privateKeyPem: identity.privateKeyPem },
    })).toThrow(/could not be read/i);
  });
});

describe('verifying', () => {
  it('reports a reason rather than throwing', () => {
    // A caller usually wants to say WHY a document does not verify.
    const result = verifyDetachedSignature({ cms: new Uint8Array([1, 2, 3]), digestHex: digestOf('x') });

    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

});

describe('the reserved hole', () => {
  it('pads a real signature out to the reservation', () => {
    // The hole is written before the signature exists, because the digest
    // cannot be computed until the offsets are final and the offsets depend on
    // the hole's size.
    const cms = signDigest({ digestHex: digestOf('x'), identity });

    const hex = fitSignature(cms, 8192);

    expect(hex).toHaveLength(16_384);
    expect(hex.startsWith(Buffer.from(cms).toString('hex'))).toBe(true);
  });

  it('refuses a signature larger than the reservation', () => {
    // Growing the hole would move every offset after it, so the digest would no
    // longer describe the file.
    const cms = signDigest({ digestHex: digestOf('x'), identity });

    expect(() => fitSignature(cms, 10)).toThrow(/reserved space/i);
  });
});
