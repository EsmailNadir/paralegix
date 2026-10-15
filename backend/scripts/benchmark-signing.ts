/**
 * Exercise the incremental signing pipeline against a persisted GCS object.
 *
 * This is deliberately a SCRIPT rather than a Jest test. The source is created
 * by `--prepare` outside the constrained application container, then `--run`
 * is invoked inside a 512 MiB Podman container. That separation makes the
 * reported memory belong to the signing lifecycle, not fixture construction.
 *
 * It requires a GCS-compatible endpoint (fake-gcs-server locally) through
 * STORAGE_EMULATOR_HOST. It never uses the in-memory bucket test double: a
 * 2 GiB source has to be real persisted bytes for a memory result to mean
 * anything.
 */
import { createHash, randomUUID } from 'crypto';
import { once } from 'events';
import { Readable, Transform } from 'stream';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const args = new Set(process.argv.slice(2));
const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const mode = args.has('--prepare') ? 'prepare' : 'run';
const sizeMiB = Number(arg('--size-mb', process.env.SIGNING_BENCHMARK_SIZE_MB || '100'));
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1) throw new Error('--size-mb must be a positive integer.');
if (!process.env.STORAGE_EMULATOR_HOST) {
  throw new Error('STORAGE_EMULATOR_HOST must point to a GCS-compatible benchmark endpoint.');
}

const bucketName = process.env.GCS_BUCKET || 'lawfirms';
const benchmarkId = arg('--id', process.env.SIGNING_BENCHMARK_ID || randomUUID());
const prefix = `signing-benchmarks/${benchmarkId}`;
const sourcePath = `${prefix}/source.pdf`;
const targetBytes = sizeMiB * MiB;

/**
 * How many signing operations to run at once.
 *
 * The product allows one per instance (`transferSlot.ts`). This exists to
 * measure what that number COULD be: what N concurrent operations actually cost
 * a 512 MiB container, rather than assuming one is the only safe answer.
 */
const concurrency = Number(arg('--concurrency', process.env.SIGNING_BENCHMARK_CONCURRENCY || '1'));
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new Error('--concurrency must be a positive integer.');
}

