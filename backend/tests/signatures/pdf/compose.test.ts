/**
 * Assembling the signed document in storage rather than in this process.
 *
 * The writer produces a suffix; the finished file is the untouched base plus
 * that suffix. Joining them here would mean reading the base, which is the whole
 * cost the incremental design removes, so storage composes them server-side.
 *
 * Two things this has to get right:
 *
 *   GCS composes at most 32 sources per call, so a longer list folds pairwise.
 *   Appending one at a time instead rewrites the whole accumulated object on
 *   every step, which on a 2 GB base is the difference between one copy and
 *   hundreds.
 *
 *   Every input names a GENERATION. A base replaced between the read and the
 *   compose would otherwise be signed in its new form, carrying a signature
 *   computed over the old one.
 */
const combine = jest.fn();
const getMetadata = jest.fn();
const del = jest.fn();
// `generation` is carried the way the real client carries it: on the handle,
// from the second argument. A mock that dropped that argument reported a
// correctly pinned compose and an unpinned one identically.
//
// `get` is here because the real File has it and because what it ANSWERS is the
// point: a promise, not a handle. Without it, code that mistook `get()` for a
// pinning call took the `?? handle` fallback here and shipped broken.
const file = jest.fn((path: string, options?: { generation?: string }) => ({
  name: path,
  generation: options?.generation,
  getMetadata,
  delete: del,
  get: async () => [{ name: path }, {}],
}));

jest.mock('../../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => ({ combine, file }) }) },
}));

import {
  composeParts,
  MAX_COMPOSE_SOURCES,
  PdfComposeError,
} from '../../../src/modules/signatures/pdf/compose';

const part = (n: number) => ({ objectPath: `part-${n}`, generation: `100${n}` });

beforeEach(() => {
  jest.clearAllMocks();
  combine.mockResolvedValue(undefined);
  getMetadata.mockResolvedValue([{ generation: '9999', size: '2048' }]);
  del.mockResolvedValue(undefined);
});

describe('composing', () => {
  it('joins the parts in storage, never in this process', async () => {
    const result = await composeParts({
      parts: [part(1), part(2)],
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    // No read of any part. A `download` here is the base entering the process,
    // which is what this exists to avoid.
    expect(combine).toHaveBeenCalledTimes(1);
    expect(result.objectPath).toBe('signed/final.pdf');
    expect(result.sizeBytes).toBe(2048);
  });

  it('keeps the composed generation as a string', async () => {
    const result = await composeParts({
      parts: [part(1), part(2)],
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    // A 64-bit generation coerced to a JS number rounds past 2^53, so two
    // versions of the signed document would compare equal.
    expect(typeof result.generation).toBe('string');
  });

  it('pins every source generation', async () => {
    // A base replaced between the read and the compose would otherwise be
    // signed in its new form, under a signature computed over the old one.
    await composeParts({
      parts: [part(1), part(2)],
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    const [, , options] = combine.mock.calls[0];
    expect(options.sourceGenerations).toEqual(['1001', '1002']);
  });

  it('hands storage FILE HANDLES carrying the generation, never a promise', async () => {
    // `sourceGenerations` above is built from the parts, so it is right even
    // when the handles beside it are wrong. The handles are what the client
    // reads the bytes through.
    //
    // `file.get({ generation })` is not how a handle is pinned: it is a
    // metadata FETCH that answers a promise. Passing that promise to `combine`
    // sends a body the storage service cannot parse, and every compose against
    // real storage fails. The way to pin one is `bucket.file(path, { generation })`.
    await composeParts({
      parts: [part(1), part(2)],
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    const [sources] = combine.mock.calls[0];
    for (const handle of sources as any[]) {
      expect(typeof handle?.then).not.toBe('function');
      expect(handle?.name).toEqual(expect.any(String));
    }
    expect((sources as any[]).map((handle) => handle.generation)).toEqual(['1001', '1002']);
  });

  it('refuses to overwrite the destination', async () => {
    // A retried attempt must fail rather than clobber a document the first
    // attempt already produced.
    await composeParts({
      parts: [part(1), part(2)],
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    const [, , options] = combine.mock.calls[0];
    expect(options.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
  });
});

describe('more parts than one call takes', () => {
  it('folds pairwise instead of appending one at a time', async () => {
    // Sequential appends rewrite the whole accumulated object every step. On a
    // large base that is hundreds of copies of the document.
    const parts = Array.from({ length: MAX_COMPOSE_SOURCES + 5 }, (_, i) => part(i));

    await composeParts({
      parts,
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    // One call per full group, then one final call. Far fewer than one per part.
    expect(combine.mock.calls.length).toBeLessThan(parts.length);
    for (const [sources] of combine.mock.calls) {
      expect(sources.length).toBeLessThanOrEqual(MAX_COMPOSE_SOURCES);
    }
  });

  it('cleans up its intermediates', async () => {
    const parts = Array.from({ length: MAX_COMPOSE_SOURCES + 5 }, (_, i) => part(i));

    await composeParts({
      parts,
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    });

    expect(del).toHaveBeenCalled();
  });

  it('cleans up its intermediates when the compose FAILS', async () => {
    // A half-composed document left behind is billed storage nobody can
    // identify later.
    const parts = Array.from({ length: MAX_COMPOSE_SOURCES + 5 }, (_, i) => part(i));
    combine.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('storage down'));

    await composeParts({
      parts,
      destination: 'signed/final.pdf',
      scratchPrefix: 'signed/scratch/',
    }).catch(() => {});

    expect(del).toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('refuses an empty part list', async () => {
    await expect(composeParts({ parts: [], destination: 'd', scratchPrefix: 's/' }))
      .rejects.toThrow(PdfComposeError);
  });

  it('refuses a scratch prefix that is not a prefix', async () => {
    // Without the trailing separator the "prefix" is a sibling name, and the
    // cleanup below would delete objects that merely start with the same text.
    await expect(composeParts({ parts: [part(1)], destination: 'd', scratchPrefix: 'scratch' }))
      .rejects.toThrow(/end with/i);
  });
});
