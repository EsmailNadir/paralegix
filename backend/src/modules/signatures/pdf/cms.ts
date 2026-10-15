/**
 * Building and checking the CMS blob that IS the signature.
 *
 * A PDF signature's `/Contents` holds a detached CMS (PKCS#7) structure: the
 * certificate chain, the signing time, and a signature over a digest of the
 * document. "Detached" means the document bytes are not inside it, which is what
 * lets a 2 GB file be signed by something a few kilobytes long.
 *
 * The one thing that makes this different from ordinary signing code is that the
 * digest arrives ALREADY COMPUTED, as a hex string from the streamed hash. The
 * bytes were never held, so they cannot be handed to a signing library that
 * expects content. Everything here works from the digest.
 *
 * `verifyDetachedSignature` exists because a signature that cannot be checked is
 * indistinguishable from one that is wrong. It is used in tests and at
 * finalize: sealing and then failing to verify is caught here rather than by a
 * client months later.
 */
import crypto from 'crypto';
import { AppError } from '../../../shared/errors/AppError';

export class PdfSignatureError extends AppError {
  constructor(message: string, code = 'PDF_SIGNATURE_ERROR') {
    super(message, 400, code);
  }
}

export interface SigningIdentity {
  /** PEM certificate chain, signer first. */
  certificatePem: string;
  /** PEM private key matching the first certificate. */
  privateKeyPem: string;
}

/**
 * A detached CMS signature over an already-computed digest.
 *
 * `node-forge` is used rather than `@signpdf`, because every `@signpdf` entry
 * point takes the PDF bytes and computes the digest itself. That is the exact
 * thing this design cannot do: the document was never in memory.
 */
export function signDigest(options: {
  /** Lowercase hex SHA-256 of the ByteRange. */
  digestHex: string;
  identity: SigningIdentity;
  signingTime?: Date;
}): Uint8Array {
  const { digestHex, identity, signingTime = new Date() } = options;

  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new PdfSignatureError('A SHA-256 digest must be 64 lowercase hex characters.');
  }

  // Required at call time rather than at module load: `node-forge` is large, and
  // most requests never sign anything.
  const forge = require('node-forge');

  let certificate;
  let privateKey;
  try {
    certificate = forge.pki.certificateFromPem(identity.certificatePem);
    privateKey = forge.pki.privateKeyFromPem(identity.privateKeyPem);
  } catch (err: any) {
    throw new PdfSignatureError(`The signing identity could not be read: ${err.message}`, 'PDF_IDENTITY_INVALID');
  }

  // The certificate and key have to belong together. Signing with a mismatched
  // pair produces a structure that looks right and fails every verification.
  const probe = crypto.randomBytes(32);
  const check = crypto.createSign('sha256').update(probe).sign(identity.privateKeyPem);
  const matches = crypto.createVerify('sha256').update(probe)
    .verify(forge.pki.certificateToPem(certificate), check);
  if (!matches) {
    throw new PdfSignatureError(
      'The signing key does not match the certificate.',
      'PDF_IDENTITY_MISMATCH',
    );
  }

  const p7 = forge.pkcs7.createSignedData();
  // DETACHED: the document bytes are deliberately absent, which is what keeps
  // the signature a few kilobytes whatever the document weighs. An empty
  // OCTETSTRING satisfies forge's "there is something to sign" check; the real
  // content is described by the digest below, not carried here.
  p7.detachedContent = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, '',
  );
  p7.addCertificate(certificate);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.signingTime, value: signingTime },
      // Overwritten by forge from its own digest object, which is why that
      // object is replaced below.
      { type: forge.pki.oids.messageDigest },
    ],
  });

  // Forge computes the message digest by hashing the content it holds, and the
  // whole point here is that it holds none: the document was streamed through a
  // hash and never kept. Every forge entry point assumes otherwise.
  //
  // So the CONTENT digest is supplied. Forge creates exactly two digest objects
  // per signer, in a fixed order: the first is hashed over the content and
  // becomes the message-digest attribute, the second is hashed over the
  // authenticated attributes and is what actually gets signed. The first is
  // replaced with the precomputed value; the second must be a real SHA-256,
  // because substituting it would forge the signature rather than compute it.
  withSuppliedContentDigest(forge, digestHex, () => p7.sign({ detached: true }));
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return new Uint8Array(Buffer.from(der, 'binary'));
}

export interface VerificationResult {
  valid: boolean;
  /** Why it failed, when it did. Never a reason to treat it as valid. */
  reason?: string;
  signerCommonName?: string;
  signingTime?: Date;
}

/**
 * Check a detached CMS signature against a digest.
 *
 * Returns a result rather than throwing, because a caller usually wants to
 * report WHY a document does not verify. `valid` is the only field that decides
 * anything: a reason without `valid: false` is not a thing this can return.
 */
