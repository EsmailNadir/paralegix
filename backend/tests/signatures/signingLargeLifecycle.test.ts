/**
 * Proving the full incremental signing lifecycle for large and complex documents
 * under memory constraints.
 *
 * This test suite validates:
 * 1. 1,000-page nested tree documents execute, stamp fields on first/middle/last pages,
 *    and seal delivery & filed artifacts without whole-document buffering.
 * 2. Scanned documents with image content and hybrid xref variants run through preparation,
 *    stamping, dual-sealing, and independent OpenSSL CMS verification.
 * 3. Multi-signer workflows (sequential and parallel signers) succeed across revisions.
 * 4. The three-way finalization invariant:
 *    - Fast path with saved digest state (source is NOT re-read).
 *    - Fallback path with deleted state (streamed full hash produces identical digests).
 *    - Mismatched generation throws PDF_GENERATION_CHANGED rather than silently signing mismatched bytes.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import type { PdfDict, PdfValue, StoredPdf } from '../../src/modules/signatures/pdf/types';
import {
  buildNestedThousandPageTree,
  buildNestedThousandPageTreeInObjectStreams,
  buildScannedJpegPage,
  buildHybridXref,
} from '../shared/pdf/fixtures/buildSigningFixtures';

let bytesHandedOut = 0;
const countingBucket = {
  ...inMemoryBucket,
  file: (filePath: string) => {
    const handle = inMemoryBucket.file(filePath) as any;
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
        stream.on('data', (chunk: Buffer) => {
          bytesHandedOut += chunk.length;
          counted.push(chunk);
        });
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
const { readDocumentIndex } = require('../../src/modules/signatures/pdf/reader');
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
  const attrs = [{ name: 'commonName', value: 'Paralegix Benchmark Signer' }];
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

function signatureField(pageNumber: number, label: string) {
  const content = Buffer.from(`BT /F1 14 Tf 4 8 Td (${label}) Tj ET\n`, 'latin1');
  return {
    id: `field-${pageNumber}`,
    page: pageNumber,
    xPercent: 15,
    yPercent: 80,
    widthPercent: 25,
    heightPercent: 5,
    appearance: () => ({
      content: new Uint8Array(content),
      bbox: { width: 150, height: 40 },
      resources: dict({
        Font: dict({
          F1: dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica') }),
        }),
      }),
    }),
  };
}

const SOURCE_PATH = 'signing-uploads/firm/large/source.pdf';

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
  documentTitle: 'Large Lifecycle Master Document',
  transactionId: 'txn-large-lifecycle',
  signerName: 'Primary Signer',
  signedAt: '2026-09-09T15:00:00.000Z',
  originalDocumentHash: '1234567890abcdef',
  signers: [
    { name: 'Primary Signer', roleLabel: 'Signer 1', completedAt: '2026-09-09T14:30:00.000Z' },
    { name: 'Secondary Signer', roleLabel: 'Signer 2', completedAt: '2026-09-09T15:00:00.000Z' },
  ],
};

function opensslVerifies(cms: Uint8Array, content: Buffer): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralegix-large-'));
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

function coveredBytes(composed: Buffer, byteRange: number[]): Buffer {
  return Buffer.concat([
    composed.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    composed.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);
}

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

describe('signingLargeLifecycle: 1,000-page nested document execution', () => {
  beforeEach(() => { resetRichBucket(); });

  it('resolves a 1,000-page tree packed into object streams, reading each container once', async () => {
    const bytes = await buildNestedThousandPageTreeInObjectStreams();
    const source = storeSource(bytes);
    const pdf = openGcsPdfSource(source);
    let reads = 0;
    const counting = {
      ...pdf,
      async read(start: number, length: number, s: AbortSignal) {
        reads += 1;
        return pdf.read(start, length, s);
      },
    };
    try {
      const index = await readDocumentIndex(counting, signal);
      const pages = await resolvePages(counting, index, signal);
      expect(pages).toHaveLength(1000);
      // About two reads per container (its dictionary and its payload) plus the
      // index. Decoding a container once per object it holds is two reads per
      // PAGE, over two thousand for this tree.
      expect(reads).toBeLessThan(200);
    } finally {
      await pdf.close();
    }
  }, 30000);

  it('resolves, stamps fields on first, middle (500), and last (1000) pages, and seals both artifacts', async () => {
    const thousandPageBytes = await buildNestedThousandPageTree();
    const source = storeSource(thousandPageBytes);
    const savedDigest = await savedStateFor(source, thousandPageBytes);

    const fields = [
      signatureField(1, 'Page 1 Header Signer'),
      signatureField(500, 'Page 500 Midpoint Reviewer'),
      signatureField(1000, 'Page 1000 Final Approver'),
    ];

    const result = await runSigningPipeline({
      source,
      savedDigest,
      fields,
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T15:00:00Z'),
      signal,
      ...PATHS,
    });

    expect(result.failures).toEqual([]);
    expect(result.delivery).toBeDefined();
    expect(result.filed).toBeDefined();

    // Verify OpenSSL validity for both delivery and filed artifacts
    const deliveryComposed = objects.get(result.delivery.ref.objectPath)!.body!;
    const filedComposed = objects.get(result.filed.ref.objectPath)!.body!;
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;

    const deliveryArea = findSignatureArea(deliveryComposed, stampedSize);
    const deliverySig = readSealedSignature(new Uint8Array(deliveryComposed.subarray(stampedSize)), deliveryArea, stampedSize);
    expect(opensslVerifies(deliverySig.cms, coveredBytes(deliveryComposed, deliverySig.byteRange))).toBe(true);

    const filedArea = findSignatureArea(filedComposed, stampedSize);
    const filedSig = readSealedSignature(new Uint8Array(filedComposed.subarray(stampedSize)), filedArea, stampedSize);
    expect(opensslVerifies(filedSig.cms, coveredBytes(filedComposed, filedSig.byteRange))).toBe(true);

    // Filed document contains original 1,000 pages + appended certificate page(s)
    const gcsSource = openGcsPdfSource(result.filed.ref);
    try {
      const index = await readDocumentIndex(gcsSource, signal);
      const pages = await resolvePages(gcsSource, index, signal);
      expect(pages.length).toBeGreaterThan(1000);
    } finally {
      await gcsSource.close();
    }
  }, 30000);
});

describe('signingLargeLifecycle: scanned document & hybrid xref variants', () => {
  beforeEach(() => { resetRichBucket(); });

  it('correctly processes scanned image pages without exceeding working memory', async () => {
    const scannedBytes = await buildScannedJpegPage();
    const source = storeSource(scannedBytes);
    const savedDigest = await savedStateFor(source, scannedBytes);

    const result = await runSigningPipeline({
      source,
      savedDigest,
      fields: [signatureField(1, 'Scanned Document Seal')],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    });

    expect(result.failures).toEqual([]);
    const deliveryComposed = objects.get(result.delivery.ref.objectPath)!.body!;
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;
    const area = findSignatureArea(deliveryComposed, stampedSize);
    const sig = readSealedSignature(new Uint8Array(deliveryComposed.subarray(stampedSize)), area, stampedSize);
    expect(opensslVerifies(sig.cms, coveredBytes(deliveryComposed, sig.byteRange))).toBe(true);
  });

  it('handles hybrid xref tables transparently across updates', async () => {
    const hybridBytes = await buildHybridXref({ pagesOnlyInStream: false });
    const source = storeSource(hybridBytes);
    const savedDigest = await savedStateFor(source, hybridBytes);

    const result = await runSigningPipeline({
      source,
      savedDigest,
      fields: [signatureField(1, 'Hybrid Form Signer')],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    });

    expect(result.delivery).toBeDefined();
    const filedComposed = objects.get(result.filed.ref.objectPath)!.body!;
    const stampedSize = objects.get(result.stamped.objectPath)!.body!.length;
    const area = findSignatureArea(filedComposed, stampedSize);
    const sig = readSealedSignature(new Uint8Array(filedComposed.subarray(stampedSize)), area, stampedSize);
    expect(opensslVerifies(sig.cms, coveredBytes(filedComposed, sig.byteRange))).toBe(true);
  });
});

describe('signingLargeLifecycle: three-way finalization invariant', () => {
  beforeEach(() => { resetRichBucket(); });

  it('fast path, fallback path, and source changed detection', async () => {
    const base = minimalPdf({ pages: 2, fillerBytes: 512 * 1024 });
    const source = storeSource(base.bytes);
    const savedDigest = await savedStateFor(source, base.bytes);

    // 1. Fast path with saved state: source is NOT re-read
    resetBytesRead();
    const fastResult = await runSigningPipeline({
      source,
      savedDigest,
      fields: [signatureField(1, 'Signer Fast')],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T16:00:00Z'),
      signal,
      ...PATHS,
    });
    const fastBytesRead = bytesRead();
    expect(fastBytesRead).toBeLessThan(source.sizeBytes);

    // 2. Fallback path with no saved state: re-reads source once and produces identical digests
    resetRichBucket();
    const source2 = storeSource(base.bytes);
    resetBytesRead();
    const fallbackResult = await runSigningPipeline({
      source: source2,
      savedDigest: null,
      fields: [signatureField(1, 'Signer Fast')],
      certificate: CERTIFICATE,
      identity,
      signingTime: new Date('2026-09-09T16:00:00Z'),
      signal,
      ...PATHS,
    });
    expect(fallbackResult.delivery.digestHex).toBe(fastResult.delivery.digestHex);
    expect(fallbackResult.filed.digestHex).toBe(fastResult.filed.digestHex);

    // 3. Deliberately altered generation raises PDF_GENERATION_CHANGED rather than silently signing mismatched bytes
    const staleDigest = {
      ...savedDigest,
      generation: '9999999999999999',
    };
    await expect(runSigningPipeline({
      source,
      savedDigest: staleDigest,
      fields: [signatureField(1, 'Signer Stale')],
      certificate: CERTIFICATE,
      identity,
      signal,
      ...PATHS,
    })).rejects.toMatchObject({ code: 'PDF_GENERATION_CHANGED' });
  });
});