/** A minimal one-page PDF with a genuinely large legal whitespace stream. */
function layoutFor(payloadBytes: number) {
  const header = Buffer.from('%PDF-1.7\n', 'latin1');
  const objectOne = Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1');
  const objectTwo = Buffer.from('2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>\nendobj\n', 'latin1');
  const objectThree = Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n', 'latin1');
  const objectFour = Buffer.from(`4 0 obj\n<< /Length ${payloadBytes} >>\nstream\n`, 'latin1');
  const prefixBytes = Buffer.concat([header, objectOne, objectTwo, objectThree, objectFour]);
  const xrefOffset = prefixBytes.length + payloadBytes + Buffer.byteLength('\nendstream\nendobj\n', 'latin1');
  const offsets = [0, header.length, header.length + objectOne.length,
    header.length + objectOne.length + objectTwo.length,
    header.length + objectOne.length + objectTwo.length + objectThree.length];
  const rows = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const footer = Buffer.from(`\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n${rows}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return { prefix: prefixBytes, footer, total: prefixBytes.length + payloadBytes + footer.length };
}

function sourceLayout(target: number) {
  let payload = target;
  for (let i = 0; i < 8; i += 1) {
    const layout = layoutFor(payload);
    const next = target - layout.prefix.length - layout.footer.length;
    if (next === payload) return { ...layout, payload };
    payload = next;
  }
  const layout = layoutFor(payload);
  if (layout.total !== target) throw new Error('Could not calculate a PDF layout at the requested size.');
  return { ...layout, payload };
}

/**
 * The largest single request the local emulator will take.
 *
 * `fake-gcs-server` drops the connection partway through a multi-gigabyte
 * upload, which surfaces as a socket hang up and reads like a fault in the code
 * under test. Above this the fixture is written in parts and JOINED in storage,
 * which is the same operation the pipeline itself uses and produces byte for
 * byte the same object.
 */
const MAX_SINGLE_UPLOAD = Number(process.env.SIGNING_BENCHMARK_MAX_SINGLE_UPLOAD_MB || 1024) * MiB;

/** GCS composes at most 32 sources per call, and so does the emulator. */
const MAX_COMPOSE_SOURCES = 32;

/**
 * Write a fixture larger than one request can carry, by parts.
 *
 * The bytes are a plain concatenation, so slicing the same stream across N
 * objects and composing them yields exactly the object a single write would
 * have produced. The parts are removed afterwards; only the source remains.
 */
async function writeLargePdfInParts(bucket: any, destination: any, target: number) {
  const { prefix: header, footer, payload } = sourceLayout(target);
  const whole = Buffer.concat([header, Buffer.alloc(0)]);
  const partCount = Math.min(
    MAX_COMPOSE_SOURCES,
    Math.max(2, Math.ceil(target / MAX_SINGLE_UPLOAD)),
  );
  const partSize = Math.ceil(target / partCount);
  const chunk = Buffer.alloc(Math.min(4 * MiB, partSize), 0x20);

  const partPaths: string[] = [];
  let written = 0;
  for (let index = 0; index < partCount; index += 1) {
    const partPath = `${destination.name}.part-${index}`;
    partPaths.push(partPath);
    const size = Math.min(partSize, target - written);
    const stream = bucket.file(partPath).createWriteStream({
      resumable: false,
      metadata: { contentType: 'application/pdf' },
      highWaterMark: 256 * 1024,
    });

    let remaining = size;
    // The header leads the first part and the footer trails the last, so the
    // joined object carries them in the one place each belongs.
    if (index === 0) {
      stream.write(whole.length ? header : header);
      remaining -= header.length;
    }
    const tail = index === partCount - 1 ? footer.length : 0;
    remaining -= tail;
    while (remaining > 0) {
      const part = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      // eslint-disable-next-line no-await-in-loop -- backpressure, by design
      if (!stream.write(part)) await once(stream, 'drain');
      remaining -= part.length;
    }
    if (tail) stream.end(footer); else stream.end();
    // eslint-disable-next-line no-await-in-loop -- one part at a time
    await once(stream, 'finish');
    written += size;
  }

  await bucket.combine(partPaths.map((path: string) => bucket.file(path)), destination, {
    contentType: 'application/pdf',
  });
  await Promise.all(partPaths.map((path: string) => bucket.file(path).delete().catch(() => {})));

  const [meta] = await destination.getMetadata();
  if (Number(meta.size) !== target) {
    throw new Error(`Composed fixture is ${meta.size} bytes, expected ${target}.`);
  }
  // The payload count is only used to size the parts; naming it keeps the
  // relationship between layout and parts explicit rather than implied.
  void payload;
}

async function writeLargePdf(destination: any, target: number) {
  const { prefix: header, footer, payload } = sourceLayout(target);
  const stream = destination.createWriteStream({
    // fake-gcs-server's resumable-session endpoint is intentionally not part
    // of this local harness. The client still streams the body with bounded
    // backpressure, and fixture preparation runs outside the measured cgroup.
    resumable: false,
    metadata: { contentType: 'application/pdf' },
    highWaterMark: 256 * 1024,
  });
  stream.write(header);
  // Whitespace is legal inside a content stream. Reusing this bounded chunk is
  // precisely the property the benchmark is proving: source size must not
  // change live application memory.
  const chunk = Buffer.alloc(Math.min(256 * 1024, payload), 0x20);
  let remaining = payload;
  while (remaining > 0) {
    const part = remaining === chunk.length ? chunk : chunk.subarray(0, remaining);
    if (!stream.write(part)) await once(stream, 'drain');
    remaining -= part.length;
  }
  stream.end(footer);
  await once(stream, 'finish');
}

function identity() {
  // The benchmark certificate is generated inside the measured process because
  // this is part of a real seal. It is tiny and deterministic in shape.
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Paralegix benchmark signer' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * The container's own view of peak memory, when there is one.
 *
 * `process.memoryUsage()` is what Node knows about. The limit that kills the
 * process is enforced by the cgroup, which also counts page cache charged to
 * this container and allocations Node never sees. cgroup v2 records the high
 * water mark in `memory.peak`; outside a container the file is absent and the
 * field stays null, which is reported rather than guessed at.
 */
function cgroupPeakBytes(): number | null {
  try {
    const fs = require('fs');
    const value = fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim();
    return Number.isFinite(Number(value)) ? Number(value) : null;
  } catch {
    return null;
  }
}

/**
 * A signature mark on page one, drawn as a content stream.
 *
 * Deliberately the same shape the pipeline's own tests use: a Form XObject with
 * a DIRECT font dictionary, which is legal and needs no object number, so the
 * benchmark measures the pipeline rather than a font-loading path of its own.
 */
function benchmarkSignatureField() {
  const text = 'Benchmark signer';
  const content = Buffer.from(`BT /F1 18 Tf 4 8 Td (${text}) Tj ET\n`, 'latin1');
  const dict = (entries: Record<string, any>) => ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
  const name = (value: string) => ({ kind: 'name', value });
  return {
    id: 'benchmark-signature',
    page: 1,
    xPercent: 10,
    yPercent: 70,
    widthPercent: 30,
    heightPercent: 6,
    appearance: () => ({
      content: new Uint8Array(content),
      bbox: { width: 180, height: 48 },
      resources: dict({
        Font: dict({
          F1: dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica') }),
        }),
      }),
    }),
  };
}

async function main() {
  const { admin } = require('../src/shared/database/firebase');
  const realStorage = admin.storage();
  const realBucket = realStorage.bucket(bucketName);

  if (mode === 'prepare') {
    const [exists] = await realBucket.file(sourcePath).exists();
    if (!exists) {
      if (targetBytes > MAX_SINGLE_UPLOAD) {
        await writeLargePdfInParts(realBucket, realBucket.file(sourcePath), targetBytes);
      } else {
        await writeLargePdf(realBucket.file(sourcePath), targetBytes);
      }
    }
    const [metadata] = await realBucket.file(sourcePath).getMetadata();
    const result = {
      id: benchmarkId,
      objectPath: sourcePath,
      generation: String(metadata.generation),
      sizeBytes: Number(metadata.size),
      sha256: await hashStored(realBucket.file(sourcePath), Number(metadata.size)),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const generation = arg('--generation', process.env.SIGNING_BENCHMARK_GENERATION);
  if (!generation) throw new Error('--generation is required for --run. Use the value printed by --prepare.');
  const declaredPath = arg('--source-path', process.env.SIGNING_BENCHMARK_SOURCE_PATH || sourcePath)!;
  const [metadata] = await realBucket.file(declaredPath).getMetadata();
  const source = { objectPath: declaredPath, generation, sizeBytes: Number(metadata.size) };
  if (String(metadata.generation) !== generation) throw new Error('SOURCE_CHANGED before benchmark start.');

  const meter = { rangeRequests: 0, sourceBytesRead: 0 };
  /**
   * The real bucket, with reads of the SOURCE counted.
   *
   * A Proxy rather than an object spread. Spreading a class instance copies its
   * own enumerable properties and leaves the prototype behind, so `combine`,
   * `getFiles` and the rest simply vanish, and the failure arrives later as
   * "storage.combine is not a function" from inside the compose. Intercepting
   * one method leaves every other one exactly as it was.
   */
  const meteredBucket: any = new Proxy(realBucket, {
    get(bucketTarget, bucketProperty) {
      if (bucketProperty !== 'file') {
        const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
        return typeof value === 'function' ? value.bind(bucketTarget) : value;
      }
      return (path: string, options?: any) => {
      const handle = realBucket.file(path, options);
      return new Proxy(handle, {
        get(target, property) {
          if (property !== 'createReadStream') {
            // Read against the TARGET, not the proxy, and bind a method to it.
            // The storage client's File keeps private class fields, and a
            // method invoked with the proxy as its receiver cannot see them:
            // it throws "Cannot read private member from an object whose class
            // did not declare it" from inside the library.
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (streamOptions: any) => {
            const original = target.createReadStream(streamOptions);
            if (path !== declaredPath) return original;
            meter.rangeRequests += 1;
            const counting = new Transform({
              transform(chunk, _encoding, callback) {
                meter.sourceBytesRead += chunk.length;
                callback(null, chunk);
              },
            });
            return original.pipe(counting);
          };
        },
      });
      };
    },
  });
  admin.storage = () => ({ ...realStorage, bucket: () => meteredBucket });

  /**
   * What the process costs before any signing work happens.
   *
   * Reported because every peak below INCLUDES it, and without it a figure like
   * "130 MiB" reads as the price of one document when almost all of it is the
   * Node runtime, the loaded application graph and V8's own heap. The number
   * that matters for capacity is the peak MINUS this.
   */
  const baseline = { ...process.memoryUsage() };

  const memory = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const sample = () => {
    const current = process.memoryUsage();
    memory.rss = Math.max(memory.rss, current.rss);
    memory.heapUsed = Math.max(memory.heapUsed, current.heapUsed);
    memory.external = Math.max(memory.external, current.external);
    memory.arrayBuffers = Math.max(memory.arrayBuffers, current.arrayBuffers);
  };
  sample();
  const timer = setInterval(sample, 50);
  const started = process.hrtime.bigint();
  try {
    const { createResumableDigest } = require('../src/modules/signatures/pdf/resumableDigest');
    const { openGcsPdfSource } = require('../src/modules/signatures/pdf/gcsSource');
    const { runSigningPipeline } = require('../src/modules/signatures/signingPipeline');
    const digest = await createResumableDigest();
    const pdf = openGcsPdfSource(source);
    try {
      for await (const chunk of pdf.stream(0, source.sizeBytes, new AbortController().signal)) digest.update(chunk);
    } finally {
      await pdf.close();
    }
    const savedDigest = digest.save(source);
    // What preparation cost, before the meter is reset. Everything counted from
    // here belongs to the PIPELINE, which is the number the claim is about.
    const preparationBytesRead = meter.sourceBytesRead;
    const preparationRangeRequests = meter.rangeRequests;
    meter.sourceBytesRead = 0;
    meter.rangeRequests = 0;

    // The peak SO FAR belongs to preparation, which streams the whole document
    // to hash it. Everything after this belongs to the pipeline, and the
    // pipeline's own peak is the number the design claims is independent of
    // document size. Reported separately because a single figure cannot tell
    // the two apart, and the growth between two sizes is otherwise unattributable.
    sample();
    const peakBeforePipeline = { ...memory };
    memory.rss = 0;
    memory.heapUsed = 0;
    memory.external = 0;
    memory.arrayBuffers = 0;
    sample();
    // One identity for every run. Generating an RSA key pair per operation
    // would measure `node-forge` rather than the pipeline, and in the product
    // the signing certificate is loaded once and reused.
    const signingIdentity = identity();

    /**
     * One whole signing operation, writing to its own prefix.
     *
     * The SOURCE is shared. It is read-only and pinned to one generation, which
     * is exactly what several concurrent finalizations of different sessions
     * over the same document would do, and it keeps the fixture cost at one
     * upload rather than N.
     */
    const runOne = (index: number) => {
      const scope = concurrency === 1 ? prefix : `${prefix}/run-${index}`;
      return runSigningPipeline({
        source,
        savedDigest,
        // One real mark, because the pipeline refuses to seal a document with
        // none: a tamper-evident copy of an unmarked form is the one artifact
        // that must never be produced. It also makes this measure the whole job,
        // appearance planning included, rather than a seal on its own.
        fields: [benchmarkSignatureField()],
        certificate: {
          documentTitle: 'Large-file benchmark', transactionId: `${benchmarkId}-${index}`,
          signerName: 'Benchmark signer', signedAt: new Date().toISOString(),
          originalDocumentHash: createHash('sha256').update(source.objectPath).digest('hex'),
          signers: [{ name: 'Benchmark signer', completedAt: new Date().toISOString() }],
        },
        identity: signingIdentity,
        scratchPrefix: `${scope}/scratch/`,
        stampedPath: `${scope}/stamped.pdf`,
        deliveryPath: `${scope}/delivery.pdf`,
        filedPath: `${scope}/filed.pdf`,
        signal: new AbortController().signal,
      });
    };

    // Started together, deliberately. The slot limiter is NOT in this path, so
    // this measures what N genuinely concurrent operations cost, which is the
    // question the limiter's value has to be set from.
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, index) => runOne(index)),
    );
    const result = results[0];
    for (const one of results) {
      if (!one.delivery || !one.filed) throw new Error('Pipeline did not publish both sealed artifacts.');
    }
    // Preparation reads the source ONCE, and that read is the one above, before
    // the meter was reset. What the pipeline reads afterwards is the claim being
    // measured: it resolves the cross-reference chain and the page it stamps
    // through bounded windows, and never reads the document to seal it.
    //
    // Not zero, and asserting zero is what made this fail on a correct run: the
    // structure has to be read to know where the page is. One percent of the
    // document is far below a second pass and far above what planning needs, so
    // it separates "bounded" from "read it again" without pinning a window size.
    const pipelineReadLimit = Math.max(8 * MiB, Math.floor(source.sizeBytes / 100));
    if (preparationBytesRead !== source.sizeBytes) {
      throw new Error(`Expected one streamed preparation read (${source.sizeBytes}), got ${preparationBytesRead}.`);
    }
    if (meter.sourceBytesRead > pipelineReadLimit * concurrency) {
      throw new Error(`The pipeline read ${meter.sourceBytesRead} bytes of a ${source.sizeBytes}-byte source, over the ${pipelineReadLimit} ceiling.`);
    }
    sample();
    process.stdout.write(`${JSON.stringify({
      source,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      peak: memory,
      cgroupPeakBytes: cgroupPeakBytes(),
      concurrency,
      baseline,
      peakBeforePipeline,
      preparationBytesRead,
      preparationRangeRequests,
      rangeRequests: meter.rangeRequests,
      sourceBytesRead: meter.sourceBytesRead,
      engineCacheEntries: 0,
      delivery: result.delivery.ref,
      filed: result.filed.ref,
      deliverySha256: result.delivery.digestHex,
      filedSha256: result.filed.digestHex,
    })}\n`);
  } finally {
    clearInterval(timer);
  }
}

async function hashStored(file: any, size: number) {
  const digest = createHash('sha256');
  const stream = file.createReadStream({ start: 0, end: size - 1, highWaterMark: 256 * 1024 });
  for await (const chunk of stream as Readable) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
