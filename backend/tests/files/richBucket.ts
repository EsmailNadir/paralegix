/**
 * The harness's in-memory bucket, plus the three `File` operations the mutation
 * half of the files module needs and `tests/support/inMemoryBucket.ts` does not
 * implement.
 *
 * `inMemoryBucket` covers the read and relocate paths: exists, getMetadata,
 * setMetadata, save, delete, copy, getSignedUrl. Three routes reach past that
 * set, and each of them is a route no spec could drive without it:
 *
 *   createResumableUpload  `POST /upload-init` mints one session per declared
 *                          file and hands the browser a URL. The session is what
 *                          records who started the upload, which is the whole
 *                          basis on which `/upload-finalize` later accepts or
 *                          refuses to adopt an object.
 *   download               `/upload-finalize` reads the first eight bytes back
 *                          out of GCS to catch an executable that lied about its
 *                          name at init time.
 *   createReadStream       `/download-folder` and `/download-zip` pipe every
 *                          object into an archiver stream.
 *
 * Everything else delegates to the harness stub, so the object map, the paging
 * and the metadata semantics stay the single ones the other files specs use.
 *
 * Like the stub it extends, this is a test double and not a thing to assert
 * about. `completeResumableUpload` in particular is the BROWSER's half of the
 * resumable handshake, deliberately kept outside the routes: a spec that made
 * the object by calling an upload route could not then express "finalize an
 * object somebody else's session created".
 */
import { Readable } from 'stream';

import { objects, fakeFile, inMemoryBucket, nextGeneration } from '../support/inMemoryBucket';

/** What a resumable session declared, keyed by the object path it was opened for. */
export interface ResumableSession {
  contentType: string;
  /** The custom metadata `/upload-init` stamps, `uploadedBy` above all. */
  custom: Record<string, string>;
}

/** Sessions opened by `/upload-init`, in the order the route asked for them. */
export const resumableSessions = new Map<string, ResumableSession>();

/** Number of resumable-session creations that should fail before succeeding. */
export const resumableUploadFault = { remaining: 0 };

/**
 * Leading bytes for objects whose content matters. Only the finalize sniff reads
 * them; everything else in the module cares about the byte COUNT, which the
 * stub already tracks.
 */
export const objectHeads = new Map<string, Buffer>();

/** Wipe the bucket and both side tables. Call in `beforeEach`. */
/**
 * Source paths whose `copy` must fail, for the storage-failure cases.
 *
 * A folder relocation copies each object, verifies it, then deletes the source,
 * and the walk runs a page through `runWithConcurrency`, whose contract is
 * `allSettled`. Without a way to make ONE object fail, there is no test that the
 * walk inspects the settled array at all, and that array being discarded is what
 * once let a partly-failed relocation report success.
 */
export const failCopyFrom = new Set<string>();

/**
 * Paths whose `createReadStream()` should error out partway through instead of
 * completing normally, keyed by the message to fail with. This is the fault
 * `/download-folder` and `/download-zip` have no way to trigger today: GCS
 * itself failing mid-read, after the archive has already started streaming to
 * the client.
 */
export const failReadStreamFrom = new Map<string, string>();

/**
 * Paths whose `createReadStream()` should drip its bytes across a few ticks
 * instead of pushing them all synchronously in one chunk. A client-disconnect
 * test needs something to disconnect DURING; a stream that is already fully
 * buffered before the test can react gives it nothing to interrupt.
 */
export const slowReadStreamFrom = new Set<string>();

/**
 * Every read stream `createReadStream()` has handed out and not yet closed.
 * Lets a spec assert a stream was actually destroyed (no leaked handle) rather
 * than left dangling when a download errors or the client disconnects.
 */
export const liveReadStreams = new Set<Readable>();

/**
 * Paths whose `createWriteStream()` should fail on the first chunk, keyed by
 * the message to fail with. This is the fault an archive job has no other way
 * to trigger: GCS refusing the write partway, while a source read is still in
 * flight. A build that only ever fails on the READ side would never show
 * whether the source it had open at the time was closed.
 */
export const failWriteStreamFrom = new Map<string, string>();

