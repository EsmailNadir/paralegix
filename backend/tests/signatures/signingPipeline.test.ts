/**
 * Producing the two executed artifacts without the document in memory.
 *
 * The old path ran five whole-document passes through pdf-lib. It peaked at
 * 299 MB for a 20 MB document and 858 MB for a 48 MB one against a 512 MiB
 * container, which is the entire reason the signing cap is 20 MB: a cap on the
 * implementation rather than on anything a law firm would recognise.
 *
 * Two claims have to be true for the replacement, and both are checked here
 * rather than asserted in prose. The artifacts have to be CORRECT, which is
 * proved from outside this codebase: Node's own SHA-256 over the composed
 * bytes, and the OpenSSL binary over the covered range. And the work has to be
 * BOUNDED, which is proved by counting the bytes actually read out of storage
 * and comparing that to the document's size.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import type { PdfDict, PdfValue, StoredPdf } from '../../src/modules/signatures/pdf/types';

/**
 * Bytes this double has handed out.
 *
 * The pipeline's central claim is that executing a document does not READ the
 * document. That claim is only testable if something counts: a test asserting
 * "it worked" passes just as well on a path that pulls the whole file five
 * times.
 */
let bytesHandedOut = 0;
const countingBucket = {
  ...inMemoryBucket,
  file: (path: string) => {
    const handle = inMemoryBucket.file(path) as any;
    return {
      ...handle,
      get metadata() { return handle.metadata; },
      download: async (options: any = {}) => {
        const [slice] = await handle.download(options);
        bytesHandedOut += slice.length;
        return [slice];
      },
      createReadStream: (options: any = {}) => {
        const { Readable } = require('stream');
        const stream = handle.createReadStream(options);
        const counted = new Readable({ read() {} });
        stream.on('data', (chunk: Buffer) => { bytesHandedOut += chunk.length; counted.push(chunk); });
        stream.on('end', () => counted.push(null));
        stream.on('error', (err: Error) => counted.destroy(err));
        return counted;
      },
    };
  },
};

jest.mock('../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => countingBucket }) },
}));

const bytesRead = () => bytesHandedOut;
const resetBytesRead = () => { bytesHandedOut = 0; };
const resetRichBucket = () => { objects.clear(); resetBytesRead(); };

const { runSigningPipeline } = require('../../src/modules/signatures/signingPipeline');
const { createResumableDigest } = require('../../src/modules/signatures/pdf/resumableDigest');
const { readSealedSignature } = require('../../src/modules/signatures/pdf/seal');
const { openGcsPdfSource } = require('../../src/modules/signatures/pdf/gcsSource');
const { getObject, readDocumentIndex } = require('../../src/modules/signatures/pdf/reader');
const { resolvePages } = require('../../src/modules/signatures/pdf/pages');

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });

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

/** A signature mark: the signer's name, drawn in Helvetica. */
function signatureField(over: Record<string, unknown> = {}) {
  const text = 'Jane Roe';
  const content = Buffer.from(`BT /F1 18 Tf 4 8 Td (${text}) Tj ET\n`, 'latin1');
  return {
    id: 'field-1',
    page: 1,
    xPercent: 10,
    yPercent: 70,
    widthPercent: 30,
    heightPercent: 6,
    appearance: () => ({
      content: new Uint8Array(content),
      bbox: { width: 180, height: 48 },
      // A DIRECT font dictionary, which is legal and needs no object number.
      resources: dict({
        Font: dict({
          F1: dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica') }),
        }),
      }),
    }),
    ...over,
  };
}

const SOURCE_PATH = 'signing-uploads/firm/src/prepared.pdf';

/** Put a prepared source in storage and return its reference. */
function storeSource(bytes: Buffer): StoredPdf {
  putObject(SOURCE_PATH, { body: bytes, contentType: 'application/pdf' });
  return {
    objectPath: SOURCE_PATH,
    generation: objects.get(SOURCE_PATH)!.generation,
    sizeBytes: bytes.length,
  };
}

