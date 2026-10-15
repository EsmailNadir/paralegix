/**
 * An in-memory stand-in for the GCS bucket.
 *
 * The harness's Firebase mock makes storage inert: every bucket operation
 * throws under its own name, so loading the app is free and a spec that reaches
 * the bucket fails loudly instead of passing against a silent no-op. That is the
 * right default, and it stops most specs before they do damage. It also makes a
 * handful of paths untestable, because for them the object IS the behaviour: a
 * rename is a copy-then-delete, and the authoritative file listing is a walk of
 * the bucket. This is the swap the mock itself tells those specs to make.
 *
 * ORDER IS LOAD-BEARING. `files.storage.ts` and `shareLinks.service.ts` each
 * resolve `admin.storage().bucket(...)` ONCE, at module load, and hand that one
 * handle to every route. So `installInMemoryBucket()` must run at a spec's
 * module scope, before the app is first required, and the returned bucket object
 * has to stay the same for the whole file. Clearing `objects` between tests is
 * what gives each test a fresh bucket without replacing the handle.
 *
 * This is a test double, not a fake worth trusting on its own: it implements
 * only the operations the files module calls, and no spec should assert that it
 * works. Assertions belong on what the ROUTE decided to write, move or refuse.
 */

export interface StoredObject {
  bytes: number;
  contentType: string;
  /** Leading bytes, for a test about what an admission sniff reads back. */
  head?: Buffer;
  /**
   * The whole object, for a test that reads windows out of it.
   *
   * Most specs care only about the length and the metadata, so this stays
   * optional. The incremental PDF path is the exception: it reads ranges and
   * streams, and a length alone cannot answer either.
   */
  body?: Buffer;
  /**
   * The object's version, as a STRING.
   *
   * Real GCS mints one per write and every signing read pins it, so a document
   * replaced mid-operation fails rather than being read across two versions.
   * A double that reports no generation would let that check pass vacuously.
   */
  generation: string;
  /** GCS custom metadata: the object's `metadata.metadata` bag. */
  custom: Record<string, string>;
  /** When the object was written. What an age-based sweep reads. */
  created: string;
  updated: string;
}

/**
 * Mints the next generation.
 *
 * Real generations are microsecond timestamps, which is to say 64-bit values
 * that do not survive a JS number. These are strings above 2^53 for the same
 * reason: code that coerces one would compare two versions equal here too.
 */
let generationCounter = 1_730_000_000_000_001;
export function nextGeneration(): string {
  generationCounter += 1;
  return String(generationCounter);
}

/** Object path -> what is stored there. Clear this between tests. */
/**
 * Resumable sessions opened but not yet uploaded to.
 *
 * Kept apart from `objects` because opening a session creates nothing in
 * storage. `landUpload` is what turns one into an object, so a test can leave a
 * session unfinished and see what a route does about it.
 */
export const pendingUploads = new Map<string, { contentType: string; custom: Record<string, string> }>();

/**
 * The bucket's contents, which specs reset with `objects.clear()`.
 *
 * `clear()` drops the open sessions too. That has to happen here rather than in
 * a `beforeEach` inside `installInMemoryBucket`, because several specs call
 * that function from INSIDE a test body, and Jest refuses a hook registered
 * there. Tying the reset to the call every spec already makes needs no spec to
 * change and cannot be forgotten by the next one.
 */
class BucketContents extends Map<string, StoredObject> {
  clear(): void {
    pendingUploads.clear();
    signedUrlCalls.length = 0;
    objectReads.length = 0;
    super.clear();
  }
}

export const objects: Map<string, StoredObject> = new BucketContents();

const notFound = () => Object.assign(new Error('No such object'), { code: 404 });

/** Only strings survive in GCS custom metadata, and a null value removes the key. */
function normalizeCustom(bag: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bag || {})) {
    if (value !== null && value !== undefined) out[key] = String(value);
  }
  return out;
}

function metadataOf(path: string) {
  const stored = objects.get(path) as StoredObject;
  return {
    name: path,
    // Reported as a STRING, as the real client does; several handlers `Number()` it.
    size: String(stored.bytes),
    contentType: stored.contentType,
    generation: stored.generation,
    // Both, as the real client reports them. A sweep that ages objects out reads
    // `timeCreated`, so a double that only carried `updated` would make every
    // object look infinitely old and every "this is too new to collect" test
    // pass for the wrong reason.
    timeCreated: stored.created,
    updated: stored.updated,
    metadata: { ...stored.custom },
  };
}

