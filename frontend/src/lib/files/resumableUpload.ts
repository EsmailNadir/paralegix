/**
 * The browser's half of a GCS resumable upload: one file, one session URL,
 * sent in chunks, able to continue after a failure.
 *
 * `POST /upload-init` opens a resumable session per file and hands back its
 * URL. Until now the browser sent the whole file in one PUT to that URL, which
 * meant a dropped connection at 2.9 GB of 3 started again from zero and a
 * closed tab lost everything. The session was resumable; nothing resumed it.
 *
 * The protocol is small. Every chunk is a PUT with `Content-Range:
 * bytes <first>-<last>/<total>`. GCS answers 308 with `Range: bytes=0-N` for
 * every chunk but the last and 200 or 201 when the final byte lands. After a
 * failure, a status query (an empty PUT whose Content-Range names only the
 * total: a star, a slash, the size) asks where it got to, and the answer is the
 * same 308 plus Range. A 400, 403, 404 or 410 means
 * the session is gone and only a fresh `/upload-init` can help.
 *
 * Two things are injected rather than imported: the transport (XMLHttpRequest
 * in the app, a scripted fake in tests) and `sleep`, so the retry schedule can
 * be exercised without waiting through it.
 */

/**
 * 32 MiB. Must be a multiple of 256 KiB except for the final chunk, which GCS
 * requires; 8 MiB is the documented minimum for good throughput. Larger means
 * fewer round trips, smaller means a failure loses less. On a 20 Mbps office
 * uplink one of these takes about 13 seconds, so that is the most a hiccup
 * costs and the coarsest the progress bar ever moves.
 */
export const CHUNK_SIZE = 32 * 1024 * 1024;

/**
 * Backoff between attempts, in order. About a minute of patience in total,
 * which is what a wifi handoff or a laptop waking from sleep needs.
 */
export const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

/** The session URL no longer accepts bytes. Only a fresh session helps. */
export class UploadSessionGoneError extends Error {
  constructor() {
    super('The upload link expired before the file finished. Please try the upload again.');
    this.name = 'UploadSessionGoneError';
  }
}

/**
 * The user stopped this upload.
 *
 * Separate from every other failure because it is not one: nothing went wrong,
 * so it must not be retried, must not spend the backoff schedule, and must not
 * put an error in front of the user for something they asked for.
 */
export class UploadCancelledError extends Error {
  constructor() {
    super('The upload was cancelled.');
    this.name = 'UploadCancelledError';
  }
}

/** Every retry was spent and storage still did not take the bytes. */
export class UploadStorageError extends Error {
  constructor() {
    super('The file could not be uploaded to storage. Please try again.');
    this.name = 'UploadStorageError';
  }
}

/** What one PUT to the session URL came back with. */
export interface ChunkPutResult {
  status: number;
  /** The `Range` response header, or null when GCS sent none. */
  rangeHeader: string | null;
}

/**
 * How bytes reach storage. `body` is null for the status query. `onProgress`
 * reports bytes of THIS body sent so far, and may be called any number of times.
 * Rejects only on a transport failure (dropped connection, abort); any HTTP
 * status, including 5xx, resolves.
 */
export interface ChunkTransport {
  put(args: {
    url: string;
    body: Blob | null;
    headers: Record<string, string>;
    onProgress?: (loaded: number) => void;
    /**
     * Aborts the request in flight. Stopping between chunks is not enough on
     * its own: a 32 MiB chunk on a slow link is minutes during which a cancel
     * would appear to do nothing at all.
     */
    signal?: AbortSignal;
  }): Promise<ChunkPutResult>;
}

export interface UploadResumableOptions {
  file: Blob;
  sessionUrl: string;
  contentType: string;
  /**
   * Bytes GCS has CONFIRMED it holds. Monotonic, and the only honest answer to
   * "how much is safely stored". Anything that decides whether work can be
   * skipped on a retry must use this.
   */
  onBytes?: (persisted: number) => void;
  /**
   * Bytes handed to the network so far, including a chunk still in flight.
   *
   * Separate from `onBytes` on purpose. A retry resends, so this is not a claim
   * about storage, and treating it as one is how a progress bar passes what the
   * server actually has and then jumps backwards. It exists so a bar can still
   * move smoothly inside one chunk, which for a small file is the whole upload.
   * Monotonic: it never reports less than it already has.
   */
  onTransportBytes?: (sent: number) => void;
  /**
   * `0` for a session opened just now. `'query'` for one recalled from an
   * earlier page load, where only GCS knows how far it got.
   */
  startOffset?: number | 'query';
  chunkSize?: number;
  retryDelaysMs?: number[];
  transport?: ChunkTransport;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Stops the upload. Rejects with `UploadCancelledError`, which callers treat
   * as "the user asked for this" rather than as a failure to report.
   */
  signal?: AbortSignal;
}