async function savedStateFor(source: StoredPdf, bytes: Buffer) {
  const digest = await createResumableDigest();
  digest.update(bytes);
  return digest.save(source);
}

const PATHS = {
  scratchPrefix: 'signing-uploads/firm/scratch/',
  stampedPath: 'signing-uploads/firm/out/stamped.pdf',
  deliveryPath: 'signing-uploads/firm/out/delivery.pdf',
  filedPath: 'signing-uploads/firm/out/filed.pdf',
};

const CERTIFICATE = {
  documentTitle: 'Retainer Agreement',
  transactionId: 'txn-1',
  signerName: 'Jane Roe',
  signedAt: '2026-09-09T12:00:00.000Z',
  originalDocumentHash: 'abc123',
  signers: [{ name: 'Jane Roe', roleLabel: 'Client', completedAt: '2026-09-09T12:00:00.000Z' }],
};

async function run(over: Record<string, unknown> = {}) {
  const base = minimalPdf({ pages: 2 });
  const source = storeSource(base.bytes);
  const result = await runSigningPipeline({
    source,
    savedDigest: await savedStateFor(source, base.bytes),
    fields: [signatureField()],
    certificate: CERTIFICATE,
    identity,
    signingTime: new Date('2026-09-09T12:00:00Z'),
    signal,
    ...PATHS,
    ...over,
  });
  return { base, source, result };
}

const bodyAt = (objectPath: string) => objects.get(objectPath)!.body!;

/** Open a stored artifact with the real reader. */
async function reopenStored(ref: StoredPdf) {
  const source = openGcsPdfSource(ref);
  const index = await readDocumentIndex(source, signal);
  return { source, index };
}

/** Follow a reference, or hand back a value that is already direct. */
async function derefValue(source: any, index: any, value: any) {
  if (value && typeof value === 'object' && value.kind === 'ref') {
    return getObject(source, index, value.value, signal);
  }
  return value;
}

