/**
 * Sealing a document without ever holding it.
 *
 * A signed PDF is an ordinary incremental update with one peculiarity: two of
 * its fields cannot move. `/ByteRange` says which bytes the signature covers,
 * and `/Contents` is the hole those bytes skip. Both are written at a fixed
 * width before anything is hashed, because patching a field that changes width
 * moves every byte after it, and the signature then describes a file that does
 * not exist.
 *
 * The failure this file exists to catch is not a crash. It is a document that
 * opens in a viewer, shows a signature, and verifies nowhere. That looks
 * identical to a correct one from inside this codebase, so the checks that
 * matter are the ones done from outside it: the digest is recomputed with Node's
 * own SHA-256 over the composed bytes, the signature is verified by the OpenSSL
 * binary, and the composed file is parsed by pdf-lib. Then one covered byte is
 * changed, and all of it has to fail.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import { sealSuffix, verifySealedSuffix, readSealedSignature, PdfSealError } from '../../../src/modules/signatures/pdf/seal';
import { createResumableDigest, SourceChangedError } from '../../../src/modules/signatures/pdf/resumableDigest';
import type { SavedDigestState } from '../../../src/modules/signatures/pdf/resumableDigest';
import { readDocumentIndex, getObject } from '../../../src/modules/signatures/pdf/reader';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number, g = 0): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: g } });
const array = (values: PdfValue[]): PdfValue => ({ kind: 'array', values });

function sourceOver(bytes: Buffer, generation = '1'): PdfSource {
  return {
    ref: { objectPath: 'firm/base.pdf', generation, sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) {
      // Deliberately more than one chunk. A digest that only ever sees whole
      // ranges would not catch a boundary defect.
      for (let at = start; at < endExclusive; at += 64) {
        yield new Uint8Array(bytes.subarray(at, Math.min(at + 64, endExclusive)));
      }
    },
    async close() {},
  };
}

/** A minimal one-page document, plus where its cross-reference starts. */
function baseDocument() {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  const objects: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R /Lang (en-US) >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
    [4, '<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Retainer agreement) Tj ET\nendstream'],
  ];
  for (const [n, body] of objects) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 5\n0000000000 65535 f \n';
  for (let n = 1; n <= 4; n += 1) out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: Buffer.from(out, 'latin1'), xrefAt };
}

const CAPACITY = 8192;

/**
 * The appended revision a signature needs: the signature dictionary itself, a
 * widget that shows it on the page, the page carrying that widget, an AcroForm
 * listing the field, and a catalog pointing at the AcroForm.
 *
 * The catalog and page are COPIES with entries added. `/Lang` on the catalog
 * and `/Contents` on the page are unrelated to signing and have to survive.
 */