export function verifyDetachedSignature(options: {
  cms: Uint8Array;
  /** The digest the signature should cover. */
  digestHex: string;
}): VerificationResult {
  const forge = require('node-forge');
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(options.cms).toString('binary')));
    const message = forge.pkcs7.messageFromAsn1(asn1);

    // Read from `rawCapture` rather than `message.signers`: forge populates the
    // latter only when IT built the message, and a parsed one leaves it empty.
    // Reading the empty array would report every signature as "no signer",
    // which is a verifier that always fails and therefore proves nothing.
    const capture = message.rawCapture;
    const attributes = capture?.authenticatedAttributes;
    if (!attributes || attributes.length === 0) {
      return { valid: false, reason: 'The signature carries no authenticated attributes.' };
    }

    const found = readAttributes(forge, attributes);
    if (!found.messageDigest) {
      return { valid: false, reason: 'The signature carries no message digest.' };
    }
    if (found.messageDigest !== options.digestHex) {
      // The document changed, or this signature belongs to a different one.
      // Either way it does not cover these bytes.
      return { valid: false, reason: 'The signature does not cover this document.' };
    }

    const certificate = message.certificates?.[0];
    if (!certificate) return { valid: false, reason: 'The signature carries no certificate.' };

    // The digest attribute matching is NOT enough on its own: anyone can write
    // a digest into an unsigned structure. What makes this a signature is that
    // the attributes themselves are signed, so they are re-encoded and checked
    // against the certificate's key.
    //
    // They are transmitted under an implicit [0] tag and signed as a universal
    // SET, so the tag has to be restored before hashing or every verification
    // fails for the wrong reason.
    const signedSet = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attributes,
    );
    const digest = forge.md.sha256.create();
    digest.update(forge.asn1.toDer(signedSet).getBytes());

    const signatureValid = certificate.publicKey.verify(
      digest.digest().getBytes(),
      capture.signature,
    );
    if (!signatureValid) {
      return { valid: false, reason: 'The signature does not match its certificate.' };
    }

    return {
      valid: true,
      signerCommonName: certificate.subject?.getField('CN')?.value,
      signingTime: found.signingTime,
    };
  } catch (err: any) {
    return { valid: false, reason: `The signature could not be read: ${err.message}` };
  }
}

/** The two authenticated attributes this cares about, from their ASN.1. */
function readAttributes(forge: any, attributes: any[]) {
  let messageDigest: string | undefined;
  let signingTime: Date | undefined;

  for (const attribute of attributes) {
    const oid = forge.asn1.derToOid(attribute.value[0].value);
    const value = attribute.value[1]?.value?.[0];
    if (!value) continue;
    if (oid === forge.pki.oids.messageDigest) {
      messageDigest = Buffer.from(value.value, 'binary').toString('hex');
    } else if (oid === forge.pki.oids.signingTime) {
      signingTime = forge.asn1.utcTimeToDate
        ? tryDate(forge, value)
        : undefined;
    }
  }
  return { messageDigest, signingTime };
}

/** A signing time is UTCTime or GeneralizedTime depending on the year. */
function tryDate(forge: any, value: any): Date | undefined {
  try {
    return value.type === forge.asn1.Type.GENERALIZEDTIME
      ? forge.asn1.generalizedTimeToDate(value.value)
      : forge.asn1.utcTimeToDate(value.value);
  } catch {
    return undefined;
  }
}

/** Fit a signature into a reserved hole, or refuse. */
export function fitSignature(cms: Uint8Array, byteCapacity: number): string {
  if (cms.length > byteCapacity) {
    // Growing the hole would move every offset after it, so the digest would no
    // longer describe the file. The capacity has to be right before digesting.
    throw new PdfSignatureError(
      `The signature is ${cms.length} bytes and the reserved space is ${byteCapacity}.`,
      'PDF_SIGNATURE_TOO_LARGE',
    );
  }
  return Buffer.from(cms).toString('hex').padEnd(byteCapacity * 2, '0');
}

/**
 * Run `sign` with the content digest supplied rather than computed.
 *
 * Forge builds its digest objects through `forge.md.sha256.create()`, so that
 * factory is intercepted for the duration of the call. The FIRST object it asks
 * for is the content digest, which is the one this design cannot let it
 * compute; every one after that is a genuine SHA-256.
 *
 * The factory is restored in a finally. Leaving it patched would quietly change
 * every other hash in the process, including ones that decide authentication.
 */
function withSuppliedContentDigest<T>(forge: any, digestHex: string, run: () => T): T {
  const create = forge.md.sha256.create;
  let handedOut = 0;
  forge.md.sha256.create = (...args: unknown[]) => {
    const real = create.apply(forge.md.sha256, args);
    handedOut += 1;
    if (handedOut > 1) return real;
    // The content digest. It ALWAYS answers with the streamed value, whatever
    // forge feeds it: forge starts and updates this object over the (empty)
    // detached content before reading it, so falling through to the real hash
    // at that point would write the digest of nothing into the signature. Its
    // only consumer is the message-digest attribute.
    return {
      algorithm: real.algorithm,
      blockLength: real.blockLength,
      digestLength: real.digestLength,
      start() { return this; },
      update() { return this; },
      digest() { return forge.util.createBuffer(forge.util.hexToBytes(digestHex)); },
    };
  };
  try {
    return run();
  } finally {
    // Restored whatever happened. A patched hash factory left in place would
    // silently change every other digest in this process.
    forge.md.sha256.create = create;
  }
}
