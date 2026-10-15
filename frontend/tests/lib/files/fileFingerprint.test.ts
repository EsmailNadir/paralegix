/**
 * The content fingerprint that tells two files apart.
 *
 * An upload session is recalled by an identity built from the destination plus
 * the file. Name, size and last-modified are all the file half used to carry,
 * and none of them is content: a document re-exported from a template, or two
 * scans off the same device saved a moment apart, produce the same three values
 * and the second file resumes into the first one's session. What lands is one
 * object with the front of one document and the back of another, at a size that
 * looks entirely correct.
 *
 * So the file half needs a hash of the BYTES. The constraint that shapes every
 * test here is that it must be computed without ever holding the file in
 * memory: these uploads exist because a document can be gigabytes, and
 * `crypto.subtle.digest(await file.arrayBuffer())` allocates all of it at once.
 * The digest is therefore fed a slice at a time, which rules out WebCrypto (it
 * has no incremental digest) and means the hash itself lives here.
 */
import { createSha256Hasher, sha256Hex } from '@/lib/files/sha256';
import {
  fingerprintBlob,
  fingerprintWorkerSource,
  FINGERPRINT_CHUNK_SIZE,
  FINGERPRINT_SAMPLE_WINDOW,
} from '@/lib/files/fileFingerprint';

const utf8 = (text: string) => new TextEncoder().encode(text);

/** jsdom's Blob has no `arrayBuffer()`, which is why the module reads through a
 *  FileReader when one is missing. The fakes here do the same. */
const sliceBytes = (slice: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(slice);
});

/**
 * A blob that records how it was read.
 *
 * `arrayBuffer()` throws, because a whole-file read is the exact failure this
 * module exists to remove. A spec that merely counted slices would still pass
 * if the code also read the whole thing once.
 */
function readSpyBlob(bytes: Uint8Array) {
  const real = new Blob([bytes as unknown as BlobPart]);
  const slices: Array<[number, number]> = [];
  const spy = {
    size: real.size,
    type: '',
    slice(start = 0, end = real.size) {
      slices.push([start, end]);
      return real.slice(start, end);
    },
    arrayBuffer() {
      throw new Error('the whole file was read into memory');
    },
  };
  return { blob: spy as unknown as Blob, slices };
}