function signingUpdate(base: ReturnType<typeof baseDocument>, capacity = CAPACITY) {
  return buildIncrementalUpdate({
    baseSize: base.bytes.length,
    previousXrefOffset: base.xrefAt,
    trailer: dict({ Size: 5, Root: ref(1) }),
    objects: [
      {
        ref: { objectNumber: 5, generationNumber: 0 },
        signaturePlaceholder: { contentsCapacity: capacity },
        value: dict({
          Type: name('Sig'),
          Filter: name('Adobe.PPKLite'),
          SubFilter: name('adbe.pkcs7.detached'),
          Name: { kind: 'string', bytes: new Uint8Array(Buffer.from('Paralegix Test Signer')) },
        }),
      },
      {
        ref: { objectNumber: 6, generationNumber: 0 },
        value: dict({
          Type: name('Annot'),
          Subtype: name('Widget'),
          FT: name('Sig'),
          Rect: array([72, 96, 288, 144]),
          T: { kind: 'string', bytes: new Uint8Array(Buffer.from('Signature1')) },
          V: ref(5),
          P: ref(3),
          F: 132,
        }),
      },
      {
        ref: { objectNumber: 3, generationNumber: 0 },
        value: dict({
          Type: name('Page'), Parent: ref(2), Contents: ref(4), Annots: array([ref(6)]),
        }),
      },
      {
        ref: { objectNumber: 7, generationNumber: 0 },
        value: dict({ Fields: array([ref(6)]), SigFlags: 3 }),
      },
      {
        ref: { objectNumber: 1, generationNumber: 0 },
        value: dict({
          Type: name('Catalog'),
          Pages: ref(2),
          Lang: { kind: 'string', bytes: new Uint8Array(Buffer.from('en-US')) },
          AcroForm: ref(7),
        }),
      },
    ],
  });
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

/** The state preparation would have left behind for this base. */
async function savedStateFor(source: PdfSource, bytes: Buffer): Promise<SavedDigestState> {
  const digest = await createResumableDigest();
  digest.update(bytes);
  return digest.save(source.ref);
}

/** Base plus sealed suffix, which is what the storage service composes. */
function compose(base: Buffer, suffix: Uint8Array): Buffer {
  return Buffer.concat([base, Buffer.from(suffix)]);
}

/** The bytes the /ByteRange says are covered, taken from the composed file. */
function coveredBytes(composed: Buffer, byteRange: number[]): Buffer {
  return Buffer.concat([
    composed.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    composed.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);
}

async function seal(options: { saved?: SavedDigestState | null; generation?: string } = {}) {
  const base = baseDocument();
  const source = sourceOver(base.bytes, options.generation);
  const update = signingUpdate(base);
  const sealed = await sealSuffix({
    source,
    update,
    identity,
    signingTime: new Date('2026-09-09T12:00:00Z'),
    savedDigest: options.saved ?? null,
    signal,
  });
  return { base, source, update, sealed, composed: compose(base.bytes, sealed.suffix) };
}

describe('what a verifier sees', () => {
  it('signs a digest that Node computes independently over the composed file', async () => {
    // The check that matters. Everything else in this codebase agrees with
    // itself by construction; this asks a different implementation, over the
    // bytes that were actually produced, whether the signed digest is right.
    const { sealed, composed } = await seal();

    const independent = crypto.createHash('sha256')
      .update(coveredBytes(composed, sealed.byteRange))
      .digest('hex');

    expect(independent).toBe(sealed.signedDigestHex);
  });

  it('leaves the base byte for byte unchanged', async () => {
    const { base, composed } = await seal();

    expect(composed.subarray(0, base.bytes.length).equals(base.bytes)).toBe(true);
  });

  it('covers every byte except the /Contents token', async () => {
    const { sealed, composed } = await seal();
    const [start, firstLength, secondStart, secondLength] = sealed.byteRange;

    expect(start).toBe(0);
    expect(secondStart - firstLength).toBe(sealed.area.contentsLength);
    expect(secondStart + secondLength).toBe(composed.length);
    // The skipped span is exactly the hex string, angle brackets included.
    expect(composed[firstLength]).toBe('<'.charCodeAt(0));
    expect(composed[secondStart - 1]).toBe('>'.charCodeAt(0));
  });

  it('verifies with the OpenSSL binary, which shares no code with this', async () => {
    const { sealed, composed } = await seal();
    const { cms } = readSealedSignature(sealed.suffix, sealed.area, composed.length - sealed.suffix.length);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralegix-seal-'));
    try {
      fs.writeFileSync(path.join(dir, 'sig.der'), Buffer.from(cms));
      fs.writeFileSync(path.join(dir, 'content.bin'), coveredBytes(composed, sealed.byteRange));

      // `-noverify` skips the certificate CHAIN, which is self-signed here. The
      // signature itself and the message digest are still checked, which is the
      // whole point.
      const run = () => execFileSync('openssl', [
        'cms', '-verify', '-inform', 'DER',
        '-in', path.join(dir, 'sig.der'),
        '-content', path.join(dir, 'content.bin'),
        '-binary', '-noverify', '-out', path.join(dir, 'out.bin'),
      ], { stdio: 'pipe' });

      expect(run).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FAILS in OpenSSL when one covered byte changes', async () => {
    // Without this, the test above proves only that a CMS structure exists.
    const { sealed, composed } = await seal();
    const { cms } = readSealedSignature(sealed.suffix, sealed.area, composed.length - sealed.suffix.length);

    const altered = Buffer.from(composed);
    altered[200] ^= 0x01;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralegix-seal-'));
    try {
      fs.writeFileSync(path.join(dir, 'sig.der'), Buffer.from(cms));
      fs.writeFileSync(path.join(dir, 'content.bin'), coveredBytes(altered, sealed.byteRange));

      expect(() => execFileSync('openssl', [
        'cms', '-verify', '-inform', 'DER',
        '-in', path.join(dir, 'sig.der'),
        '-content', path.join(dir, 'content.bin'),
        '-binary', '-noverify', '-out', path.join(dir, 'out.bin'),
      ], { stdio: 'pipe' })).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses in pdf-lib, which shares no code with this reader', async () => {
    const { composed } = await seal();
    const { PDFDocument } = require('pdf-lib');

    const document = await PDFDocument.load(composed, { updateMetadata: false });

    expect(document.getPageCount()).toBe(1);
  });
});

describe('reading the sealed revision back', () => {
  it('reads the signature dictionary through the appended cross-reference', async () => {
    const { sealed, composed } = await seal();
    const source = sourceOver(composed);

    const index = await readDocumentIndex(source, signal);
    const signature = await getObject(source, index, { objectNumber: 5, generationNumber: 0 }, signal) as PdfDict;

    expect((signature.entries.get('SubFilter') as any).value).toBe('adbe.pkcs7.detached');
    expect(signature.entries.has('Contents')).toBe(true);
    expect(signature.entries.has('ByteRange')).toBe(true);
  });

  it('keeps the catalog entries that have nothing to do with signing', async () => {
    const { composed } = await seal();
    const source = sourceOver(composed);

    const index = await readDocumentIndex(source, signal);
    const catalog = await getObject(source, index, { objectNumber: 1, generationNumber: 0 }, signal) as PdfDict;

    expect(Buffer.from((catalog.entries.get('Lang') as any).bytes).toString()).toBe('en-US');
    expect(catalog.entries.has('AcroForm')).toBe(true);
  });

  it('reads back the /ByteRange the seal reported', async () => {
    const { base, sealed } = await seal();

    const { byteRange } = readSealedSignature(sealed.suffix, sealed.area, base.bytes.length);

    expect(byteRange).toEqual(sealed.byteRange);
  });

  it('accepts its own sealed suffix', async () => {
    const { base, sealed } = await seal();

    const result = verifySealedSuffix({
      sealed, baseSize: base.bytes.length, digestHex: sealed.signedDigestHex,
    });

    expect(result.valid).toBe(true);
    expect(result.signerCommonName).toBe('Paralegix Test Signer');
  });

  it('REJECTS its own sealed suffix against the digest of an altered file', async () => {
    const { base, sealed, composed } = await seal();
    const altered = Buffer.from(composed);
    altered[200] ^= 0x01;
    const alteredDigest = crypto.createHash('sha256')
      .update(coveredBytes(altered, sealed.byteRange)).digest('hex');

    const result = verifySealedSuffix({ sealed, baseSize: base.bytes.length, digestHex: alteredDigest });

    expect(result.valid).toBe(false);
  });
});

describe('resuming a saved digest', () => {
  it('produces the same bytes whether it resumed or re-read the source', async () => {
    // The fallback is not a degraded mode. A first signature always takes it,
    // so it has to produce a byte-identical result.
    const base = baseDocument();
    const source = sourceOver(base.bytes);
    const saved = await savedStateFor(source, base.bytes);

    const fromScratch = await seal({ saved: null });
    const fromState = await seal({ saved });

    expect(fromState.sealed.signedDigestHex).toBe(fromScratch.sealed.signedDigestHex);
    expect(fromState.sealed.artifactDigestHex).toBe(fromScratch.sealed.artifactDigestHex);
    expect(Buffer.from(fromState.sealed.suffix).equals(Buffer.from(fromScratch.sealed.suffix))).toBe(true);
    expect(fromState.sealed.resumed).toBe(true);
    expect(fromScratch.sealed.resumed).toBe(false);
  });

  it('digests the whole artifact including the hole, separately from what it signs', async () => {
    const { sealed, composed } = await seal();

    expect(sealed.artifactDigestHex)
      .toBe(crypto.createHash('sha256').update(composed).digest('hex'));
    expect(sealed.artifactDigestHex).not.toBe(sealed.signedDigestHex);
  });

  it('refuses a state saved against another generation of the same object', async () => {
    // The state names the same path and the same length, so only the generation
    // separates a correct resume from one that digests a mixture of two files.
    const base = baseDocument();
    const saved = await savedStateFor(sourceOver(base.bytes, '1'), base.bytes);

    await expect(seal({ saved, generation: '2' })).rejects.toThrow(SourceChangedError);
  });

  it('falls back rather than failing when the saved state is unreadable', async () => {
    const base = baseDocument();
    const source = sourceOver(base.bytes);
    const saved = await savedStateFor(source, base.bytes);
    const corrupt = { ...saved, version: 'sha256:hash-wasm@3' };

    const sealed = await seal({ saved: corrupt });

    expect(sealed.sealed.resumed).toBe(false);
    expect(sealed.sealed.signedDigestHex).toBe(
      crypto.createHash('sha256').update(coveredBytes(sealed.composed, sealed.sealed.byteRange)).digest('hex'),
    );
  });
});

describe('refusing to seal', () => {
  it('refuses an update that reserved no signature area', async () => {
    const base = baseDocument();
    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      trailer: dict({ Size: 5, Root: ref(1) }),
      objects: [{ ref: { objectNumber: 5, generationNumber: 0 }, value: dict({ Type: name('Sig') }) }],
    });

    await expect(sealSuffix({ source: sourceOver(base.bytes), update, identity, signal }))
      .rejects.toThrow(PdfSealError);
  });

  it('refuses an update built against a different base length', async () => {
    // Every absolute offset in the suffix would be wrong by the difference, and
    // the document would still open.
    const base = baseDocument();
    const update = signingUpdate(base);
    const shorter = sourceOver(base.bytes.subarray(0, base.bytes.length - 10));

    await expect(sealSuffix({ source: shorter, update, identity, signal }))
      .rejects.toThrow(/built for a base of/);
  });

  it('refuses a signature larger than the reservation instead of truncating it', async () => {
    const base = baseDocument();
    const update = signingUpdate(base, 1024);

    await expect(sealSuffix({ source: sourceOver(base.bytes), update, identity, signal }))
      .rejects.toThrow(/reserved space/);
  });
});
