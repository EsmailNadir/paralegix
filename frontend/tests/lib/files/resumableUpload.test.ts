/**
 * The browser's half of a GCS resumable upload, against a scripted transport.
 *
 * Nothing here touches XMLHttpRequest. The transport is a function the test
 * hands in, so every case states exactly what GCS answered and asserts exactly
 * what the client sent next. That is the whole value: the protocol has a few
 * rules (chunks carry Content-Range, a 308's Range is where to continue from, a
 * failure is followed by a status query, a 4xx on the session is final) and
 * each one, broken, produces an upload that LOOKS fine on a good connection.
 */
import {
  uploadResumable,
  UploadSessionGoneError,
  UploadStorageError,
  UploadCancelledError,
  type ChunkTransport,
  type ChunkPutResult,
} from '@/lib/files/resumableUpload';

/** One request the fake transport saw. */
interface Sent {
  url: string;
  headers: Record<string, string>;
  /** Byte length of the body, or null for the status query. */
  bodySize: number | null;
}

/** What the fake answers next, in order. `'network'` rejects like a dropped connection. */
type Reply = ChunkPutResult | 'network';

function scripted(replies: Reply[]) {
  const sent: Sent[] = [];
  const transport: ChunkTransport = {
    async put({ url, body, headers, onProgress }) {
      sent.push({ url, headers, bodySize: body ? body.size : null });
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`transport: no reply scripted for request #${sent.length}`);
      if (reply === 'network') throw new Error('Network error during upload');
      // A chunk that the server accepted was also fully sent, so the last
      // progress event a real XHR emits is the whole body.
      if (body && onProgress) onProgress(body.size);
      return reply;
    },
  };
  return { transport, sent, remaining: () => replies.length };
}

const ok = (): ChunkPutResult => ({ status: 200, rangeHeader: null });
const incomplete = (lastPersisted: number): ChunkPutResult =>
  ({ status: 308, rangeHeader: `bytes=0-${lastPersisted}` });
const incompleteEmpty = (): ChunkPutResult => ({ status: 308, rangeHeader: null });
const gone = (status: number): ChunkPutResult => ({ status, rangeHeader: null });
const serverError = (): ChunkPutResult => ({ status: 503, rangeHeader: null });

const URL_ = 'https://storage.googleapis.com/upload/session-1';
const noSleep = async () => {};

const fileOf = (bytes: number) => new Blob(['x'.repeat(bytes)], { type: 'application/pdf' });

describe('chunking', () => {
  it('sends the whole file as one chunk when it fits', async () => {
    const { transport, sent } = scripted([ok()]);

    await uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 1024, transport, sleep: noSleep,
    });

    expect(sent).toEqual([{
      url: URL_,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-3/4' },
      bodySize: 4,
    }]);
  });

  it('splits a larger file into chunkSize pieces, each carrying its byte range', async () => {
    const { transport, sent } = scripted([incomplete(3), incomplete(7), ok()]);

    await uploadResumable({
      file: fileOf(10), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep,
    });

    expect(sent.map((s) => s.headers['Content-Range'])).toEqual([
      'bytes 0-3/10',
      'bytes 4-7/10',
      'bytes 8-9/10',
    ]);
    expect(sent.map((s) => s.bodySize)).toEqual([4, 4, 2]);
  });

  it('continues from the byte the SERVER says it persisted, not the one it was sent', async () => {
    // Sent 0-3, server kept only 0-1. The next chunk must start at 2, or the
    // object ends up with a two-byte hole and a plausible size.
    const { transport, sent } = scripted([incomplete(1), ok()]);

    await uploadResumable({
      file: fileOf(6), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep,
    });

    expect(sent[1].headers['Content-Range']).toBe('bytes 2-5/6');
    expect(sent[1].bodySize).toBe(4);
  });

  it('uploads an empty file as a single zero-length PUT', async () => {
    const { transport, sent } = scripted([ok()]);

    await uploadResumable({
      file: fileOf(0), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep,
    });

    expect(sent).toEqual([{
      url: URL_,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes */0' },
      bodySize: 0,
    }]);
  });
});