/** The bytes a /ByteRange says are covered, taken from the composed artifact. */
function coveredBytes(composed: Buffer, byteRange: number[]): Buffer {
  return Buffer.concat([
    composed.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    composed.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);
}

/** Ask the OpenSSL binary whether the detached signature holds. */
function opensslVerifies(cms: Uint8Array, content: Buffer): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralegix-pipeline-'));
  try {
    fs.writeFileSync(path.join(dir, 'sig.der'), Buffer.from(cms));
    fs.writeFileSync(path.join(dir, 'content.bin'), content);
    execFileSync('openssl', [
      'cms', '-verify', '-inform', 'DER',
      '-in', path.join(dir, 'sig.der'),
      '-content', path.join(dir, 'content.bin'),
      '-binary', '-noverify', '-out', path.join(dir, 'out.bin'),
    ], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => { resetRichBucket(); resetBytesRead(); });

describe('what a verifier sees', () => {
  it('signs a digest Node computes independently over the delivery and the filed copy', async () => {
    const { result } = await run();

    for (const artifact of [result.delivery, result.filed]) {
      const composed = bodyAt(artifact.ref.objectPath);
      expect(crypto.createHash('sha256').update(composed).digest('hex')).toBe(artifact.digestHex);
    }
  });

  it('verifies BOTH artifacts with the OpenSSL binary', async () => {
    // The two seals cover different byte ranges over different documents. A
    // pipeline that produced one correct seal and one wrong one would look
    // identical from inside this codebase.
    const { result } = await run();
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;

    for (const artifact of [result.delivery, result.filed]) {
      const composed = bodyAt(artifact.ref.objectPath);
      const suffix = new Uint8Array(composed.subarray(stampedSize));
      const area = findSignatureArea(composed, stampedSize);
      const { cms, byteRange } = readSealedSignature(suffix, area, stampedSize);

      expect(byteRange[2] + byteRange[3]).toBe(composed.length);
      expect(opensslVerifies(cms, coveredBytes(composed, byteRange))).toBe(true);
    }
  });

  it('FAILS in OpenSSL when one covered byte of the filed copy changes', async () => {
    // Without this the test above proves only that a CMS structure exists.
    const { result } = await run();
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;
    const composed = bodyAt(result.filed.ref.objectPath);
    const area = findSignatureArea(composed, stampedSize);
    const { cms, byteRange } = readSealedSignature(
      new Uint8Array(composed.subarray(stampedSize)), area, stampedSize,
    );

    const altered = Buffer.from(composed);
    altered[100] ^= 0x01;

    expect(opensslVerifies(cms, coveredBytes(altered, byteRange))).toBe(false);
  });

  it('leaves the prepared source byte for byte inside every artifact', async () => {
    // The whole design rests on the base never being rewritten. A signature
    // already on the source would otherwise be invalidated by signing it again.
    const { base, result } = await run();

    for (const objectPath of [
      result.stamped.objectPath, result.delivery.ref.objectPath, result.filed.ref.objectPath,
    ]) {
      expect(bodyAt(objectPath).subarray(0, base.bytes.length).equals(base.bytes)).toBe(true);
    }
  });

  it('gives the two artifacts an identical prefix up to the stamped source', async () => {
    // Which is what lets one saved hash state serve both seals.
    const { result } = await run();
    const stamped = bodyAt(result.stamped.objectPath);

    expect(bodyAt(result.delivery.ref.objectPath).subarray(0, stamped.length).equals(stamped)).toBe(true);
    expect(bodyAt(result.filed.ref.objectPath).subarray(0, stamped.length).equals(stamped)).toBe(true);
  });
});

describe('the two artifacts differ in the way they should', () => {
  it('puts the certificate ONLY in the filed copy', async () => {
    // What signers receive is the document they read, with no audit page
    // stapled to it. What the firm files carries the evidence.
    const { result } = await run();

    const delivery = await pageCountOf(result.delivery.ref);
    const filed = await pageCountOf(result.filed.ref);

    expect(delivery).toBe(2);
    expect(filed).toBeGreaterThan(2);
  });

  it('prints the DELIVERED copy hash on the certificate, not its own', async () => {
    // A page cannot state the hash of the file that contains it. The value that
    // used to be printed existed only inside the finalizer, so nobody holding
    // any artifact could reproduce it.
    //
    // The text is read out of the show operators and joined, because a 64
    // character hash does not fit the value column and is wrapped across two
    // lines. Searching the raw bytes for the whole hash would fail on a
    // certificate that states it perfectly correctly.
    const { result } = await run();
    const filed = bodyAt(result.filed.ref.objectPath).toString('latin1');
    const shown = [...filed.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).join('');

    expect(shown).toContain(result.delivery.digestHex);
    expect(shown).not.toContain(result.filed.digestHex);
  });

  it('draws the signer mark on the page, in both copies', async () => {
    const { base, result } = await run();
    const stampedSuffix = bodyAt(result.stamped.objectPath)
      .subarray(base.bytes.length).toString('latin1');

    expect(stampedSuffix).toContain('(Jane Roe)');
    expect(stampedSuffix).toMatch(/\/\w+ Do/);
  });
});

describe('bounded work', () => {
  it('reads far less than the document, because it appends rather than rewrites', async () => {
    // The claim the whole design rests on. The old path made five whole-document
    // passes; this one reads windows to parse structure and never the body.
    const base = minimalPdf({ pages: 2, fillerBytes: 2 * 1024 * 1024 });
    const source = storeSource(base.bytes);
    const saved = await savedStateFor(source, base.bytes);
    resetBytesRead();

    await runSigningPipeline({
      source,
      savedDigest: saved,
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    });

    // Windows for the tail, the cross-reference and a handful of objects. Well
    // under one pass over a 2 MB document, let alone five.
    expect(bytesRead()).toBeLessThan(base.bytes.length);
  });

  it('reads the source ONCE when there is no saved state, not five times', async () => {
    const base = minimalPdf({ pages: 2, fillerBytes: 2 * 1024 * 1024 });
    const source = storeSource(base.bytes);
    resetBytesRead();

    await runSigningPipeline({
      source,
      savedDigest: null,
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    });

    // One full pass for the digest, plus structural windows.
    expect(bytesRead()).toBeLessThan(base.bytes.length * 2);
  });

  it('produces the same artifacts whether it resumed or re-read the source', async () => {
    // The fallback is not a degraded mode. A source prepared before the state
    // existed always takes it.
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);
    const saved = await savedStateFor(source, base.bytes);

    const resumed = await runSigningPipeline({
      source, savedDigest: saved, fields: [signatureField()], certificate: CERTIFICATE,
      identity, signingTime: new Date('2026-09-09T12:00:00Z'), signal, ...PATHS,
    });
    const resumedFiled = bodyAt(resumed.filed.ref.objectPath);

    resetRichBucket();
    const source2 = storeSource(base.bytes);
    const streamed = await runSigningPipeline({
      source: source2, savedDigest: null, fields: [signatureField()], certificate: CERTIFICATE,
      identity, signingTime: new Date('2026-09-09T12:00:00Z'), signal, ...PATHS,
    });

    expect(streamed.delivery.digestHex).toBe(resumed.delivery.digestHex);
    expect(bodyAt(streamed.filed.ref.objectPath).equals(resumedFiled)).toBe(true);
  });
});

describe('the real field renderer fits the pipeline', () => {
  /**
   * A 2x2 RGBA PNG, built here rather than pasted as base64 so the samples are
   * readable. Row filter 0 on both rows, which is what a canvas emits.
   */
  function tinyPng(): Buffer {
    const zlib = require('zlib');
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type 6: RGBA
    const raw = Buffer.from([
      0, 255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 0, 255, 255, 255, 255, 255, 0,
    ]);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  function crc32(buf: Buffer): number {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  }

  it('stamps a real signature image and seals the result', async () => {
    // The two halves were built separately: one renders a field value as a
    // content stream, the other appends and seals. Neither test proves they fit,
    // and a mismatch between them is a document that fails to open.
    const {
      buildFieldAppearance, loadFieldAppearanceFonts,
    } = require('../../src/modules/signatures/pdf/fieldAppearance');
    const fonts = await loadFieldAppearanceFonts();
    const png = tinyPng();
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);

    const result = await runSigningPipeline({
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [{
        id: 'sig-1',
        page: 1,
        xPercent: 10, yPercent: 70, widthPercent: 30, heightPercent: 6,
        appearance: (allocate: any, box: any) => buildFieldAppearance({
          fieldType: 'signature',
          value: `data:image/png;base64,${png.toString('base64')}`,
          boxWidth: box.width,
          boxHeight: box.height,
          fonts,
          allocate,
        }),
      }],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      signal,
      ...PATHS,
    });

    expect(result.failures).toEqual([]);
    const stamped = bodyAt(result.stamped.objectPath).subarray(base.bytes.length).toString('latin1');
    // The image is an XObject the page invokes, and its alpha rides in an SMask.
    expect(stamped).toContain('/Subtype /Image');
    expect(stamped).toContain('/SMask');
    expect(stamped).toMatch(/\/\w+ Do/);

    // And the sealed artifact still verifies, which is what proves the appended
    // image objects did not disturb the offsets the signature covers.
    const composed = bodyAt(result.filed.ref.objectPath);
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;
    const area = findSignatureArea(composed, stampedSize);
    const { cms, byteRange } = readSealedSignature(
      new Uint8Array(composed.subarray(stampedSize)), area, stampedSize,
    );
    expect(opensslVerifies(cms, coveredBytes(composed, byteRange))).toBe(true);
  });
});

describe('the reserved seal area', () => {
  it('GROWS when the signature does not fit, rebuilding the whole suffix', async () => {
    // A certificate chain makes the CMS larger, and how much larger is a
    // property of the provisioned certificate rather than of this code. A fixed
    // 64 KiB hole in every signed document is 64 KiB of nothing; a fixed 8 KiB
    // one refuses a chain that is perfectly valid.
    //
    // Growing is only safe because the whole suffix is rebuilt at the new size,
    // so every offset and the digest come from the new layout. Widening the hole
    // in place would leave a signature describing byte positions that moved,
    // which opens in a viewer and verifies nowhere.
    const previous = process.env.SIGNING_CONTENTS_CAPACITY;
    process.env.SIGNING_CONTENTS_CAPACITY = '1024';
    jest.resetModules();
    try {
      const pipeline = require('../../src/modules/signatures/signingPipeline');
      const base = minimalPdf({ pages: 2 });
      const source = storeSource(base.bytes);

      const result = await pipeline.runSigningPipeline({
        source,
        savedDigest: await savedStateFor(source, base.bytes),
        fields: [signatureField()],
        certificate: CERTIFICATE,
        identity,
        signal,
        ...PATHS,
      });

      // It fitted on a later attempt rather than refusing, and what it produced
      // still verifies over the range it claims.
      const composed = bodyAt(result.delivery.ref.objectPath);
      const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;
      const area = findSignatureArea(composed, stampedSize);
      const { cms, byteRange } = readSealedSignature(
        new Uint8Array(composed.subarray(stampedSize)), area, stampedSize,
      );
      expect(area.contentsLength).toBeGreaterThan(1024 * 2 + 2);
      expect(byteRange[2] + byteRange[3]).toBe(composed.length);
      expect(opensslVerifies(cms, coveredBytes(composed, byteRange))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SIGNING_CONTENTS_CAPACITY;
      else process.env.SIGNING_CONTENTS_CAPACITY = previous;
      jest.resetModules();
    }
  });

  it('REFUSES rather than growing without limit', async () => {
    // A certificate chain that is wrong rather than large must fail with a
    // stated reason, not enlarge the hole until something else breaks.
    const previous = process.env.SIGNING_MAX_CONTENTS_CAPACITY;
    process.env.SIGNING_MAX_CONTENTS_CAPACITY = '1024';
    process.env.SIGNING_CONTENTS_CAPACITY = '1024';
    jest.resetModules();
    try {
      const pipeline = require('../../src/modules/signatures/signingPipeline');
      const base = minimalPdf({ pages: 2 });
      const source = storeSource(base.bytes);

      await expect(pipeline.runSigningPipeline({
        source,
        savedDigest: await savedStateFor(source, base.bytes),
        fields: [signatureField()],
        certificate: CERTIFICATE,
        identity,
        signal,
        ...PATHS,
      })).rejects.toMatchObject({ code: 'PDF_SIGNATURE_TOO_LARGE' });
    } finally {
      if (previous === undefined) delete process.env.SIGNING_MAX_CONTENTS_CAPACITY;
      else process.env.SIGNING_MAX_CONTENTS_CAPACITY = previous;
      delete process.env.SIGNING_CONTENTS_CAPACITY;
      jest.resetModules();
    }
  });
});

describe('running the same finalization twice', () => {
  /**
   * A retry is not an exception, it is the normal case.
   *
   * Finalization is a queued job with a lease, and everything between composing
   * the first artifact and recording BOTH on the session row is a window a
   * crash, a scale-in or an expired lease can land in. A retry then re-runs the
   * pipeline over destinations that already hold an earlier attempt's bytes.
   *
   * The destinations are create-only, which is right: it is what stops a second
   * worker from replacing bytes the first one already published a reference to.
   * What must NOT happen is a permanent stall, where every retry fails at the
   * same destination and a session whose signers have all signed can never
   * publish, with the finished artifacts sitting in storage the whole time.
   */
  beforeEach(resetRichBucket);

  it('produces both artifacts again after an attempt that got partway', async () => {
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);
    const savedDigest = await savedStateFor(source, base.bytes);
    const options = {
      source,
      savedDigest,
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      claimStillHeld: async () => true,
      signal,
      ...PATHS,
    };

    // The first attempt reaches storage and then loses its worker before the
    // session row can record what it made. Nothing points at these bytes.
    await runSigningPipeline(options);

    const again = await runSigningPipeline(options);

    expect(again.delivery).not.toBeNull();
    expect(again.filed).not.toBeNull();
    // What is recorded has to describe what is STORED. A retry that adopted an
    // earlier attempt's object while reporting this attempt's digest would give
    // the session a hash that verifies against nothing.
    const stored = objects.get(again.delivery!.ref.objectPath)!.body!;
    expect(crypto.createHash('sha256').update(stored).digest('hex'))
      .toBe(again.delivery!.digestHex);
    expect(again.delivery!.ref.generation).toBe(objects.get(again.delivery!.ref.objectPath)!.generation);
  });

  it('REFUSES to replace a destination when the claim is gone', async () => {
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);
    const options = {
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      claimStillHeld: async () => true,
      signal,
      ...PATHS,
    };

    const first = await runSigningPipeline(options);
    const published = objects.get(first.delivery!.ref.objectPath)!;

    // A worker whose lease expired may be looking at an object the worker that
    // took over has already published a reference to. Replacing it there is the
    // corruption create-only exists to prevent: a session row naming a digest
    // that no longer describes the stored bytes.
    await expect(runSigningPipeline({ ...options, claimStillHeld: async () => false }))
      .rejects.toMatchObject({ code: 'SIGNING_ARTIFACT_EXISTS' });

    expect(objects.get(first.delivery!.ref.objectPath)!.generation).toBe(published.generation);
    expect(objects.get(first.delivery!.ref.objectPath)!.body).toEqual(published.body);
  });

  it('refuses when no claim is offered at all', async () => {
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);
    const options = {
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      signal,
      ...PATHS,
    };

    await runSigningPipeline({ ...options, claimStillHeld: async () => true });

    // The default has to be the safe one. A caller that never thought about
    // leases must not get the replacing behaviour by omission.
    await expect(runSigningPipeline(options))
      .rejects.toMatchObject({ code: 'SIGNING_ARTIFACT_EXISTS' });
  });

  it('leaves no unreferenced artifact from the attempt that failed', async () => {
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);
    const options = {
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      claimStillHeld: async () => true,
      signal,
      ...PATHS,
    };

    const first = await runSigningPipeline(options);
    const second = await runSigningPipeline(options);

    // Storage billed forever for a document nothing can identify is the cost of
    // getting this wrong in the other direction.
    const orphans = Array.from(objects.keys())
      .filter((key) => key.startsWith('signing-uploads/firm/out/'))
      .filter((key) => key !== second.delivery!.ref.objectPath
        && key !== second.filed!.ref.objectPath
        && key !== second.stamped.objectPath);
    expect({ orphans, firstDelivery: first.delivery!.ref.objectPath })
      .toEqual({ orphans: [], firstDelivery: first.delivery!.ref.objectPath });
  });
});

