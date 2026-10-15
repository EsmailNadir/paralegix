/**
 * A content fingerprint for a picked file, computed off the main thread.
 *
 * An upload session is recalled by an identity made of the destination and the
 * file. Name, size and last-modified were the whole file half, and none of them
 * is content: a document re-exported from the same template, or two scans saved
 * a moment apart, agree on all three. The second file then resumes into the
 * first one's session and the stored object gets the front of one document and
 * the back of another, at a size that looks entirely correct. The hash is what
 * makes "the same file" mean the same bytes.
 *
 * WHAT IS HASHED
 * The first and last `FINGERPRINT_SAMPLE_WINDOW` bytes, or the whole file when
 * it is no larger than two windows. Size and mtime are already part of the
 * store key, so the hash only has to tell apart two files that agree on both,
 * and a re-export or a second scan differs in its head or its tail. Hashing all
 * of a 10 GB file for that was a 100 second wait before the first byte could be
 * sent. A file up to two windows is hashed whole, so its fingerprint is the
 * same SHA-256 an earlier release stored for it.
 *
 * HOW IT IS COMPUTED, AND WHY NOT WITH WEBCRYPTO
 * `crypto.subtle.digest` needs one contiguous buffer, so using it means
 * `await file.arrayBuffer()`, which allocates the whole document. These uploads
 * exist because a document can be gigabytes; that allocation is the failure the
 * feature is meant to remove, not a detail. So the file is read one
 * `Blob.slice()` at a time and fed to an incremental hasher (`./sha256`), and
 * peak memory is one chunk whatever the file's size.
 *
 * WHERE IT RUNS
 * In a Web Worker. Hashing a gigabyte is seconds of solid arithmetic, and on
 * the main thread that is a frozen tab. The worker script is built by
 * stringifying the hasher rather than shipped as a separate entry point, which
 * keeps one implementation of SHA-256 in the codebase and needs no bundler
 * configuration. When there is no Worker (jsdom, a CSP that forbids blob:
 * workers) the same loop runs here instead: a slower upload is a far better
 * outcome than one that cannot start.
 */
import { createSha256Hasher } from './sha256';

/**
 * 8 MiB per read. Big enough that a gigabyte is a few hundred iterations,
 * small enough that peak memory is irrelevant next to the file itself.
 */
export const FINGERPRINT_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 8 MiB from each end of a file. Together with the size and mtime in the
 * store key, that tells apart any two realistic files, and it bounds the read
 * at 16 MiB however large the file is.
 */
export const FINGERPRINT_SAMPLE_WINDOW = 8 * 1024 * 1024;

export interface FingerprintOptions {
  chunkSize?: number;
  /** Bytes hashed from each end of a file larger than two of these. */
  sampleWindow?: number;
  /**
   * How to obtain the Worker. `null` forces the in-thread loop.
   *
   * Injected rather than imported so a test can prove the digest came FROM a
   * worker, which is the only claim worth making about it.
   */
  createWorker?: (() => Worker) | null;
}

/**
 * Read one slice as bytes.
 *
 * `Blob.arrayBuffer` is the direct route and what every current browser has.
 * The `FileReader` path is for the ones that do not (Safari before 14, and
 * jsdom), where its absence would otherwise make the fingerprint, and so
 * resumption, unavailable rather than merely slower.
 */
function readSliceSource(): string {
  return `function readSlice(slice) {
  if (typeof slice.arrayBuffer === 'function') return slice.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error || new Error('The file could not be read.')); };
    reader.readAsArrayBuffer(slice);
  });
}`;
}

/**
 * The worker's own script: the hasher, plus a message loop that drives it.
 *
 * The hasher is bound to the name the loop calls rather than declared under
 * its own. A production build renames the function, so its source reads
 * `function a() {...}`, and a loop calling `createSha256Hasher` threw a
 * ReferenceError on every file and quietly moved the hashing back onto the
 * main thread.
 */
export function fingerprintWorkerSource(): string {
  return `var createSha256Hasher = (${createSha256Hasher.toString()});
${readSliceSource()}
self.addEventListener('message', function (event) {
  var request = event.data || {};
  var blob = request.blob;
  var chunkSize = request.chunkSize;
  var sampleWindow = request.sampleWindow > 0 ? request.sampleWindow : Infinity;
  var hasher = createSha256Hasher();
  var ranges = blob.size <= 2 * sampleWindow
    ? [[0, blob.size]]
    : [[0, sampleWindow], [blob.size - sampleWindow, blob.size]];
  var range = 0;
  var at = 0;
  function step() {
    try {
      while (range < ranges.length && at >= ranges[range][1]) {
        range += 1;
        if (range < ranges.length) at = ranges[range][0];
      }
      if (range >= ranges.length) {
        self.postMessage({ id: request.id, fingerprint: hasher.hex() });
        return;
      }
      var end = Math.min(at + chunkSize, ranges[range][1]);
      var slice = blob.slice(at, end);
      at = end;
      readSlice(slice).then(function (buffer) {
        hasher.update(new Uint8Array(buffer));
        step();
      }, function (error) {
        self.postMessage({ id: request.id, error: String(error && error.message ? error.message : error) });
      });
    } catch (error) {
      self.postMessage({ id: request.id, error: String(error && error.message ? error.message : error) });
    }
  }
  step();
});
`;
}