describe('progress', () => {
  it('reports persisted bytes, ending exactly at the file size once', async () => {
    const { transport } = scripted([incomplete(3), ok()]);
    const seen: number[] = [];

    await uploadResumable({
      file: fileOf(6), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, onBytes: (n) => seen.push(n),
    });

    // Only what the server confirmed: 4 from the first chunk's 308, then 6 at
    // completion. The bytes XHR reports as SENT are deliberately not here,
    // because a retry resends them and the bar would run ahead of storage and
    // then jump backwards.
    expect(seen).toEqual([4, 6]);
    expect(Math.max(...seen)).toBe(6);
  });

  it('reports NOTHING for a 308 that confirmed no bytes', async () => {
    // Two chunks are sent and the server answers 308 with no Range to both,
    // which means it kept nothing of either. The old code read the missing
    // Range as "the chunk landed" and credited the end of the chunk, so the bar
    // showed half the file stored while storage held none of it, and the object
    // it eventually reported as uploaded had a hole where those bytes were.
    const { transport } = scripted([incompleteEmpty(), incompleteEmpty(), ok()]);
    const seen: number[] = [];

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [0, 0], sleep: noSleep,
      onBytes: (n) => seen.push(n),
    });

    // Only the terminal 200 is a confirmation here. Restoring `|| end` on the
    // persisted offset makes this report 4 first, which is the mutation.
    expect(seen).toEqual([8]);
  });
});

describe('recovering from a failure', () => {
  it('sleeps, asks GCS where it got to, and continues from there', async () => {
    const { transport, sent } = scripted([
      'network',          // chunk 0-3 dies
      incomplete(1),      // status query: server has 0-1
      incomplete(5),      // chunk 2-5 lands
      ok(),               // chunk 6-7 lands
    ]);
    const slept: number[] = [];

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [250, 500], sleep: async (ms) => { slept.push(ms); },
    });

    expect(slept).toEqual([250]);
    expect(sent[1]).toEqual({
      url: URL_,
      headers: { 'Content-Range': 'bytes */8' },
      bodySize: null,
    });
    expect(sent[2].headers['Content-Range']).toBe('bytes 2-5/8');
    expect(sent[3].headers['Content-Range']).toBe('bytes 6-7/8');
  });

  it('treats a 5xx like a dropped connection', async () => {
    const { transport, sent } = scripted([serverError(), incompleteEmpty(), ok()]);

    await uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [0], sleep: noSleep,
    });

    // Nothing persisted, so the retry starts over at byte 0.
    expect(sent[2].headers['Content-Range']).toBe('bytes 0-3/4');
  });

  it('backs off through every delay, then gives up with a storage error', async () => {
    const { transport, sent } = scripted([
      'network', incompleteEmpty(),   // attempt 1 fails, query says 0
      'network', incompleteEmpty(),   // attempt 2 fails, query says 0
      'network',                      // attempt 3 fails: delays exhausted
    ]);
    const slept: number[] = [];

    await expect(uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [10, 20], sleep: async (ms) => { slept.push(ms); },
    })).rejects.toBeInstanceOf(UploadStorageError);

    expect(slept).toEqual([10, 20]);
    expect(sent).toHaveLength(5);
  });

  it('gives up immediately, with no retry, when the session itself is gone', async () => {
    for (const status of [400, 403, 404, 410]) {
      const { transport, sent } = scripted([gone(status)]);
      const slept: number[] = [];

      await expect(uploadResumable({
        file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
        chunkSize: 4, transport, retryDelaysMs: [10], sleep: async (ms) => { slept.push(ms); },
      })).rejects.toBeInstanceOf(UploadSessionGoneError);

      // A dead session does not come back. Retrying it burns the backoff
      // budget for nothing and delays the message that tells the user to retry.
      expect(slept).toEqual([]);
      expect(sent).toHaveLength(1);
    }
  });

  it('gives up when the status query itself reports the session gone', async () => {
    const { transport } = scripted(['network', gone(404)]);

    await expect(uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [0], sleep: noSleep,
    })).rejects.toBeInstanceOf(UploadSessionGoneError);
  });
});

