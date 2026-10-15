const fs = require('fs');
const path = require('path');

// The signing cert and its passphrase come from the environment in prod (secret
// store / provisioned file), falling back to the in-repo dev cert with an empty
// passphrase so local dev keeps working.
//
// PRODUCTION REQUIREMENT: a real passphrase-protected cert MUST be provisioned
// out of band via SIGNING_P12_PATH (a secure, non-repo path) + P12_PASSPHRASE.
// When NODE_ENV === 'production' we FAIL FAST below if the passphrase is unset/
// empty or the cert is still the bundled in-repo dev cert, so prod can never
// silently seal documents with an empty-passphrase dev key. In dev/test the
// empty-passphrase repo cert fallback is allowed so local signing still works.
const DEFAULT_CERT_PATH = path.join(__dirname, '..', '..', '..', 'paralegix-signing.p12');
const CERT_PATH = process.env.SIGNING_P12_PATH
  ? path.resolve(process.env.SIGNING_P12_PATH)
  : DEFAULT_CERT_PATH;
const PASSPHRASE = process.env.P12_PASSPHRASE || '';

let cachedP12Buffer: Buffer | null = null;

// Fail fast in production rather than degrade to insecure signing. Evaluated at
// certificate load (and therefore at the first sign attempt / startup smoke
// check) so a misprovisioned prod deploy surfaces loudly instead of producing
// worthless seals. This guard is a no-op outside production.
function assertProductionCertConfig() {
  if (process.env.NODE_ENV !== 'production') return;

  if (!process.env.P12_PASSPHRASE || process.env.P12_PASSPHRASE.length === 0) {
    throw new Error(
      'P12_PASSPHRASE must be set in production: refusing to digitally sign with an empty passphrase. ' +
      'Provision a passphrase-protected signing cert via SIGNING_P12_PATH + P12_PASSPHRASE.'
    );
  }
  if (!process.env.SIGNING_P12_PATH || CERT_PATH === DEFAULT_CERT_PATH) {
    throw new Error(
      'SIGNING_P12_PATH must point to a securely provisioned signing certificate in production: ' +
      'refusing to use the bundled in-repo dev certificate.'
    );
  }
}

function loadCertificate(): Buffer {
  if (cachedP12Buffer) return cachedP12Buffer;

  assertProductionCertConfig();

  if (!fs.existsSync(CERT_PATH)) {
    throw new Error(
      `Signing certificate not found at ${CERT_PATH}. Set SIGNING_P12_PATH or run: npx tsx backend/scripts/generate-signing-cert.ts`
    );
  }

  cachedP12Buffer = fs.readFileSync(CERT_PATH) as Buffer;
  return cachedP12Buffer;
}

/**
 * The signing certificate and key as PEM, for the incremental seal.
 *
 * The same provisioning checks as `digitallySignPdf`: production refuses an
 * empty passphrase and refuses the bundled development certificate. This is
 * deliberately the only other way to reach the key, so a second signing path
 * cannot come with a second, weaker set of checks.
 *
 * `P12Signer` is not used here, and that is the point. Every `@signpdf` entry
 * point takes the whole PDF and hashes it, which is the one thing the
 * incremental design cannot do: the document was never in memory. This returns
 * the material and lets `pdf/cms.ts` sign a digest that was computed by
 * streaming.
 *
 * The parsed result is cached because the PKCS#12 key derivation is
 * deliberately slow, and a signing instance may seal many documents.
 */
let cachedIdentity: { certificatePem: string; privateKeyPem: string } | null = null;

export function signingIdentity(): { certificatePem: string; privateKeyPem: string } {
  if (cachedIdentity) return cachedIdentity;

  const forge = require('node-forge');
  const p12Buffer = loadCertificate();
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, PASSPHRASE);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
    forge.pki.oids.pkcs8ShroudedKeyBag
  ] || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];

  if (!certBags[0]?.cert || !keyBags[0]?.key) {
    throw new Error(`The signing certificate at ${CERT_PATH} carries no certificate and key pair.`);
  }

  cachedIdentity = {
    certificatePem: forge.pki.certificateToPem(certBags[0].cert),
    privateKeyPem: forge.pki.privateKeyToPem(keyBags[0].key),
  };
  return cachedIdentity;
}

/**
 * Embed a PKCS#7/CMS digital signature into a PDF buffer.
 * When opened in Adobe Reader, the document shows "Signed by Paralegix"
 * and any modification invalidates the signature.
 *
 * @param {Buffer} pdfBuffer - The PDF to sign (should already have the certificate page appended)
 * @returns {Promise<Buffer>} The digitally signed PDF buffer
 */
export async function digitallySignPdf(pdfBuffer: any) {
  const p12Buffer = loadCertificate();
  // Required here rather than at the top: pdf-lib and the @signpdf packages
  // (with node-forge behind the P12 signer) are megabytes once loaded, and only
  // this legacy sealing path uses them.
  const { PDFDocument } = require('pdf-lib');
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
  const { SignPdf } = require('@signpdf/signpdf');
  const { P12Signer } = require('@signpdf/signer-p12');

  // Load the PDF into pdf-lib to add the signature placeholder
  // ignoreEncryption: accept PDFs carrying permission-only encryption (no user password).
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  pdflibAddPlaceholder({
    pdfDoc,
    reason: 'Document digitally sealed by Paralegix',
    contactInfo: 'support@paralegix.com',
    name: 'Paralegix',
    location: 'Paralegix Platform',
    signatureLength: 8192,
    widgetRect: [0, 0, 0, 0], // Invisible signature
  });

  // Save PDF with placeholder
  const pdfWithPlaceholder = Buffer.from(await pdfDoc.save());

  // Create the signer and sign
  const signer = new P12Signer(p12Buffer, { passphrase: PASSPHRASE });
  const signPdf = new SignPdf();
  const signedPdf = await signPdf.sign(pdfWithPlaceholder, signer);

  return Buffer.from(signedPdf);
}