/** Build a worker from an object url holding the generated script. */
function defaultWorkerFactory(): (() => Worker) | null {
  if (typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return null;
  }
  return () => {
    const url = URL.createObjectURL(
      new Blob([fingerprintWorkerSource()], { type: 'text/javascript' }),
    );
    try {
      return new Worker(url);
    } finally {
      // The worker keeps its script once constructed, so the url can go back
      // immediately rather than leaking one entry per picked file.
      URL.revokeObjectURL(url);
    }
  };
}

/** The same slice read as `readSliceSource` performs, for the in-thread loop. */
function readSlice(slice: Blob): Promise<ArrayBuffer> {
  if (typeof slice.arrayBuffer === 'function') return slice.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.readAsArrayBuffer(slice);
  });
}

/**
 * The byte ranges hashed: the whole blob when it is no larger than two
 * windows, else its head and its tail. The worker source builds the same list.
 */
function sampleRanges(size: number, sampleWindow: number): Array<[number, number]> {
  if (size <= 2 * sampleWindow) return [[0, size]];
  return [[0, sampleWindow], [size - sampleWindow, size]];
}

/** The slice-at-a-time loop, run on whichever thread called it. */
async function digestInThread(blob: Blob, chunkSize: number, sampleWindow: number): Promise<string> {
  const hasher = createSha256Hasher();
  for (const [from, to] of sampleRanges(blob.size, sampleWindow)) {
    for (let at = from; at < to; at += chunkSize) {
      const slice = blob.slice(at, Math.min(at + chunkSize, to));
      hasher.update(new Uint8Array(await readSlice(slice)));
    }
  }
  return hasher.hex();
}

let nextRequestId = 1;

function digestInWorker(
  worker: Worker,
  blob: Blob,
  chunkSize: number,
  sampleWindow: number,
): Promise<string> {
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise<string>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const reply = (event.data || {}) as { id?: number; fingerprint?: string; error?: string };
      if (reply.id !== id) return;
      if (typeof reply.fingerprint === 'string') resolve(reply.fingerprint);
      else reject(new Error(reply.error || 'The file could not be read.'));
    };
    worker.addEventListener('message', onMessage as EventListener);
    // A worker that fails to load answers `error` and nothing else, which would
    // otherwise leave the upload waiting forever with nothing on screen.
    worker.addEventListener('error', () => reject(new Error('The file could not be read.')));
    worker.postMessage({ id, blob, chunkSize, sampleWindow });
  });
}

/**
 * The SHA-256 of a blob's sampled content (see `sampleRanges`), as 64
 * lowercase hex characters.
 *
 * Never rejects for want of a worker: a browser that cannot start one gets the
 * same digest computed here.
 */
export async function fingerprintBlob(
  blob: Blob,
  options: FingerprintOptions = {},
): Promise<string> {
  const chunkSize = options.chunkSize ?? FINGERPRINT_CHUNK_SIZE;
  const sampleWindow = options.sampleWindow ?? FINGERPRINT_SAMPLE_WINDOW;
  const factory = options.createWorker === undefined ? defaultWorkerFactory() : options.createWorker;

  if (factory && blob.size > 0) {
    let worker: Worker | null = null;
    try {
      worker = factory();
      return await digestInWorker(worker, blob, chunkSize, sampleWindow);
    } catch {
      // A blocked blob: worker, or a worker that died mid-file. The upload is
      // worth more than the thread it costs.
      return digestInThread(blob, chunkSize, sampleWindow);
    } finally {
      worker?.terminate?.();
    }
  }

  return digestInThread(blob, chunkSize, sampleWindow);
}

/**
 * The fingerprint of a picked file, computed once per File instance.
 *
 * A batch upload asks for the identity before init and again when a session is
 * saved or cleared; without this, a three-gigabyte file is hashed several times
 * for one upload.
 */
const fingerprintsByFile = new WeakMap<Blob, Promise<string>>();

export function fingerprintFile(file: File, options?: FingerprintOptions): Promise<string> {
  const known = fingerprintsByFile.get(file);
  if (known) return known;
  const pending = fingerprintBlob(file, options);
  fingerprintsByFile.set(file, pending);
  return pending;
}