describe('a 308 that confirms nothing', () => {
  it('does not treat a missing Range as a completed chunk', async () => {
    // GCS answers 308 with no Range when it persisted NOTHING. Reading that as
    // "the chunk landed" skips those bytes forever: the upload reports success
    // and the stored object has a hole in it.
    const { transport, sent } = scripted([incompleteEmpty(), incomplete(3), ok()]);

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [0, 0], sleep: noSleep,
    });

    // The rule, not one recovery strategy: after a 308 that confirmed nothing,
    // the next data PUT must start at byte 0 again. Reading the empty Range as
    // "the chunk landed" would send 4-7 next and leave bytes 0-3 missing from
    // an object whose size still looks right.
    const data = sent.filter((x) => !/^bytes \*\//.test(x.headers['Content-Range']));
    expect(data[1].headers['Content-Range']).toBe('bytes 0-3/8');
  });

  it('counts repeated no-progress replies against the retry budget', async () => {
    // Otherwise a server that always answers 308 with no Range is an infinite
    // loop that never sends a byte and never fails.
    const { transport } = scripted(Array(40).fill(null).map(() => incompleteEmpty()));

    await expect(uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [0, 0], sleep: noSleep,
    })).rejects.toBeInstanceOf(UploadStorageError);
  });

  it('requires a terminal 200 or 201, not merely reaching the end', async () => {
    // A 308 whose Range covers every byte is still not a finished object. GCS
    // finalizes on 200/201; treating full coverage as done reports success for
    // an object that was never closed.
    const { transport, sent } = scripted([incomplete(7), ok()]);

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 8, transport, retryDelaysMs: [0], sleep: noSleep,
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ url: URL_, headers: { 'Content-Range': 'bytes */8' }, bodySize: null });
  });
});

describe('the opening status query', () => {
  it('retries a transient failure instead of failing the upload', async () => {
    // The initial query for a recalled session sat outside the retry loop, so
    // one blip on the first request threw away a resumable upload.
    const { transport, sent } = scripted(['network', incomplete(3), ok()]);
    const slept: number[] = [];

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, startOffset: 'query',
      retryDelaysMs: [7], sleep: async (ms) => { slept.push(ms); },
    });

    expect(slept).toEqual([7]);
    expect(sent[2].headers['Content-Range']).toBe('bytes 4-7/8');
  });

  it('retries a 5xx on the opening query rather than failing the upload', async () => {
    // A 503 from the storage front end is the same situation as a dropped
    // connection and is at least as common: GCS sheds load that way. Failing
    // outright here discards a session holding gigabytes GCS still has.
    const { transport, sent } = scripted([serverError(), incomplete(3), ok()]);
    const slept: number[] = [];

    await uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, startOffset: 'query',
      retryDelaysMs: [7], sleep: async (ms) => { slept.push(ms); },
    });

    expect(slept).toEqual([7]);
    // Both of the first two requests are status queries: the retry asks again
    // rather than guessing an offset from a reply that carried none.
    expect(sent.slice(0, 2).map((s) => s.headers['Content-Range'])).toEqual([
      'bytes */8', 'bytes */8',
    ]);
    expect(sent[2].headers['Content-Range']).toBe('bytes 4-7/8');
  });

  it('gives up with a storage error when the opening query never succeeds', async () => {
    const { transport } = scripted([serverError(), serverError(), serverError()]);

    // The budget is shared with the data PUTs, so a session that can never be
    // queried ends as a storage failure instead of retrying forever.
    await expect(uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, startOffset: 'query', retryDelaysMs: [0, 0], sleep: noSleep,
    })).rejects.toBeInstanceOf(UploadStorageError);
  });

  it('still gives up on a dead session during the opening query', async () => {
    const { transport } = scripted([gone(410)]);

    await expect(uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, startOffset: 'query', retryDelaysMs: [0], sleep: noSleep,
    })).rejects.toBeInstanceOf(UploadSessionGoneError);
  });
});

describe('progress never runs ahead of storage', () => {
  it('reports only bytes the server confirmed', async () => {
    // XHR progress says what left the browser. A retry resends, so treating
    // sent bytes as persisted lets the bar advance past what GCS actually has,
    // and it can go backwards on the next 308.
    const { transport } = scripted([incomplete(1), ok()]);
    const seen: number[] = [];

    await uploadResumable({
      file: fileOf(6), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, onBytes: (n) => seen.push(n),
    });

    // Sent 4 bytes, server kept 2. Nothing may report more than 2 until the
    // next confirmation, and the sequence must never decrease.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBe(6);
    expect(seen.filter((n) => n === 4)).toHaveLength(0);
  });
});

