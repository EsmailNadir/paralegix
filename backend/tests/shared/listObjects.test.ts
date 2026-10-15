/**
 * Storage prefix paging - pure unit tests against a stub bucket.
 *
 * The portal decides which documents a client can see by scanning a matter's
 * storage prefix and then filtering to the ones shared with them. That order
 * makes the scan's completeness a CORRECTNESS property, not a performance knob:
 * the scan used to stop at the first 500 objects, so a busy matter could drop
 * documents the firm had deliberately shared and the client saw a short list with
 * nothing indicating anything was missing.
 *
 * These tests pin the part that decides it — that paging follows the page token
 * to the end, and that the one remaining bound announces itself instead of
 * silently returning a partial answer.
 *
 * No bucket and no network: `bucket` is a parameter, so a stub stands in.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/listObjects.test.js
 */

const {
  forEachObjectPage,
  listObjectsWithMeta,
  DEFAULT_CEILING,
  NO_CEILING,
} = require('../../src/shared/storage/listObjects');

/**
 * A bucket whose listing spans `total` objects, handed out `pageSize` at a time
 * exactly like GCS: each response carries the next page token, and the last
 * carries none. Records every call so the tests can assert how it was walked.
 */
function stubBucket(total: any, { pageSize = 1000 } = {}) {
  const calls: any = [];
  return {
    calls,
    async getFiles({ prefix, maxResults, pageToken }: any) {
      calls.push({ prefix, maxResults, pageToken });
      const start = pageToken ? Number(pageToken) : 0;
      const size = Math.min(maxResults || pageSize, pageSize);
      const end = Math.min(start + size, total);
      const files = [];
      for (let i = start; i < end; i += 1) files.push({ name: `${prefix}object-${i}` });
      const nextQuery = end < total ? { pageToken: String(end) } : null;
      return [files, nextQuery];
    },
  };
}