describe('the hash itself', () => {
  it('matches the published SHA-256 vectors', () => {
    // Without a fixed vector every other test in this file is self-consistent
    // and wrong together: a broken hash still tells two files apart, and still
    // fails to match the fingerprint the PREVIOUS release stored for the same
    // document, so every resumable session in the wild is silently dropped.
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('gives the same digest however the bytes are split', () => {
    const message = utf8('x'.repeat(1000) + 'tail');
    const whole = sha256Hex(message);

    for (const step of [1, 3, 55, 64, 63, 65, 128, 999]) {
      const hasher = createSha256Hasher();
      for (let at = 0; at < message.length; at += step) {
        hasher.update(message.subarray(at, Math.min(at + step, message.length)));
      }
      // A block-boundary bug shows up only at particular split sizes: 64 is one
      // SHA-256 block, and the padding branch changes at 55 and 56 bytes of
      // remainder. Feeding one message at nine different step sizes is what
      // distinguishes a streaming hasher from one that works on a lucky input.
      expect(hasher.hex()).toBe(whole);
    }
  });

  it('handles a message longer than one length-field block', () => {
    // The length is appended as a 64-bit count of BITS. Anything that treats it
    // as bytes, or as 32 bits, agrees with the real hash right up to 512 MB.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const hasher = createSha256Hasher();
    hasher.update(bytes);

    expect(hasher.hex()).toBe(sha256Hex(bytes));
    expect(hasher.hex()).toHaveLength(64);
  });
});

describe('fingerprinting a blob', () => {
  it('is the SHA-256 of the whole content, in hex', async () => {
    const bytes = utf8('abc');

    expect(await fingerprintBlob(new Blob([bytes as unknown as BlobPart]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('reads the blob only in slices, never as a whole', async () => {
    const bytes = utf8('y'.repeat(50));
    const { blob, slices } = readSpyBlob(bytes);

    // `arrayBuffer()` on the blob itself throws, so this rejects rather than
    // failing an assertion if the implementation ever reaches for the whole
    // file. That is the mutation to try: swap the loop for
    // `crypto.subtle.digest(await blob.arrayBuffer())` and this goes red.
    const digest = await fingerprintBlob(blob, { chunkSize: 8 });

    expect(digest).toBe(sha256Hex(bytes));
    expect(slices).toEqual([
      [0, 8], [8, 16], [16, 24], [24, 32], [32, 40], [40, 48], [48, 50],
    ]);
  });

  it('never holds more than one chunk of a large file at a time', async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    const { blob, slices } = readSpyBlob(bytes);

    await fingerprintBlob(blob, { chunkSize: 64 });

    // The whole point: peak memory is the chunk size, not the file size, so a
    // 2 GB document costs 64 bytes here rather than 2 GB.
    expect(Math.max(...slices.map(([start, end]) => end - start))).toBe(64);
    expect(slices).toHaveLength(Math.ceil(1000 / 64));
  });

  it('fingerprints an empty file without reading anything', async () => {
    const { blob, slices } = readSpyBlob(new Uint8Array(0));

    expect(await fingerprintBlob(blob)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(slices).toEqual([]);
  });

  it('defaults to a chunk far smaller than the files this exists for', () => {
    // A default of "the whole file" would make every other guarantee here
    // vacuous on exactly the uploads that motivated them.
    expect(FINGERPRINT_CHUNK_SIZE).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(FINGERPRINT_CHUNK_SIZE).toBeGreaterThan(0);
  });

  it('tells apart two files with the same name, size and mtime', async () => {
    const a = new Blob([utf8('contract version one ') as unknown as BlobPart]);
    const b = new Blob([utf8('contract version two ') as unknown as BlobPart]);

    // Identical metadata, different bytes. This is the collision the store
    // could not see, and resuming across it splices two documents together.
    expect(a.size).toBe(b.size);
    expect(await fingerprintBlob(a)).not.toBe(await fingerprintBlob(b));
  });
});

/** Bytes that differ at every offset, so a sample is not accidentally all zeros. */
function patterned(size: number, last?: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256;
  if (last !== undefined) bytes[size - 1] = last;
  return bytes;
}

describe('the sample a large file is fingerprinted from', () => {
  // The fingerprint only has to refuse resuming a different file under the same
  // name, size and mtime; the store key already compares those three. Hashing
  // the whole of a 10 GB file for that was a 100 second wait before the first
  // byte could be sent.

  it('reads at most two windows however large the file is', async () => {
    const { blob, slices } = readSpyBlob(patterned(1000));

    await fingerprintBlob(blob, { chunkSize: 16, sampleWindow: 64, createWorker: null });

    const read = slices.reduce((total, [start, end]) => total + (end - start), 0);
    expect(read).toBe(128);
    // The head and the tail: where a re-export or a second scan differs first.
    expect(slices[0][0]).toBe(0);
    expect(slices[slices.length - 1][1]).toBe(1000);
    // Still a chunk at a time inside each window.
    expect(Math.max(...slices.map(([start, end]) => end - start))).toBe(16);
  });

  it('changes when the last byte changes', async () => {
    const options = { sampleWindow: 64, createWorker: null };

    const a = await fingerprintBlob(new Blob([patterned(1000, 1) as unknown as BlobPart]), options);
    const b = await fingerprintBlob(new Blob([patterned(1000, 2) as unknown as BlobPart]), options);

    expect(a).not.toBe(b);
  });

  it('hashes a file no larger than two windows whole, as it always did', async () => {
    const bytes = patterned(100);

    // A session saved by an earlier release carries the whole-content hash. A
    // small file must keep producing that exact digest, or every open session in
    // the wild is refused on its next resume.
    expect(await fingerprintBlob(new Blob([bytes as unknown as BlobPart]), { sampleWindow: 64 }))
      .toBe(sha256Hex(bytes));
  });

  it('samples 8 MiB windows by default', () => {
    expect(FINGERPRINT_SAMPLE_WINDOW).toBe(8 * 1024 * 1024);
  });
});

describe('the worker that runs it off the main thread', () => {
  /** Drive the generated source the way a real Worker global would. */
  function runWorkerSource() {
    const posted: unknown[] = [];
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const fakeSelf = {
      addEventListener(type: string, callback: (event: { data: unknown }) => void) {
        if (type === 'message') listeners.push(callback);
      },
      postMessage(message: unknown) { posted.push(message); },
    };
    new Function('self', fingerprintWorkerSource())(fakeSelf);
    return {
      posted,
      send: (data: unknown) => { for (const l of listeners) l({ data }); },
    };
  }

  /** The worker answers across several FileReader turns, so poll for its reply. */
  async function settle(posted: unknown[]) {
    for (let tick = 0; tick < 200 && posted.length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it('runs standalone, with nothing from the module it was built from', async () => {
    const { posted, send } = runWorkerSource();
    const bytes = utf8('abc');

    send({ id: 7, blob: new Blob([bytes as unknown as BlobPart]), chunkSize: 2 });
    await settle(posted);

    // A worker is loaded as its own script: any reference the source makes to a
    // module-scope binding is a ReferenceError the moment a real upload runs,
    // and nothing in this app would ever have exercised it. Moving the SHA-256
    // constant table to module scope is the mutation that reddens this.
    expect(posted).toEqual([{
      id: 7,
      fingerprint: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    }]);
    expect(send).toBeDefined();
  });

  it('reads the same bounded sample as the in-thread loop', async () => {
    const { posted, send } = runWorkerSource();
    const bytes = patterned(1000);

    send({ id: 9, blob: new Blob([bytes as unknown as BlobPart]), chunkSize: 16, sampleWindow: 64 });
    await settle(posted);

    // Two loops compute this, one per thread. If they disagree, a file
    // fingerprinted with a worker on one visit and without on the next is
    // treated as a different file and its session is thrown away.
    const inThread = await fingerprintBlob(new Blob([bytes as unknown as BlobPart]), {
      chunkSize: 16, sampleWindow: 64, createWorker: null,
    });
    expect(posted).toEqual([{ id: 9, fingerprint: inThread }]);
    expect(inThread).not.toBe(sha256Hex(bytes));
  });

  it('reports a failure back rather than dying silently', async () => {
    const { posted, send } = runWorkerSource();

    send({
      id: 3,
      blob: { size: 4, slice: () => { throw new Error('read failed'); } },
      chunkSize: 2,
    });
    await settle(posted);

    // An unanswered message leaves the caller awaiting forever, which shows up
    // as an upload that never starts and never errors.
    expect(posted).toHaveLength(1);
    expect((posted[0] as { id: number; error: string }).id).toBe(3);
    expect((posted[0] as { id: number; error: string }).error).toMatch(/read failed/);
  });
});

describe('using a worker when the browser has one', () => {
  /** A Worker stand-in that runs the generated source in this thread. */
  function fakeWorkerFactory() {
    const created: unknown[] = [];
    const create = () => {
      const listeners: Array<(event: { data: unknown }) => void> = [];
      const inner = {
        addEventListener(type: string, cb: (event: { data: unknown }) => void) {
          if (type === 'message') listeners.push(cb);
        },
        postMessage(message: { id: number; blob: Blob; chunkSize: number }) {
          void (async () => {
            const hasher = createSha256Hasher();
            for (let at = 0; at < message.blob.size; at += message.chunkSize) {
              const slice = message.blob.slice(at, Math.min(at + message.chunkSize, message.blob.size));
              hasher.update(await sliceBytes(slice));
            }
            for (const l of listeners) l({ data: { id: message.id, fingerprint: hasher.hex() } });
          })();
        },
        terminate() {},
      };
      created.push(inner);
      return inner as unknown as Worker;
    };
    return { create, created };
  }

  it('takes the digest the worker computed', async () => {
    const { create, created } = fakeWorkerFactory();
    const bytes = utf8('abc');

    const digest = await fingerprintBlob(new Blob([bytes as unknown as BlobPart]), {
      chunkSize: 2,
      createWorker: create,
    });

    // The hashing has to leave the main thread, or a multi-gigabyte file
    // freezes the tab for the whole of it. Proving the worker was used means
    // proving the digest CAME from it, not that one was constructed.
    expect(created).toHaveLength(1);
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('falls back to this thread when the browser has no worker', async () => {
    const bytes = utf8('abc');

    // jsdom has no Worker, and neither do some locked-down browsers. The
    // fingerprint is load-bearing for resumption, so it cannot be optional.
    const digest = await fingerprintBlob(new Blob([bytes as unknown as BlobPart]), {
      createWorker: null,
    });

    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('falls back to this thread when the worker cannot be started', async () => {
    const bytes = utf8('abc');

    const digest = await fingerprintBlob(new Blob([bytes as unknown as BlobPart]), {
      createWorker: () => { throw new Error('blob: workers are blocked'); },
    });

    // A CSP that forbids blob: workers must degrade to a slower upload, not to
    // no upload at all.
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
