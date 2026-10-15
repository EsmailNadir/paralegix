/**
 * Checking a stored artifact's seal, without holding the artifact.
 *
 * The tests below verify documents this codebase produced, which on its own
 * proves only that the code agrees with itself. What makes them worth having is
 * the negative half: every case here names a document that must NOT verify, and
 * each of those is a document that looks signed.
 *
 * The one that matters most is coverage. A signature whose `/ByteRange` stops
 * short of the end of the file is mathematically valid over the bytes it
 * covers, and those are not the bytes anyone is reading: a revision appended
 * after signing sits outside the range and can say anything. A verifier that
 * checks the signature and not the coverage reports that document as signed.
 */
import crypto from 'crypto';
import { verifySealedArtifact } from '../../../src/modules/signatures/pdf/verifySeal';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import { sealSuffix } from '../../../src/modules/signatures/pdf/seal';
import { createResumableDigest } from '../../../src/modules/signatures/pdf/resumableDigest';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: 0 } });
const array = (values: PdfValue[]): PdfValue => ({ kind: 'array', values });

function sourceOver(bytes: Buffer): PdfSource {
  return {
    ref: { objectPath: 'artifact.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) {
      for (let at = start; at < endExclusive; at += 512) {
        yield new Uint8Array(bytes.subarray(at, Math.min(at + 512, endExclusive)));
      }
    },
    async close() {},
  };
}

function baseDocument() {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  const objects: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>'],
    [3, '<< /Type /Page /Parent 2 0 R >>'],
  ];
  for (const [n, body] of objects) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 4\n0000000000 65535 f \n';
  for (let n = 1; n <= 3; n += 1) out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: Buffer.from(out, 'latin1'), xrefAt };
}

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

/** Base plus a sealed revision carrying a signature field. */
async function sealedDocument() {
  const base = baseDocument();
  const source = sourceOver(base.bytes);
  const update = buildIncrementalUpdate({
    baseSize: base.bytes.length,
    previousXrefOffset: base.xrefAt,
    trailer: dict({ Size: 4, Root: ref(1) }),
    objects: [
      {
        ref: { objectNumber: 4, generationNumber: 0 },
        signaturePlaceholder: { contentsCapacity: 4096 },
        value: dict({
          Type: name('Sig'), Filter: name('Adobe.PPKLite'), SubFilter: name('adbe.pkcs7.detached'),
        }),
      },
      {
        ref: { objectNumber: 5, generationNumber: 0 },
        value: dict({
          Type: name('Annot'), Subtype: name('Widget'), FT: name('Sig'),
          Rect: array([0, 0, 0, 0]), V: ref(4), P: ref(3),
        }),
      },
      { ref: { objectNumber: 6, generationNumber: 0 }, value: dict({ Fields: array([ref(5)]), SigFlags: 3 }) },
      { ref: { objectNumber: 3, generationNumber: 0 }, value: dict({ Type: name('Page'), Parent: ref(2), Annots: array([ref(5)]) }) },
      { ref: { objectNumber: 1, generationNumber: 0 }, value: dict({ Type: name('Catalog'), Pages: ref(2), AcroForm: ref(6) }) },
    ],
  });

  const digest = await createResumableDigest();
  digest.update(base.bytes);
  const sealed = await sealSuffix({
    source, update, identity, savedDigest: digest.save(source.ref), signal,
  });

  return { base, sealed, composed: Buffer.concat([base.bytes, Buffer.from(sealed.suffix)]) };
}

describe('a document this service sealed', () => {
  it('verifies, and says who signed it', async () => {
    const { composed } = await sealedDocument();

    const result = await verifySealedArtifact(sourceOver(composed), signal);

    expect(result.sealed).toBe(true);
    expect(result.sealValid).toBe(true);
    expect(result.coversWholeFile).toBe(true);
    expect(result.signerCommonName).toBe('Paralegix Test Signer');
    expect(result.reason).toBeUndefined();
  });

  it('reports the digest the signature actually signs', async () => {
    // Which a caller can check independently, and which is not the artifact's
    // own hash: the signature cannot cover itself.
    const { composed, sealed } = await sealedDocument();

    const result = await verifySealedArtifact(sourceOver(composed), signal);

    expect(result.signedDigestHex).toBe(sealed.signedDigestHex);
    expect(result.signedDigestHex)
      .not.toBe(crypto.createHash('sha256').update(composed).digest('hex'));
  });
});

describe('documents that must NOT verify', () => {
  it('refuses one whose covered bytes were altered', async () => {
    const { composed } = await sealedDocument();
    const altered = Buffer.from(composed);
    altered[120] ^= 0x01;

    const result = await verifySealedArtifact(sourceOver(altered), signal);

    expect(result.sealed).toBe(true);
    expect(result.sealValid).toBe(false);
  });

  it('refuses one with a revision APPENDED after signing', async () => {
    // The case a signature check alone cannot catch. The seal is still
    // mathematically valid over the bytes it covers; those bytes are simply no
    // longer the document.
    const { composed } = await sealedDocument();
    const later = Buffer.concat([
      composed,
      Buffer.from('\n7 0 obj\n<< /Type /Page >>\nendobj\n', 'latin1'),
    ]);

    const result = await verifySealedArtifact(sourceOver(later), signal);

    expect(result.coversWholeFile).toBe(false);
    expect(result.sealValid).toBe(false);
    expect(result.reason).toMatch(/whole file/);
  });

  it('reports an UNSIGNED document as unsealed rather than as failing', async () => {
    // "Not signed" and "signed badly" are different answers, and collapsing
    // them is how an unsealed document gets described as tamper-evident because
    // its stored hash matched.
    const base = baseDocument();

    const result = await verifySealedArtifact(sourceOver(base.bytes), signal);

    expect(result.sealed).toBe(false);
    expect(result.sealValid).toBe(false);
    expect(result.reason).toMatch(/no signature/i);
  });

  it('refuses a /ByteRange that overlaps itself', async () => {
    // Overlapping spans hash some bytes twice, so the digest would cover a byte
    // sequence that does not exist in the file.
    const { composed } = await sealedDocument();
    const text = composed.toString('latin1');
    const at = text.indexOf('/ByteRange [');
    const broken = Buffer.from(composed);
    // Both spans start at zero, which the validator has to reject.
    broken.write('[ 0          40         20         40         ]', at + '/ByteRange '.length, 'latin1');

    const result = await verifySealedArtifact(sourceOver(broken), signal);

    expect(result.sealValid).toBe(false);
  });

  it('refuses a reserved area large enough to be an allocation request', async () => {
    const { composed } = await sealedDocument();
    const text = composed.toString('latin1');
    const at = text.indexOf('/ByteRange [');
    const broken = Buffer.from(composed);
    broken.write('[ 0          10         9000000    10         ]', at + '/ByteRange '.length, 'latin1');

    const result = await verifySealedArtifact(sourceOver(broken), signal);

    expect(result.sealValid).toBe(false);
  });

  it('refuses a truncated document rather than reporting what it can read', async () => {
    const { composed } = await sealedDocument();

    const result = await verifySealedArtifact(sourceOver(composed.subarray(0, 200)), signal);

    expect(result.sealValid).toBe(false);
  });
});