/**
 * Object paths passed to `bucket.file()` during the current test, in call
 * order. The cross-firm isolation check for archive downloads needs to prove a
 * negative under a real fault (nothing built from another firm's object is
 * ever TOUCHED, not merely absent from the final entry list, which an
 * interrupted response might not even finish producing) - this is the log that
 * makes that provable.
 */
export const filePathsAccessed: string[] = [];

export function resetRichBucket(): void {
  objects.clear();
  resumableSessions.clear();
  resumableUploadFault.remaining = 0;
  objectHeads.clear();
  bytesHandedOut = 0;
  failCopyFrom.clear();
  failReadStreamFrom.clear();
  failWriteStreamFrom.clear();
  slowReadStreamFrom.clear();
  liveReadStreams.clear();
  filePathsAccessed.length = 0;
}

const notFound = () => Object.assign(new Error('No such object'), { code: 404 });

/**
 * Bytes this double has handed out.
 *
 * The signing pipeline's central claim is that executing a document does not
 * read the document. That claim is only testable if something counts, and a
 * test asserting "it worked" would pass just as well on a path that pulled the
 * whole file five times.
 */
let bytesHandedOut = 0;
export function bytesRead(): number { return bytesHandedOut; }
export function resetBytesRead(): void { bytesHandedOut = 0; }