describe('resuming a session opened earlier', () => {
  it('starts with a status query and continues from its answer', async () => {
    const { transport, sent } = scripted([incomplete(3), ok()]);

    await uploadResumable({
      file: fileOf(6), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, startOffset: 'query',
    });

    expect(sent[0]).toEqual({ url: URL_, headers: { 'Content-Range': 'bytes */6' }, bodySize: null });
    expect(sent[1].headers['Content-Range']).toBe('bytes 4-5/6');
  });

  it('sends nothing more when the query says the object is already complete', async () => {
    const { transport, sent } = scripted([ok()]);
    const seen: number[] = [];

    await uploadResumable({
      file: fileOf(6), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, startOffset: 'query', onBytes: (n) => seen.push(n),
    });

    expect(sent).toHaveLength(1);
    expect(seen).toEqual([6]);
  });
});

describe('cancelling an upload in progress', () => {
  it('refuses to send anything for a signal already aborted', async () => {
    const { transport, sent } = scripted([]);
    const controller = new AbortController();
    controller.abort();

    await expect(uploadResumable({
      file: fileOf(8), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, signal: controller.signal,
    })).rejects.toBeInstanceOf(UploadCancelledError);

    // The user closed the modal or picked a different file before the first
    // chunk left. Sending it anyway spends their uplink on an object nothing
    // will finalize.
    expect(sent).toHaveLength(0);
  });

  it('stops between chunks once cancelled, leaving the rest unsent', async () => {
    const controller = new AbortController();
    const { transport, sent } = scripted([incomplete(3), incomplete(7), ok()]);

    await expect(uploadResumable({
      file: fileOf(12), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport: {
        async put(args) {
          const reply = await transport.put(args);
          controller.abort();
          return reply;
        },
      },
      sleep: noSleep, signal: controller.signal,
    })).rejects.toBeInstanceOf(UploadCancelledError);

    // One chunk was already in flight when the user cancelled and cannot be
    // recalled; the point is that the remaining two never start.
    expect(sent).toHaveLength(1);
  });

  it('hands the signal to the transport so a chunk in flight is aborted', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const transport: ChunkTransport = {
      async put({ signal }) {
        seen.push(signal);
        return ok();
      },
    };

    await uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, sleep: noSleep, signal: controller.signal,
    });

    // Stopping between chunks is not enough on its own: a 32 MiB chunk on a slow
    // link is minutes during which "cancel" would appear to do nothing.
    expect(seen).toEqual([controller.signal]);
  });

  it('reports cancellation rather than retrying the abort as a failure', async () => {
    const controller = new AbortController();
    const transport: ChunkTransport = {
      async put() {
        controller.abort();
        throw new Error('Upload was aborted');
      },
    };
    const slept: number[] = [];

    await expect(uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [10, 20],
      sleep: async (ms) => { slept.push(ms); }, signal: controller.signal,
    })).rejects.toBeInstanceOf(UploadCancelledError);

    // A transport abort looks exactly like a dropped connection. Treated as one
    // it burns the whole backoff schedule re-sending a file the user cancelled,
    // and then reports a storage failure for something nothing went wrong with.
    expect(slept).toEqual([]);
  });
});

describe('cancelling during a retry backoff', () => {
  /** What the upload settled to within `ms`, or 'still waiting'. */
  const settledWithin = (work: Promise<unknown>, ms: number) => Promise.race([
    work.then(() => 'resolved', (error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);

  it('stops waiting out the delay the moment the user cancels', async () => {
    const controller = new AbortController();
    const { transport, sent } = scripted([serverError()]);
    const slept: number[] = [];

    const upload = uploadResumable({
      file: fileOf(4), sessionUrl: URL_, contentType: 'application/pdf',
      chunkSize: 4, transport, retryDelaysMs: [30000],
      // A delay that never ends on its own, like the real 30 second step of the
      // schedule seen from inside a test.
      sleep: (ms) => { slept.push(ms); return new Promise<void>(() => {}); },
      signal: controller.signal,
    });
    upload.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(slept).toEqual([30000]);

    controller.abort();

    // The backoff is up to 30 seconds. A cancel that waited it out would leave
    // the bar and its cancel control on screen doing nothing for that long.
    expect(await settledWithin(upload, 100)).toBeInstanceOf(UploadCancelledError);
    expect(sent).toHaveLength(1);
  });
});