/** The real transport. XMLHttpRequest rather than fetch for the upload progress event. */
export const xhrTransport: ChunkTransport = {
  put({ url, body, headers, onProgress, signal }) {
    return new Promise<ChunkPutResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      if (signal) {
        if (signal.aborted) {
          reject(new Error('Upload was aborted'));
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      if (onProgress) {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) onProgress(event.loaded);
        });
      }
      xhr.addEventListener('load', () => {
        resolve({ status: xhr.status, rangeHeader: xhr.getResponseHeader('Range') });
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload was aborted')));
      xhr.open('PUT', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.send(body);
    });
  },
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isComplete = (status: number) => status === 200 || status === 201;
const isSessionGone = (status: number) =>
  status === 400 || status === 403 || status === 404 || status === 410;

/**
 * Bytes persisted according to a `Range: bytes=0-N` header. N is inclusive, so
 * the count is N + 1. No header, or one that does not parse, means zero: on a
 * 308 GCS always names what it kept, so silence is "nothing yet".
 */
export function persistedBytesFrom(rangeHeader: string | null): number {
  const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader || '');
  if (!match) return 0;
  return Number(match[2]) + 1;
}

/** Thrown internally for anything worth another attempt. Never escapes. */
class RetryableUploadError extends Error {}

export async function uploadResumable(options: UploadResumableOptions): Promise<void> {
  const {
    file,
    sessionUrl,
    contentType,
    onBytes = () => {},
    onTransportBytes = () => {},
    startOffset = 0,
    chunkSize = CHUNK_SIZE,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    transport = xhrTransport,
    sleep = defaultSleep,
    signal,
  } = options;
  const size = file.size;

  /**
   * Nothing went wrong, so nothing is retried and no delay is spent. Checked
   * before every request rather than only at the start: an upload is minutes
   * long, and that is the whole window in which a user can cancel one.
   */
  const stopIfCancelled = () => {
    if (signal?.aborted) throw new UploadCancelledError();
  };
  stopIfCancelled();

  /**
   * Bytes GCS has confirmed. Progress is reported from this and nothing else.
   *
   * XHR's own progress event says what left the browser, which is not the same
   * claim: a retry resends bytes, so reporting sent bytes lets the bar pass what
   * storage actually holds and then jump backwards when the next 308 corrects
   * it. Only a 308's Range and a terminal 200/201 move this.
   */
  let confirmed = startOffset === 'query' ? 0 : startOffset;
  const confirm = (bytes: number) => {
    if (bytes <= confirmed) return;
    confirmed = bytes;
    onBytes(confirmed);
    reportTransport(confirmed);
  };

  /** Highest byte count shown to the user, which must never move backwards. */
  let displayed = confirmed;
  const reportTransport = (bytes: number) => {
    const next = Math.min(size, bytes);
    if (next <= displayed) return;
    displayed = next;
    onTransportBytes(displayed);
  };

  /**
   * One attempt budget for the whole upload, spent by any failure.
   *
   * The opening status query used to sit outside this, so a single blip on the
   * first request of a resumed upload threw the session away instead of
   * retrying it. A reply that confirms no new bytes counts too: without that, a
   * server answering 308 with no Range forever is an infinite loop that never
   * sends a byte and never fails.
   */
  let failures = 0;
  const spendAttempt = async (): Promise<void> => {
    if (failures >= retryDelaysMs.length) throw new UploadStorageError();
    await sleepUnlessCancelled(retryDelaysMs[failures]);
    failures += 1;
  };

  /**
   * The backoff delay, cut short by a cancel. A step of the schedule is up to
   * 30 seconds, and a cancel that waited it out left the control on screen
   * doing nothing for that long. Raced here rather than inside `sleep` so an
   * injected sleep is cancelled the same way the real one is.
   */
  const sleepUnlessCancelled = (ms: number): Promise<void> => {
    stopIfCancelled();
    if (!signal) return sleep(ms);
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new UploadCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([sleep(ms), aborted]).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  };

  /** Where GCS says the upload stands. Throws SessionGone; Retryable otherwise. */
  const queryOffset = async (): Promise<number | 'complete'> => {
    stopIfCancelled();
    const reply = await transport.put({
      url: sessionUrl,
      body: null,
      headers: { 'Content-Range': `bytes */${size}` },
      signal,
    });
    if (isComplete(reply.status)) return 'complete';
    if (reply.status === 308) return persistedBytesFrom(reply.rangeHeader);
    if (isSessionGone(reply.status)) throw new UploadSessionGoneError();
    throw new RetryableUploadError(`status query answered ${reply.status}`);
  };

  /** A status query that survives a transient failure, spending the shared budget. */
  const queryOffsetWithRetry = async (): Promise<number | 'complete'> => {
    for (;;) {
      try {
        return await queryOffset();
      } catch (err) {
        if (err instanceof UploadSessionGoneError) throw err;
        if (err instanceof UploadCancelledError) throw err;
        stopIfCancelled();
        await spendAttempt();
      }
    }
  };

  // An empty file has no chunk to send. GCS finalizes it from a single PUT
  // whose Content-Range declares the total and nothing else.
  if (size === 0) {
    const reply = await transport.put({
      url: sessionUrl,
      body: new Blob([]),
      headers: { 'Content-Type': contentType, 'Content-Range': 'bytes */0' },
      signal,
    });
    if (isSessionGone(reply.status)) throw new UploadSessionGoneError();
    if (!isComplete(reply.status)) throw new UploadStorageError();
    onBytes(0);
    return;
  }

  if (startOffset === 'query') {
    const at = await queryOffsetWithRetry();
    if (at === 'complete') { onBytes(size); return; }
    confirm(at);
  }

  /**
   * Set only by a terminal 200 or 201.
   *
   * Reaching the last byte is not the same as the object being finalized: GCS
   * can answer 308 with a Range covering everything, and treating that as done
   * reports success for an object it never closed. So the loop ends on the
   * status, and a fully covered file with no terminal reply asks again.
   */
  let finalized = false;

  while (!finalized) {
    stopIfCancelled();
    const offset = confirmed;
    if (offset >= size) {
      // Every byte is accounted for but nothing has finalized the object.
      const at = await queryOffsetWithRetry();
      if (at === 'complete') { finalized = true; break; }
      if (at <= confirmed) await spendAttempt();
      confirm(at);
      continue;
    }

    const end = Math.min(offset + chunkSize, size);
    try {
      const reply = await transport.put({
        url: sessionUrl,
        body: file.slice(offset, end),
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${offset}-${end - 1}/${size}`,
        },
        // Display only. A retry resends these bytes, so they are never treated
        // as persisted; `confirm` is the only thing that moves `confirmed`.
        onProgress: (loaded) => reportTransport(offset + loaded),
        signal,
      });

      if (isComplete(reply.status)) { finalized = true; break; }
      if (isSessionGone(reply.status)) throw new UploadSessionGoneError();
      if (reply.status !== 308) throw new RetryableUploadError(`chunk answered ${reply.status}`);

      // The server's word on what it kept. No Range means it kept NOTHING of
      // this chunk, which is a failed attempt, not a silent success: the old
      // code read that as "the chunk landed" and skipped those bytes forever,
      // producing an object with a hole and a plausible size.
      const persisted = persistedBytesFrom(reply.rangeHeader);
      if (persisted <= confirmed) {
        await spendAttempt();
        continue;
      }
      confirm(persisted);
      failures = 0;
    } catch (err) {
      if (err instanceof UploadSessionGoneError) throw err;
      if (err instanceof UploadCancelledError) throw err;
      // An aborted request is indistinguishable from a dropped connection at
      // the transport. Treated as one it burns the whole backoff schedule
      // resending a file the user cancelled, then reports a storage failure for
      // something that never went wrong.
      stopIfCancelled();
      await spendAttempt();
      const at = await queryOffsetWithRetry();
      if (at === 'complete') { finalized = true; break; }
      confirm(at);
    }
  }

  onBytes(size);
  reportTransport(size);
}