/** The stub's `File`, plus the three operations above. */
function richFile(path: string, fileOptions: any = {}): Record<string, unknown> {
  filePathsAccessed.push(path);
  const file = fakeFile(path, fileOptions) as Record<string, unknown>;
  // `bucket.file(path, { generation })` pins the handle to one version of the
  // object. The overrides below re-read it rather than the stream options,
  // because that is where the real client carries it.
  const pinnedGeneration = fileOptions?.generation === undefined || fileOptions?.generation === null
    ? null
    : String(fileOptions.generation);

  file.createResumableUpload = async (options: any = {}) => {
    if (resumableUploadFault.remaining > 0) {
      resumableUploadFault.remaining -= 1;
      throw Object.assign(new Error('Resumable session provider unavailable'), {
        statusCode: 503,
        code: 'STORAGE_SESSION_UNAVAILABLE',
      });
    }
    const declared = options?.metadata || {};
    const custom: Record<string, string> = {};
    for (const [key, value] of Object.entries(declared.metadata || {})) {
      if (value !== null && value !== undefined) custom[key] = String(value);
    }
    resumableSessions.set(path, {
      contentType: declared.contentType || 'application/octet-stream',
      custom,
    });
    return [`https://resumable.test/${encodeURIComponent(path)}`];
  };

  const realCopy = file.copy as (destination: { name: string }, options?: any) => Promise<unknown>;
  file.copy = async (destination: { name: string }, options?: any) => {
    if (failCopyFrom.has(path)) {
      throw Object.assign(new Error(`Copy of ${path} failed`), { code: 503 });
    }
    return realCopy.call(file, destination, options);
  };

  file.download = async (options: any = {}) => {
    const stored = objects.get(path);
    if (!stored) throw notFound();
    // Real bytes when a spec supplied them. The head-only path below stays for
    // the specs that describe a length and a sniff rather than a document.
    const source = stored.body ?? objectHeads.get(path) ?? Buffer.alloc(Math.min(8, stored.bytes));
    const start = Number(options?.start ?? 0);
    const end = options?.end == null ? source.length : Number(options.end) + 1;
    const slice = source.subarray(start, end);
    bytesHandedOut += slice.length;
    return [slice];
  };

  // GCS refuses a delete whose `ifGenerationMatch` names a version that is no
  // longer the live one. A double that ignored it would let a spec of "a stale
  // worker cannot remove its replacement's object" pass without the pin.
  const realDelete = file.delete as (options?: any) => Promise<unknown>;
  file.delete = async (options: any = {}) => {
    const wanted = options?.ifGenerationMatch;
    const stored = objects.get(path);
    if (wanted !== undefined && wanted !== null && stored && String(wanted) !== stored.generation) {
      throw Object.assign(new Error('Precondition Failed'), { code: 412 });
    }
    return realDelete.call(file, options);
  };

  const realWriteStream = file.createWriteStream as (options?: any) => any;
  file.createWriteStream = (options: any = {}) => {
    const failWith = failWriteStreamFrom.get(path);
    if (!failWith) return realWriteStream.call(file, options);
    const { Writable } = require('stream');
    return new Writable({
      write(_chunk: Buffer, _encoding: string, done: (err?: Error | null) => void) {
        done(new Error(failWith));
      },
    });
  };

  file.createReadStream = (options: any = {}) => {
    const stored = objects.get(path);
    if (!stored) return Readable.from([]);

    // A handle pinned to a version that is no longer there reads nothing, even
    // when the spec described the object by length alone. Checking this only on
    // the real-bytes branch below would make every "the object was replaced
    // mid-archive" test pass against filler without the pin existing.
    const pinnedWanted = pinnedGeneration
      ?? options?.generation ?? options?.preconditionOpts?.ifGenerationMatch;
    if (pinnedWanted !== undefined && pinnedWanted !== null
      && String(pinnedWanted) !== stored.generation) {
      return Readable.from((async function* stale(): any {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      })());
    }

    const failWith = failReadStreamFrom.get(path);
    const slow = slowReadStreamFrom.has(path);

    let stream: Readable;
    if (!failWith && !slow && stored.body) {
      const start = Number(options?.start) || 0;
      const end = Number.isFinite(options?.end) ? Number(options.end) : stored.body.length - 1;
      const slice = stored.body.subarray(start, end + 1);
      bytesHandedOut += slice.length;
      stream = Readable.from([slice]);
    } else if (!failWith && !slow) {
      // Filler rather than empty: an archive assertion about which ENTRIES
      // landed is worth nothing if every entry is zero bytes and the zip
      // elides them.
      stream = Readable.from([Buffer.alloc(stored.bytes, 0x78)]);
    } else if (failWith) {
      // Push one small chunk, then fail. A test asserting "no misleading
      // success" only needs the failure to land after the response has
      // already committed to a 200, not a long drip.
      const chunkSize = Math.max(1, Math.ceil(stored.bytes / 4));
      let sent = 0;
      stream = new Readable({
        read() {
          if (sent >= chunkSize) {
            setTimeout(() => this.destroy(new Error(failWith)), 5);
            return;
          }
          sent = chunkSize;
          this.push(Buffer.alloc(chunkSize, 0x78));
        },
      });
    } else {
      // Drip the object across many real ticks, wide enough that a
      // client-disconnect test has a comfortable window to cut the
      // connection mid-stream instead of racing a handful of milliseconds.
      const CHUNKS = 25;
      const chunkSize = Math.max(1, Math.ceil(stored.bytes / CHUNKS));
      let sent = 0;
      stream = new Readable({
        read() {
          if (sent >= stored.bytes) {
            this.push(null);
            return;
          }
          const size = Math.min(chunkSize, stored.bytes - sent);
          sent += size;
          const chunk = Buffer.alloc(size, 0x78);
          setTimeout(() => this.push(chunk), 20);
        },
      });
    }

    liveReadStreams.add(stream);
    stream.once('close', () => liveReadStreams.delete(stream));
    return stream;
  };

  return file;
}

export const richBucket = {
  ...inMemoryBucket,
  file: richFile,
  // Listed files have to carry the same `copy` seam as `file(path)` does. The
  // relocation walk never calls `bucket.file()`: it copies the File objects the
  // LISTING handed it, so a fault installed only on `file()` would never fire.
  getFiles: async (options: any = {}) => {
    const [page, next] = await (inMemoryBucket as any).getFiles(options);
    return [page.map((listed: any) => richFile(listed.name)), next];
  },
  // Server-side concatenation behaves the same whichever double is installed.
  combine: (inMemoryBucket as any).combine,
  // The document converter removes its scratch prefix this way after every
  // conversion, so a spec that drives the real converter needs it.
  deleteFiles: async ({ prefix = '' }: { prefix?: string } = {}) => {
    for (const path of [...objects.keys()]) {
      if (path.startsWith(prefix)) objects.delete(path);
    }
  },
};

