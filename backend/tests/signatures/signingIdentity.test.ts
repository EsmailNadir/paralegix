/**
 * The provisioned signing certificate, as the incremental seal needs it.
 *
 * `digitallySignPdf` hands the PKCS#12 file to `P12Signer`, which takes the
 * whole PDF and hashes it. The incremental path cannot do that: the document
 * was never in memory. So the same file exposes the certificate and key as PEM
 * and lets `pdf/cms.ts` sign a digest computed by streaming.
 *
 * What has to break for these to go red: hand back a key that does not match
 * the certificate, or reach the key through a second path that skips the
 * production provisioning checks.
 */
import { signingIdentity } from '../../src/modules/signatures/digitalSign';
import { signDigest, verifyDetachedSignature } from '../../src/modules/signatures/pdf/cms';

const digestOf = (text: string) => require('crypto').createHash('sha256').update(text).digest('hex');

describe('the provisioned identity', () => {
  it('produces a certificate and key that belong together', () => {
    // A mismatched pair produces a structure that looks right and fails every
    // verification afterwards, which is why `signDigest` refuses one.
    const identity = signingIdentity();

    const cms = signDigest({ digestHex: digestOf('the document'), identity });

    expect(verifyDetachedSignature({ cms, digestHex: digestOf('the document') }).valid).toBe(true);
  });

  it('FAILS against a digest of different bytes', () => {
    const identity = signingIdentity();

    const cms = signDigest({ digestHex: digestOf('the document'), identity });

    expect(verifyDetachedSignature({ cms, digestHex: digestOf('the document.') }).valid).toBe(false);
  });

  it('caches the parsed material rather than deriving the key per document', () => {
    // PKCS#12 key derivation is deliberately slow. A signing instance may seal
    // many documents, and paying that on every one is the difference between a
    // seal costing milliseconds and costing hundreds of them.
    expect(signingIdentity()).toBe(signingIdentity());
  });

  it('refuses the bundled development certificate in production', () => {
    // The one check that matters here. Without it a misprovisioned deploy seals
    // real documents with a key that is in the repository, and every one of
    // those seals is worthless while looking correct.
    const previousEnv = process.env.NODE_ENV;
    const previousPath = process.env.SIGNING_P12_PATH;
    const previousPass = process.env.P12_PASSPHRASE;
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.SIGNING_P12_PATH;
    process.env.P12_PASSPHRASE = 'a-real-passphrase';
    try {
      const reloaded = require('../../src/modules/signatures/digitalSign');
      expect(() => reloaded.signingIdentity()).toThrow(/securely provisioned/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousPath === undefined) delete process.env.SIGNING_P12_PATH;
      else process.env.SIGNING_P12_PATH = previousPath;
      if (previousPass === undefined) delete process.env.P12_PASSPHRASE;
      else process.env.P12_PASSPHRASE = previousPass;
      jest.resetModules();
    }
  });

  it('names the missing certificate path and how to provision one when the file is absent', () => {
    // Outside production the provisioning checks are skipped, so a mistyped
    // SIGNING_P12_PATH reaches the file read itself. A bare ENOENT from
    // `readFileSync` names no setting and no remedy; this message names both.
    const missing = `/tmp/paralegix-no-such-cert-${process.pid}.p12`;
    const previousPath = process.env.SIGNING_P12_PATH;
    jest.resetModules();
    process.env.SIGNING_P12_PATH = missing;
    try {
      const reloaded = require('../../src/modules/signatures/digitalSign');
      expect(() => reloaded.signingIdentity()).toThrow(
        `Signing certificate not found at ${missing}. Set SIGNING_P12_PATH or run: npx tsx backend/scripts/generate-signing-cert.ts`,
      );
    } finally {
      if (previousPath === undefined) delete process.env.SIGNING_P12_PATH;
      else process.env.SIGNING_P12_PATH = previousPath;
      jest.resetModules();
    }
  });

  it('refuses an empty passphrase in production', () => {
    const previousEnv = process.env.NODE_ENV;
    const previousPass = process.env.P12_PASSPHRASE;
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.P12_PASSPHRASE = '';
    try {
      const reloaded = require('../../src/modules/signatures/digitalSign');
      expect(() => reloaded.signingIdentity()).toThrow(/P12_PASSPHRASE/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousPass === undefined) delete process.env.P12_PASSPHRASE;
      else process.env.P12_PASSPHRASE = previousPass;
      jest.resetModules();
    }
  });
});