describe('listObjectsWithMeta', () => {
  // A bare array cannot express "the scan stopped early", so a listing route
  // built on one presented a partial result as a complete one. These pin the
  // shape that lets a caller tell the difference.

  test('returns the objects alongside a completeness verdict', async () => {
    const bucket = stubBucket(2500, { pageSize: 1000 });
    const result = await listObjectsWithMeta(bucket, 'p/');

    expect(result.objects).toHaveLength(2500);
    expect(result.objects[0].name).toBe('p/object-0');
    expect(result.objects[2499].name).toBe('p/object-2499');
    expect(result.scanned).toBe(2500);
    expect(result.truncated).toBe(false);
  });

  test('reports truncation when the scan gives up at the ceiling', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = stubBucket(5000, { pageSize: 1000 });

    const result = await listObjectsWithMeta(bucket, 'p/', { ceiling: 2000 });

    expect(result.truncated).toBe(true);
    // The objects it did reach are still returned: a short list is better than
    // no list, as long as the caller is told it is short.
    expect(result.objects.length).toBeGreaterThanOrEqual(2000);
    warn.mockRestore();
  });

  test('an empty prefix is complete, not truncated', async () => {
    const bucket = stubBucket(0);
    expect(await listObjectsWithMeta(bucket, 'p/')).toEqual({ objects: [], scanned: 0, truncated: false });
  });
});
describe('forEachObjectPage', () => {
  test('streams pages in order and reports how many it scanned', async () => {
    const bucket = stubBucket(2500, { pageSize: 1000 });
    const pageSizes: any = [];

    const result = await forEachObjectPage(bucket, 'p/', (files: any) => {
      pageSizes.push(files.length);
    });

    expect(pageSizes).toEqual([1000, 1000, 500]);
    expect(result).toEqual({ scanned: 2500, truncated: false });
  });

  test('follows the page token rather than re-reading page one', async () => {
    // The exact failure that hid shared documents: stopping after page one.
    const bucket = stubBucket(2500, { pageSize: 1000 });
    await forEachObjectPage(bucket, 'p/', () => {});

    expect(bucket.calls.map((c: any) => c.pageToken)).toEqual([null, '1000', '2000']);
  });

  test('a prefix whose size lands exactly on a page boundary is not cut short', async () => {
    // The off-by-one that would drop the tail: a full last page still carries a
    // token in some implementations, so the loop must be driven by the token.
    const bucket = stubBucket(2000, { pageSize: 1000 });
    const pageSizes: any = [];

    const result = await forEachObjectPage(bucket, 'p/', (files: any) => { pageSizes.push(files.length); });

    expect(pageSizes).toEqual([1000, 1000]);
    expect(result).toEqual({ scanned: 2000, truncated: false });
  });

  test('awaits an async page handler before fetching the next page', async () => {
    // Callers move/delete objects per page; overlapping pages would let a later
    // page's work start against a half-mutated prefix.
    const bucket = stubBucket(2000, { pageSize: 1000 });
    let inFlight = 0;
    let overlapped = false;

    await forEachObjectPage(bucket, 'p/', async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });

    expect(overlapped).toBe(false);
  });

  test('does not invoke the handler for an empty listing', async () => {
    const bucket = stubBucket(0);
    let called = 0;
    const result = await forEachObjectPage(bucket, 'p/', () => { called += 1; });

    expect(called).toBe(0);
    expect(result).toEqual({ scanned: 0, truncated: false });
  });

  test('stopping at the ceiling is reported, never silent', async () => {
    // The whole point of the rewrite: a bound that truncates has to say so,
    // because a short list that looks complete is the failure being fixed.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = stubBucket(5000, { pageSize: 1000 });

    const result = await forEachObjectPage(bucket, 'p/', () => {}, { ceiling: 2000 });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBeGreaterThanOrEqual(2000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a listing that ends exactly at the ceiling is complete, not truncated', async () => {
    // No further page token means there was nothing more, so this is a finished
    // scan rather than one that gave up.
    const bucket = stubBucket(2000, { pageSize: 1000 });
    const result = await forEachObjectPage(bucket, 'p/', () => {}, { ceiling: 2000 });

    expect(result).toEqual({ scanned: 2000, truncated: false });
  });

  test('the default ceiling is far above any realistic prefix', () => {
    // If this ever needs lowering, the truncation signal above is what keeps it
    // honest; the default itself should never be the thing bounding real use.
    expect(DEFAULT_CEILING).toBeGreaterThanOrEqual(25000);
  });
});
describe('NO_CEILING', () => {
  // The storage recount, the admin recount, the cascade delete and the templates
  // GC sweep all have to reach the end of their prefix to be correct at all: a
  // short count is written back as the firm's authoritative usage, and a short
  // sweep leaves objects behind that nothing references. They opt out of the
  // ceiling explicitly, so these pin that the opt-out actually walks to the end.

  test('walks past the default ceiling instead of giving up on it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = stubBucket(DEFAULT_CEILING + 3000, { pageSize: 1000 });

    const result = await forEachObjectPage(bucket, 'p/', () => {}, { ceiling: NO_CEILING });

    expect(result.scanned).toBe(DEFAULT_CEILING + 3000);
    expect(result.truncated).toBe(false);
    // Nothing was cut short, so there is nothing to warn about.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('the same prefix under the default ceiling does stop short', async () => {
    // The control for the test above: without the opt-out this prefix truncates,
    // so the pass above is the ceiling being lifted rather than a small fixture.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = stubBucket(DEFAULT_CEILING + 3000, { pageSize: 1000 });

    expect((await forEachObjectPage(bucket, 'p/', () => {})).truncated).toBe(true);
    warn.mockRestore();
  });

  test('every object is handed to the page handler, not just counted', async () => {
    const bucket = stubBucket(DEFAULT_CEILING + 1, { pageSize: 1000 });
    const seen: any = [];

    await forEachObjectPage(bucket, 'p/', (files: any) => {
      for (const f of files) seen.push(f.name);
    }, { ceiling: NO_CEILING });

    expect(seen).toHaveLength(DEFAULT_CEILING + 1);
    expect(seen[seen.length - 1]).toBe(`p/object-${DEFAULT_CEILING}`);
  });
});
// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