/** Point `admin.storage()` at the rich bucket. Call at a spec's MODULE scope. */
export function installRichBucket(): void {
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => richBucket } as never);
}

/**
 * The browser's half of a resumable upload: put bytes at a path an
 * `/upload-init` session was opened for, carrying that session's stamped
 * metadata the way GCS would.
 *
 * `custom` overrides let a spec express the cases the route exists to refuse:
 * an object stamped with a DIFFERENT uploader, or bytes that disagree with what
 * was declared.
 */
export function completeResumableUpload(
  objectPath: string,
  opts: {
    bytes?: number;
    head?: Buffer;
    body?: Buffer;
    custom?: Record<string, string>;
    /**
     * The size storage REPORTS, when it should differ from the body's length.
     *
     * A size check reads the object's metadata, never its bytes, so a spec that
     * proves one can say "this landed at N" without building N bytes. Half a
     * gigabyte allocated per worker to prove a comparison is a real cost in a
     * suite that runs four of them.
     */
    sizeOverride?: number;
  },
): void {
  const session = resumableSessions.get(objectPath);
  if (!session) {
    throw new Error(`No resumable session was opened for ${objectPath}`);
  }
  objects.set(objectPath, {
    bytes: opts.sizeOverride ?? (opts.body ? opts.body.length : opts.bytes ?? 0),
    body: opts.body,
    contentType: session.contentType,
    custom: { ...session.custom, ...(opts.custom || {}) },
    generation: nextGeneration(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
  if (opts.head) objectHeads.set(objectPath, opts.head);
}

/**
 * The entry names inside a zip, read from its central directory.
 *
 * The central directory rather than the local headers: archiver streams these
 * entries, so a local header carries zero sizes and a trailing data descriptor,
 * and scanning for local-header signatures can be fooled by the compressed bytes
 * themselves. The central directory is the authoritative index and sits at a
 * known offset from the end of the file.
 */
export function zipEntryNames(archive: Buffer): string[] {
  const END_SIGNATURE = 0x06054b50;
  const ENTRY_SIGNATURE = 0x02014b50;

  let end = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === END_SIGNATURE) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive: no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(cursor) !== ENTRY_SIGNATURE) {
      throw new Error(`Corrupt central directory at byte ${cursor}`);
    }
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

/**
 * Entry name -> uncompressed size, read from the same central directory as
 * `zipEntryNames`. Two firms' colliding-named files land under the same entry
 * name; size is what distinguishes whose bytes actually made it into the
 * archive without decompressing anything.
 */
export function zipEntrySizes(archive: Buffer): Map<string, number> {
  const END_SIGNATURE = 0x06054b50;
  const ENTRY_SIGNATURE = 0x02014b50;

  let end = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === END_SIGNATURE) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive: no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const sizes = new Map<string, number>();
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(cursor) !== ENTRY_SIGNATURE) {
      throw new Error(`Corrupt central directory at byte ${cursor}`);
    }
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    sizes.set(name, uncompressedSize);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return sizes;
}

/**
 * Entry name -> compression method, from the same central directory as
 * `zipEntryNames`. 0 is STORE (a straight copy), 8 is DEFLATE. The archive
 * routes must store: every document type a firm uploads is already compressed,
 * so deflating spends the container's one CPU to shrink nothing, and a large
 * archive that is CPU-bound instead of network-bound is the one that hits the
 * request timeout partway through.
 */
export function zipEntryCompressionMethods(archive: Buffer): Map<string, number> {
  const END_SIGNATURE = 0x06054b50;
  const ENTRY_SIGNATURE = 0x02014b50;

  let end = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === END_SIGNATURE) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive: no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const methods = new Map<string, number>();
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(cursor) !== ENTRY_SIGNATURE) {
      throw new Error(`Corrupt central directory at byte ${cursor}`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    methods.set(name, method);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return methods;
}


/**
 * Read a response body as raw bytes.
 *
 * supertest parses by content type and has no parser for `application/zip`, so
 * without this `res.body` is an empty object and every archive assertion below
 * would be vacuous.
 */
export const asBuffer = (res: any, callback: any): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