describe('sealing a document that still has a form', () => {
  /**
   * Preparation flattens forms, so most documents reach the seal with none. Not
   * all of them: a session recorded before the admission boundary existed has no
   * prepared source, and `resolveSource` falls back to pinning the raw upload
   * and streaming it. That document arrives here with its AcroForm intact.
   *
   * The seal has to ADD its field to that form. Replacing the form with one
   * holding only the seal empties the document's field list, and every field the
   * signer filled stops being a field. Nothing errors, and the widgets are still
   * drawn, so the loss is visible only to something that enumerates fields.
   */
  beforeEach(resetRichBucket);

  it('adds its own field to the form instead of replacing it', async () => {
    const base = minimalPdf({ flattenableForm: true });
    const source = storeSource(base.bytes);

    const { delivery } = await runSigningPipeline({
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      signal,
      ...PATHS,
    });

    const { source: sealed, index } = await reopenStored(delivery!.ref);
    try {
      const rootRef: any = index.trailer.entries.get('Root');
      const catalog: any = await getObject(sealed, index, rootRef.value, signal);
      const acroForm: any = await derefValue(sealed, index, catalog.entries.get('AcroForm'));
      const fields: any = await derefValue(sealed, index, acroForm.entries.get('Fields'));

      // The seal's own field, PLUS whatever the document already had. One entry
      // here means the document's own fields were dropped.
      expect(fields.values.length).toBeGreaterThan(1);
    } finally {
      await sealed.close();
    }
  });

  it('keeps the form resources the document already declared', async () => {
    const base = minimalPdf({ flattenableForm: true, formDefaultAppearance: true });
    const source = storeSource(base.bytes);

    const { delivery } = await runSigningPipeline({
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      fields: [signatureField()],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T12:00:00Z'),
      signal,
      ...PATHS,
    });

    const { source: sealed, index } = await reopenStored(delivery!.ref);
    try {
      const rootRef: any = index.trailer.entries.get('Root');
      const catalog: any = await getObject(sealed, index, rootRef.value, signal);
      const acroForm: any = await derefValue(sealed, index, catalog.entries.get('AcroForm'));

      // `/DA` is the default appearance every field without its own falls back
      // to. `forms.ts` takes care to carry it through a flatten; throwing it
      // away one step later undoes that.
      expect(acroForm.entries.get('DA')).toBeDefined();
    } finally {
      await sealed.close();
    }
  });
});

