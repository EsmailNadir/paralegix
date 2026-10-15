/**
 * The contract every reader above `PdfSource` has to keep, proved at RUNTIME.
 *
 * `tests/config/signingLifecycleBounded.test.ts` checks the source code for a
 * whole-document read. This checks the behaviour, which is the half a static
 * scan cannot see: a caller can ask for the whole file one legal-looking window
 * at a time, or ask for a window sized from the document rather than from the
 * structure it needs.
 *
 * So the source below is HOSTILE. It refuses a read wider than the engine's own
 * ceiling, it records every window it served, and it counts the total. A reader
 * that quietly grew its appetite fails here rather than on a 2 GB document in
 * production, where the symptom is a container restart and no stack trace.
 */
import crypto from 'crypto';
import { readDocumentIndex, getObject } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages, visibleGeometry } from '../../../src/modules/signatures/pdf/pages';
import { MAX_READ_BYTES } from '../../../src/modules/signatures/pdf/gcsSource';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import { sealSuffix } from '../../../src/modules/signatures/pdf/seal';
import { createResumableDigest } from '../../../src/modules/signatures/pdf/resumableDigest';
import { minimalPdf } from '../../support/minimalPdf';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: 0 } });

interface Ledger {
  /** Every window served, as [start, length]. */
  windows: Array<[number, number]>;
  /** Bytes handed out in total, reads and streams together. */
  bytes: number;
}

/**
 * A source that refuses to be read all at once.
 *
 * `read` throws above the engine's own per-read ceiling, which is what makes a
 * caller that passes `sizeBytes` as a length fail immediately. `stream` is
 * allowed to cover the whole file, because hashing is linear by nature: what it
 * must not do is hold the result, and the chunk size proves it does not.
 */
function hostileSource(bytes: Buffer, ledger: Ledger): PdfSource {
  return {
    ref: { objectPath: 'hostile.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (length > MAX_READ_BYTES) {
        throw new Error(`Refused a ${length}-byte read; the ceiling is ${MAX_READ_BYTES}.`);
      }
      if (start + length > bytes.length) throw new Error('Read past the end.');
      ledger.windows.push([start, length]);
      ledger.bytes += length;
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) {
      const CHUNK = 64 * 1024;
      for (let at = start; at < endExclusive; at += CHUNK) {
        const end = Math.min(at + CHUNK, endExclusive);
        ledger.bytes += end - at;
        yield new Uint8Array(bytes.subarray(at, end));
      }
    },
    async close() {},
  };
}

const emptyLedger = (): Ledger => ({ windows: [], bytes: 0 });

describe('reading structure', () => {
  it('finds the cross-reference from a bounded TAIL window', async () => {
    // Searching for `startxref` from the front means reading the whole file, so
    // the reader takes the tail and refuses a document that does not end with
    // one rather than scanning for it.
    const { bytes } = minimalPdf({ pages: 3, fillerBytes: 400 * 1024 });
    const ledger = emptyLedger();

    await readDocumentIndex(hostileSource(bytes, ledger), signal);

    expect(ledger.bytes).toBeLessThan(bytes.length);
    // The first window is at the end of the file, not the start.
    expect(ledger.windows[0][0]).toBeGreaterThan(bytes.length / 2);
  });

  it('resolves a page tree without reading the pages themselves', async () => {
    // A page's CONTENT is the bulk of a document. Walking the tree touches
    // dictionaries, and a walk that also pulled content streams would cost the
    // document's size to answer "how many pages".
    const { bytes } = minimalPdf({ pages: 3, fillerBytes: 400 * 1024 });
    const ledger = emptyLedger();
    const source = hostileSource(bytes, ledger);

    const index = await readDocumentIndex(source, signal);
    const pages = await resolvePages(source, index, signal);

    expect(pages).toHaveLength(3);
    expect(visibleGeometry(pages[0]).width).toBe(612);
    // Well under the 400 KiB content stream, let alone the whole document.
    expect(ledger.bytes).toBeLessThan(100 * 1024);
  });

  it('reads ONE object with a window sized to the object, not to the file', async () => {
    // The defect this catches is invisible at small sizes: a fixed large window
    // per object is bounded, never fails, and transfers gigabytes to read a few
    // hundred bytes of dictionaries on a thousand-page tree.
    const { bytes } = minimalPdf({ pages: 2, fillerBytes: 2 * 1024 * 1024 });
    const ledger = emptyLedger();
    const source = hostileSource(bytes, ledger);
    const index = await readDocumentIndex(source, signal);
    const before = ledger.bytes;

    await getObject(source, index, { objectNumber: 1, generationNumber: 0 }, signal);

    expect(ledger.bytes - before).toBeLessThan(64 * 1024);
  });

  it('REFUSES a caller that asks for the whole file in one read', async () => {
    // The hostile source is only worth having if it actually refuses. Without
    // this, every assertion above could be passing against a permissive double.
    const { bytes } = minimalPdf({ pages: 1, fillerBytes: 16 * 1024 * 1024 });
    const source = hostileSource(bytes, emptyLedger());

    await expect(source.read(0, bytes.length, signal)).rejects.toThrow(/Refused a/);
  });
});