/** The object's bytes, or zeros when a spec only described its length. */
function bytesOf(stored: StoredObject): Buffer {
  if (stored.body) return stored.body;
  if (stored.head) return stored.head;
  return Buffer.alloc(Math.max(0, stored.bytes));
}

/**
 * Every `getSignedUrl` the stub has answered, in call order.
 *
 * The URL string alone cannot say what was signed: the disposition, the expiry
 * and the pinned generation are all in the config rather than in the returned
 * href. A spec that asserted only the href would pass whether or not the route
 * pinned anything, which is the whole point of pinning.
 */
export interface SignedUrlCall {
  path: string;
  /** The generation the FILE HANDLE was pinned to, or null for "whatever is there". */
  generation: string | null;
  config: Record<string, unknown>;
}

/**
 * Every read the code under test asked for, how wide it was, and HOW.
 *
 * A signing document is a range of bytes in storage, never an object in the
 * process, and `kind` is the only thing that can show it. `download` answers a
 * Buffer, so the whole range it names is resident at once: that is the shape
 * that puts a 500 MB scan in a 512 MiB container. `stream` hands out chunks, so
 * even a read covering the entire object costs one chunk at a time.
 *
 * Width alone cannot tell them apart, and on a small fixture it is actively
 * misleading: a bounded window is wider than the whole document, so a correct
 * streamed read and a whole-file buffer look identical.
 */
export interface ObjectRead {
  path: string;
  start: number;
  end: number;
  kind: 'download' | 'stream';
  whole: boolean;
}

export const objectReads: ObjectRead[] = [];

export const signedUrlCalls: SignedUrlCall[] = [];