describe('refusing to publish', () => {
  it('publishes NOTHING when a field cannot be placed', async () => {
    // After consent this is recoverable state, not a refusal that throws away
    // what the signer agreed to. What it must never be is a completed session
    // pointing at a document missing one of the marks.
    const base = minimalPdf({ pages: 2 });
    const source = storeSource(base.bytes);

    const result = await runSigningPipeline({
      source,
      savedDigest: await savedStateFor(source, base.bytes),
      // Page 9 of a two-page document.
      fields: [signatureField({ page: 9 })],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].fieldId).toBe('field-1');
    expect(objects.has(PATHS.deliveryPath)).toBe(false);
    expect(objects.has(PATHS.filedPath)).toBe(false);
    expect(objects.has(PATHS.stampedPath)).toBe(false);
  });

  it('leaves no scratch behind', async () => {
    // A stray suffix is billed storage nobody can identify later.
    const { result } = await run();

    const scratch = Array.from(objects.keys())
      .filter((key) => key.startsWith(PATHS.scratchPrefix));
    expect(scratch).toEqual([]);
    expect(result.filed.ref.objectPath).toBe(PATHS.filedPath);
  });
});

/**
 * Find the reserved signature area by reading the appended revision.
 *
 * The pipeline does not hand it back, and a verifier does not get one either:
 * it finds the `/ByteRange` and `/Contents` in the bytes. Doing the same here
 * keeps the test on what a verifier can actually see.
 */
function findSignatureArea(composed: Buffer, baseSize: number) {
  const text = composed.toString('latin1');
  const rangeStart = text.indexOf('/ByteRange ', baseSize) + '/ByteRange '.length;
  const rangeEnd = text.indexOf(']', rangeStart) + 1;
  const contentsStart = text.indexOf('<', text.indexOf('/Contents ', rangeEnd));
  const contentsEnd = text.indexOf('>', contentsStart) + 1;
  return {
    byteRangeStart: rangeStart,
    byteRangeLength: rangeEnd - rangeStart,
    contentsStart,
    contentsLength: contentsEnd - contentsStart,
  };
}

/** Pages in a stored artifact, read with the real reader. */
async function pageCountOf(ref: StoredPdf): Promise<number> {
  const source = openGcsPdfSource(ref);
  try {
    const index = await readDocumentIndex(source, signal);
    return (await resolvePages(source, index, signal)).length;
  } finally {
    await source.close();
  }
}