describe('sealing', () => {
  it('seals a large document without reading it, when the state was saved', async () => {
    // The whole reason a 2 GB document can be signed on a 512 MiB instance. The
    // saved state already covers the source, so finalizing touches the suffix
    // and the structure it has to parse, and nothing else.
    const base = minimalPdf({ pages: 2, fillerBytes: 4 * 1024 * 1024 });
    const ledger = emptyLedger();
    const source = hostileSource(base.bytes, ledger);

    const digest = await createResumableDigest();
    digest.update(base.bytes);
    const saved = digest.save(source.ref);

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      trailer: dict({ Size: 5, Root: ref(1) }),
      objects: [{
        ref: { objectNumber: 9, generationNumber: 0 },
        signaturePlaceholder: { contentsCapacity: 4096 },
        value: dict({
          Type: name('Sig'), Filter: name('Adobe.PPKLite'), SubFilter: name('adbe.pkcs7.detached'),
        }),
      }],
    });

    const before = ledger.bytes;
    const sealed = await sealSuffix({ source, update, identity, savedDigest: saved, signal });

    expect(sealed.resumed).toBe(true);
    // Not one byte of the source was read to seal it.
    expect(ledger.bytes).toBe(before);
    expect(sealed.signedDigestHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the source exactly ONCE on the fallback, not repeatedly', async () => {
    // A source prepared before the saved state existed always takes this path,
    // so it has to be efficient as well as correct.
    const base = minimalPdf({ pages: 2, fillerBytes: 4 * 1024 * 1024 });
    const ledger = emptyLedger();
    const source = hostileSource(base.bytes, ledger);

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      trailer: dict({ Size: 5, Root: ref(1) }),
      objects: [{
        ref: { objectNumber: 9, generationNumber: 0 },
        signaturePlaceholder: { contentsCapacity: 4096 },
        value: dict({
          Type: name('Sig'), Filter: name('Adobe.PPKLite'), SubFilter: name('adbe.pkcs7.detached'),
        }),
      }],
    });

    await sealSuffix({ source, update, identity, savedDigest: null, signal });

    // One pass, plus nothing. Two passes would be the old design wearing new
    // names, and the number is the only thing that tells them apart.
    expect(ledger.bytes).toBeGreaterThanOrEqual(base.bytes.length);
    expect(ledger.bytes).toBeLessThan(base.bytes.length * 1.1);
  });
});

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

it('keeps the digest identical however the bytes arrive', () => {
  // A chunk boundary is the classic place a streamed hash goes wrong, and the
  // error is silent: a wrong digest still signs.
  const bytes = minimalPdf({ pages: 1, fillerBytes: 200 * 1024 }).bytes;
  const whole = crypto.createHash('sha256').update(bytes).digest('hex');
  const chunked = crypto.createHash('sha256');
  for (let at = 0; at < bytes.length; at += 7919) {
    chunked.update(bytes.subarray(at, Math.min(at + 7919, bytes.length)));
  }
  expect(chunked.digest('hex')).toBe(whole);
});