/** The `File` operations the files module actually calls. */
export function fakeFile(path: string, fileOptions: any = {}): Record<string, unknown> {
  // `bucket.file(path, { generation })` is how the real client pins a read to
  // one version of an object: the handle carries the generation, and every
  // request it makes names it. A double that dropped it would let a test of
  // "the replaced object is refused" pass without the pin existing.
  const pinnedGeneration = fileOptions?.generation === undefined || fileOptions?.generation === null
    ? null
    : String(fileOptions.generation);

  return {
    name: path,
    generation: pinnedGeneration,
    // A LISTED object arrives with its metadata already populated, which is what
    // the listing readers and the folder-delete loop read instead of paying for
    // a metadata round-trip per object.
    get metadata() { return objects.has(path) ? metadataOf(path) : undefined; },
    /**
     * Present because the real client's File has it, and because what it
     * RETURNS is what matters: a Promise of `[file, apiResponse]`, not a
     * handle.
     *
     * A double without it turns `handle.get?.(...) ?? handle` into the
     * fallback, so code that mistakes `get()` for a way to pin a generation
     * looks correct here and hands the storage client a Promise in production.
     * That is exactly what `compose.ts` did, and every test passed.
     */
    async get() {
      if (!objects.has(path)) throw notFound();
      return [fakeFile(path, fileOptions), metadataOf(path)];
    },
    exists: async () => [objects.has(path)],
    getMetadata: async () => {
      if (!objects.has(path)) throw notFound();
      return [metadataOf(path)];
    },
    setMetadata: async ({ metadata }: { metadata?: Record<string, unknown> }) => {
      const stored = objects.get(path);
      if (!stored) throw notFound();
      stored.custom = normalizeCustom(metadata);
    },
    save: async (body: string | Buffer, options: any = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'latin1');
      objects.set(path, {
        bytes: bytes.length,
        body: bytes,
        contentType: options?.metadata?.contentType || 'application/octet-stream',
        custom: normalizeCustom(options?.metadata?.metadata),
        generation: nextGeneration(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      });
    },
    /**
     * A ranged STREAM, pinned to a generation.
     *
     * The precondition is honoured rather than ignored, because the signing path
     * relies on it: a document replaced between admission and sealing has to
     * fail here, and a double that returned the new bytes anyway would make
     * every test of that behaviour pass without it working.
     */
    createReadStream: (options: any = {}) => {
      const { Readable } = require('stream');
      const stored = objects.get(path);
      if (!stored) return Readable.from((async function* fail(): any { throw notFound(); })());
      const wanted = pinnedGeneration
        ?? options?.generation ?? options?.preconditionOpts?.ifGenerationMatch;
      if (wanted !== undefined && wanted !== null && String(wanted) !== stored.generation) {
        return Readable.from((async function* stale(): any {
          throw Object.assign(new Error('Precondition Failed'), { code: 412 });
        })());
      }
      const all = bytesOf(stored);
      const start = Number(options.start) || 0;
      const end = Number.isFinite(options.end) ? Number(options.end) : all.length - 1;
      objectReads.push({ path, start, end, kind: 'stream', whole: start === 0 && end === all.length - 1 });
      return Readable.from([all.subarray(start, end + 1)]);
    },
    delete: async () => {
      if (!objects.delete(path)) throw notFound();
    },
    copy: async (destination: { name: string }, options: any = {}) => {
      const stored = objects.get(path);
      if (!stored) throw notFound();
      // The source version, from either spelling the SDK accepts: the handle's
      // own pin, or `sourceGeneration` on the call. Callers use both, and a
      // copy that ignored them would take whatever bytes are there now under a
      // decision made about the ones that were there before.
      const wantedSource = options?.sourceGeneration ?? pinnedGeneration;
      if (wantedSource !== undefined && wantedSource !== null
        && String(wantedSource) !== stored.generation) {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      }
      // Mirrors the real SDK's create-only precondition (see `recordArchive.ts`'s
      // `putArtifact`): with `ifGenerationMatch: 0`, GCS refuses the write
      // atomically when an object already sits at the destination, rather than
      // silently overwriting it. Two racing copies to the same path can then
      // never BOTH land; the loser gets a 412 instead of clobbering the winner.
      if (options?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(destination.name)) {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      }
      // GCS carries custom metadata across a copy BY DEFAULT, which is what lets
      // a rename preserve a file's taskId tag and its portal share state. When
      // the call supplies `metadata`, that REPLACES it on the destination, which
      // is how a copy stamps the new object with who owns it. A double that
      // ignored the supplied metadata would let a route lose a stamp every later
      const supplied = options?.metadata;
      // Real GCS CopyOptions has contentType as top-level and metadata as the custom metadata map.
      // We also handle legacy nested { metadata: { contentType, metadata } } for compatibility.
      const contentType = options?.contentType || supplied?.contentType || stored.contentType;
      const custom = supplied?.metadata
        ? normalizeCustom(supplied.metadata)
        : supplied
          ? normalizeCustom(supplied)
          : { ...stored.custom };
      objects.set(destination.name, {
        ...stored,
        contentType,
        custom,
        generation: nextGeneration(),
      });
    },
    /**
     * A signed read URL, carrying the handle's generation the way the real
     * client does: `getSignedUrl` copies `this.generation` into the query
     * string, so a URL minted from a pinned handle can only ever serve that
     * version. The config is recorded so a spec can assert the disposition and
     * the expiry too, neither of which appears in the href here.
     */
    getSignedUrl: async (config: any = {}) => {
      signedUrlCalls.push({ path, generation: pinnedGeneration, config: { ...config } });
      const query = pinnedGeneration ? `?generation=${pinnedGeneration}` : '';
      return [`https://signed.test/${encodeURIComponent(path)}${query}`];
    },
    /**
     * A streaming write, which is how an archive lands without passing through
     * the process. Resolves to a new object (and a new generation) only when
     * the stream ends cleanly: a stream destroyed partway leaves nothing at the
     * path, so a spec cannot mistake an abandoned transfer for a published one.
     */
    createWriteStream: (options: any = {}) => {
      const { Writable } = require('stream');
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _encoding: string, done: (err?: Error | null) => void) {
          chunks.push(Buffer.from(chunk));
          done();
        },
        final(done: (err?: Error | null) => void) {
          const body = Buffer.concat(chunks);
          objects.set(path, {
            bytes: body.length,
            body,
            contentType: options?.metadata?.contentType || 'application/octet-stream',
            custom: normalizeCustom(options?.metadata?.metadata),
            generation: nextGeneration(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
          });
          done();
        },
      });
    },
    /**
     * Mint a resumable session URL, the way a direct upload opens one.
     *
     * The metadata is REMEMBERED rather than written: a session that already
     * created the object would hide the case every direct-upload route has to
     * handle, which is a session opened and then never PUT to. `landUpload`
     * plays the browser's part and creates it.
     */
    createResumableUpload: async (options: any = {}) => {
      pendingUploads.set(path, {
        contentType: options?.metadata?.contentType || 'application/octet-stream',
        custom: normalizeCustom(options?.metadata?.metadata),
      });
      return [`https://upload.test/session/${encodeURIComponent(path)}`];
    },
    /**
     * A ranged read, which is how an admission check identifies content without
     * pulling the object into the process.
     *
     * Returns the object's own leading bytes when a test supplied them, and
     * zeroes otherwise, so a test that does not care about the sniff does not
     * have to describe one.
     */
    download: async (range: any = {}) => {
      const stored = objects.get(path);
      if (!stored) throw notFound();
      const start = Number(range.start) || 0;
      const end = Number.isFinite(range.end) ? Number(range.end) : stored.bytes - 1;
      objectReads.push({ path, start, end, kind: 'download', whole: start === 0 && end === stored.bytes - 1 });
      return [bytesOf(stored).subarray(start, end + 1)];
    },
  };
}

