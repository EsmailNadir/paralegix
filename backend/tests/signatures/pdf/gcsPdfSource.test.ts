/**
 * Bounded read access to a PDF in storage.
 *
 * This is the floor the whole incremental design stands on: if a source can be
 * read whole, every layer above it is free to do so, and a 2 GB document lands
 * in a 512 MiB container again. So the type offers no whole-file read, and the
 * cases here are mostly about what it REFUSES.
 *
 * The rules that matter, each with what goes wrong without it:
 *
 *   Every read is capped. An uncapped `length` is a whole-file read spelled
 *   differently, and the caller choosing it is exactly the caller that cannot
 *   be trusted with it.
 *
 *   Every read is pinned to one GCS GENERATION. A document replaced while it is
 *   being signed would otherwise be read half from one version and half from the
 *   next, and the signature would cover a file that never existed.
 *
 *   A short read is an error, not a shorter answer. The reader above builds
 *   offsets from what it was told it got; silently returning fewer bytes turns
 *   a truncated fetch into a misparse somewhere else entirely.
 *
 *   Cancellation actually aborts. A signing request that gives up must not leave
 *   a stream pulling a gigabyte in the background.
 */
const createReadStream = jest.fn();
const download = jest.fn();
const getMetadata = jest.fn();
const file = jest.fn(() => ({ createReadStream, download, getMetadata }));
const bucketFn = jest.fn(() => ({ file }));

jest.mock('../../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: bucketFn }) },
}));

import { Readable } from 'stream';
import { openGcsPdfSource, MAX_READ_BYTES } from '../../../src/modules/signatures/pdf/gcsSource';

const REF = { objectPath: 'lawfirmids/f1/objects/doc.pdf', generation: '1730000000000001', sizeBytes: 10_000 };

/** A body of `n` bytes, delivered as one or more chunks. */
const bodyOf = (n: number, chunks = 1) => {
  const size = Math.ceil(n / chunks);
  const parts: Buffer[] = [];
  for (let sent = 0; sent < n; sent += size) parts.push(Buffer.alloc(Math.min(size, n - sent), 0x41));
  return parts;
};

/**
 * Answer ranged reads by honouring the range, the way storage does.
 *
 * `n` overrides the length when a case is about a SHORT read; otherwise the
 * stream serves exactly what the range asks for, so a test about something else
 * is not accidentally also a test about over-delivery.
 */
const willReturn = (n?: number, chunks = 1) => {
  createReadStream.mockImplementation((options: any) => {
    const asked = options.end - options.start + 1;
    return Readable.from(bodyOf(n ?? asked, chunks));
  });
};