/**
 * Server-side concatenation, which is how a signed document is assembled.
 *
 * The point of `combine` in the product is that the base never passes through
 * the process, so a double that ignored the sources' generations would let a
 * test of "a part replaced mid-compose fails" pass without it working. Both
 * preconditions are enforced here for that reason.
 */
async function combine(sources: any[], destination: any, options: any = {}): Promise<void> {
  const generations: unknown[] = options?.sourceGenerations || [];
  const parts: Buffer[] = [];
  sources.forEach((handle, i) => {
    const path = String(handle?.name || handle);
    const stored = objects.get(path);
    if (!stored) throw notFound();
    const wanted = generations[i];
    if (wanted !== undefined && wanted !== null && String(wanted) !== stored.generation) {
      throw Object.assign(new Error('Precondition Failed'), { code: 412 });
    }
    parts.push(stored.body ?? Buffer.alloc(stored.bytes));
  });

  const target = String(destination?.name || destination);
  if (options?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(target)) {
    throw Object.assign(new Error('Precondition Failed'), { code: 412 });
  }
  const body = Buffer.concat(parts);
  objects.set(target, {
    bytes: body.length,
    body,
    contentType: options?.contentType || 'application/octet-stream',
    custom: {},
    generation: nextGeneration(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
}

export const inMemoryBucket = {
  name: 'lawfirms',
  file: fakeFile,
  combine,
  getFiles: async ({ prefix = '', maxResults = 1000, pageToken = null }: any = {}) => {
    // Lexicographic and paged, like the real listing: a folder's `.folder`
    // marker sorts ahead of its siblings, which is the order the relocation loop
    // and the page-at-a-time delete both see.
    const matching = Array.from(objects.keys()).filter((key) => key.startsWith(prefix)).sort();
    const start = pageToken ? Number(pageToken) : 0;
    const page = matching.slice(start, start + maxResults);
    const next = start + maxResults < matching.length
      ? { pageToken: String(start + maxResults) }
      : null;
    return [page.map(fakeFile), next];
  },
};

/** Point `admin.storage()` at the map. Call at a spec's MODULE scope. */
export function installInMemoryBucket(): void {
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => inMemoryBucket } as never);
}

/**
 * Play the browser's part: PUT bytes to a session opened at `path`.
 *
 * Carries the content type and the `uploadedBy` stamp the session recorded, so
 * what lands is what the route asked storage to accept. Pass `contentType` or
 * `custom` to model a caller that uploaded something other than what it
 * declared, which is the case the resumable URL cannot prevent.
 */
export function landUpload(
  path: string,
  opts: {
    bytes?: number; contentType?: string; custom?: Record<string, string>;
    head?: Buffer; body?: Buffer;
  } = {},
): void {
  const session = pendingUploads.get(path);
  objects.set(path, {
    bytes: opts.body ? opts.body.length : opts.bytes ?? 1024,
    body: opts.body,
    contentType: opts.contentType ?? session?.contentType ?? 'application/octet-stream',
    custom: { ...(session?.custom || {}), ...(opts.custom || {}) },
    head: opts.head,
    generation: nextGeneration(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
}

/** Put bytes at a path without going through any route. */
export function putObject(
  path: string,
  opts: {
    bytes?: number; contentType?: string; custom?: Record<string, string>; body?: Buffer;
  } = {},
): void {
  objects.set(path, {
    bytes: opts.body ? opts.body.length : opts.bytes ?? 1024,
    body: opts.body,
    contentType: opts.contentType ?? 'application/pdf',
    custom: { ...(opts.custom || {}) },
    generation: nextGeneration(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
}

/** A `.folder` marker, which is how storage records that a folder exists. */
export function putFolderMarker(
  markerPath: string,
  custom: Record<string, string> = {},
): void {
  putObject(markerPath, { bytes: 0, contentType: 'text/plain', custom: { isFolder: 'true', ...custom } });
}

/** Every stored path under a prefix, sorted. */
export const pathsUnder = (prefix: string): string[] =>
  Array.from(objects.keys()).filter((key) => key.startsWith(prefix)).sort();