/** A stream that never ends, for the cases about giving up partway. */
const willHang = (onClose?: () => void) => {
  createReadStream.mockImplementation(() => {
    const stream = new Readable({ read() {} });
    if (onClose) stream.on('close', onClose);
    return stream;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  willReturn();
});

describe('what it will read', () => {
  it('returns exactly the window asked for', async () => {
    willReturn(64);
    const source = openGcsPdfSource(REF);

    const out = await source.read(10, 64, new AbortController().signal);

    expect(out.length).toBe(64);
    const [[options]] = createReadStream.mock.calls;
    expect(options.start).toBe(10);
    expect(options.end).toBe(73); // inclusive, so start + length - 1
  });

  it('refuses a read larger than the cap', async () => {
    // The cap is the whole point. Without it the caller picks, and a caller that
    // asks for the file size is the case this type exists to prevent.
    const source = openGcsPdfSource(REF);

    await expect(source.read(0, MAX_READ_BYTES + 1, new AbortController().signal))
      .rejects.toThrow(/too large/i);
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('refuses a read that runs past the end of the document', async () => {
    // A `/Length` that overruns the file is how a malformed PDF becomes an
    // unbounded read. Checked before any I/O, against the pinned size.
    const source = openGcsPdfSource(REF);

    await expect(source.read(9_990, 100, new AbortController().signal))
      .rejects.toThrow(/past the end/i);
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('refuses a negative or fractional offset', async () => {
    const source = openGcsPdfSource(REF);
    const signal = new AbortController().signal;

    await expect(source.read(-1, 10, signal)).rejects.toThrow(/offset/i);
    await expect(source.read(1.5, 10, signal)).rejects.toThrow(/offset/i);
    await expect(source.read(0, 0, signal)).rejects.toThrow(/length/i);
  });

  it('offers no way to read the whole document', () => {
    // Asserted structurally, because this is a claim about the SHAPE of the
    // type. A `download()` or `buffer()` here is an invitation every caller
    // above would eventually accept.
    const source = openGcsPdfSource(REF);

    expect((source as any).download).toBeUndefined();
    expect((source as any).buffer).toBeUndefined();
    expect(Object.keys(source).sort()).toEqual(['close', 'read', 'ref', 'stream']);
  });
});

describe('pinning the version', () => {
  it('pins every read to the generation it was opened at', async () => {
    // A document replaced mid-signing would otherwise be read half from one
    // version and half from the next, and the signature would cover a file that
    // never existed.
    const source = openGcsPdfSource(REF);

    await source.read(0, 10, new AbortController().signal);

    expect(bucketFn).toHaveBeenCalled();
    const [[options]] = createReadStream.mock.calls;
    expect(String(options.generation ?? options.preconditionOpts?.ifGenerationMatch))
      .toBe(REF.generation);
  });

  it('keeps the generation as a string', () => {
    // A GCS generation is 64-bit. Coerced to a JS number it rounds past 2^53,
    // so two different versions of an object compare equal.
    const source = openGcsPdfSource(REF);

    expect(typeof source.ref.generation).toBe('string');
    expect(source.ref.generation).toBe(REF.generation);
  });

  it('fails when the object has been replaced', async () => {
    createReadStream.mockImplementation(() => {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(Object.assign(new Error('Precondition Failed'), { code: 412 })));
      return stream;
    });
    const source = openGcsPdfSource(REF);

    await expect(source.read(0, 10, new AbortController().signal))
      .rejects.toThrow(/changed while it was being read/i);
  });
});

describe('short and failed reads', () => {
  it('treats fewer bytes than asked for as an error', async () => {
    // The reader above builds offsets from what it was told it got. A silently
    // short answer turns a truncated fetch into a misparse somewhere else.
    willReturn(30);
    const source = openGcsPdfSource(REF);

    await expect(source.read(0, 64, new AbortController().signal))
      .rejects.toThrow(/short read/i);
  });

  it('joins chunks into one window', async () => {
    // A ranged read arrives in pieces. Returning the first chunk would be a
    // short read that happens to look like data.
    willReturn(64, 5);
    const source = openGcsPdfSource(REF);

    expect((await source.read(0, 64, new AbortController().signal)).length).toBe(64);
  });

  it('reports a missing object as missing', async () => {
    createReadStream.mockImplementation(() => {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(Object.assign(new Error('No such object'), { code: 404 })));
      return stream;
    });
    const source = openGcsPdfSource(REF);

    await expect(source.read(0, 10, new AbortController().signal)).rejects.toThrow(/not found/i);
  });
});

describe('cancellation', () => {
  it('aborts an in-flight read', async () => {
    // A signing request that gives up must not leave a stream pulling a
    // gigabyte in the background.
    let destroyed = false;
    willHang(() => { destroyed = true; });
    const controller = new AbortController();
    const source = openGcsPdfSource(REF);

    const pending = source.read(0, 10, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(destroyed).toBe(true);
  });

  it('refuses a read on an already-cancelled signal without any I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = openGcsPdfSource(REF);

    await expect(source.read(0, 10, controller.signal)).rejects.toThrow(/cancelled/i);
    expect(createReadStream).not.toHaveBeenCalled();
  });
});

describe('streaming a range', () => {
  it('yields the range in chunks without holding it', async () => {
    willReturn(300, 3);
    const source = openGcsPdfSource(REF);

    const sizes: number[] = [];
    for await (const chunk of source.stream(0, 300, new AbortController().signal)) {
      sizes.push(chunk.length);
    }

    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('refuses a range past the end of the document', async () => {
    const source = openGcsPdfSource(REF);
    const iterate = async () => {
      // eslint-disable-next-line no-empty
      for await (const _chunk of source.stream(0, 20_000, new AbortController().signal)) { void _chunk; }
    };

    await expect(iterate()).rejects.toThrow(/past the end/i);
  });

  it('stops when the caller stops', async () => {
    // A caller that breaks out of the loop must not leave the stream running.
    let destroyed = false;
    createReadStream.mockImplementation(() => {
      // Never-ending on purpose: a stream that had already finished would report
      // "closed" whether or not breaking out of the loop did anything.
      const stream = new Readable({
        read() { this.push(Buffer.alloc(100, 0x41)); },
      });
      stream.on('close', () => { destroyed = true; });
      return stream;
    });
    const source = openGcsPdfSource(REF);

    for await (const _chunk of source.stream(0, 300, new AbortController().signal)) break;
    // `close` fires on a later tick than the generator's finally.
    await new Promise((resolve) => setImmediate(resolve));

    expect(destroyed).toBe(true);
  });
});
