/**
 * The bucket CORS configuration, as a pure unit test.
 *
 * This exists because every failure it catches is silent. A browser cannot read
 * a response header the bucket does not name in `responseHeader`, and it is not
 * told why. Drop `Range` and uploads still start, still send bytes, and still
 * succeed on a good connection. What stops working is RESUMING one: the client
 * has no way to learn how many bytes GCS persisted, so an interrupted upload can
 * only start again from zero. Nothing logs an error. The bug shows up months
 * later as "large uploads fail on bad wifi".
 *
 * The repo has been burned by drift here already. Three definitions of this
 * config existed at once (a tracked `cors.json`, this script, and whatever was
 * applied to the live buckets by hand) and no two agreed.
 *
 * Hits no bucket and no network. Run alone with:
 *
 *   __TEST_TOKEN__=offline npx jest tests/files/gcsCorsConfig.test.ts
 */

const {
  corsConfigFor,
  RESPONSE_HEADERS,
  METHODS,
  TARGETS,
} = require('../../scripts/set-gcs-cors');

describe('resumable upload requirements', () => {
  test('exposes Range, without which an upload can never resume', () => {
    // GCS answers each incomplete chunk with 308 + `Range: bytes=0-N`. Reading N
    // is the entire resume mechanism. Delete 'Range' from RESPONSE_HEADERS and
    // this goes red.
    expect(RESPONSE_HEADERS).toContain('Range');
  });

  test('exposes the headers a ranged read depends on', () => {
    // A viewer that fetches page ranges instead of the whole file needs both:
    // Accept-Ranges to know ranges are served, Content-Range to place the bytes.
    expect(RESPONSE_HEADERS).toContain('Accept-Ranges');
    expect(RESPONSE_HEADERS).toContain('Content-Range');
  });

  test('exposes Content-Disposition, which carries the download filename', () => {
    expect(RESPONSE_HEADERS).toContain('Content-Disposition');
  });

  test('allows PUT, the method the browser uploads with', () => {
    // Removing PUT breaks every direct-to-GCS upload outright, not just resume.
    expect(METHODS).toContain('PUT');
  });
});

describe('per-target bucket and origin pairing', () => {
  test('each target names its own bucket', () => {
    // Crossing these is the dangerous edit: applying staging's origin list to
    // the production bucket locks the real frontend out of every upload.
    expect(corsConfigFor('staging').bucket).toBe('lawfirms-staging');
    expect(corsConfigFor('prod').bucket).toBe('lawfirms');
    expect(corsConfigFor('staging').bucket).not.toBe(corsConfigFor('prod').bucket);
  });

  test('each target allows exactly its own deployed frontend', () => {
    const staging = corsConfigFor('staging').cors[0].origin;
    const prod = corsConfigFor('prod').cors[0].origin;

    expect(staging).toContain('https://staging.paralegix.com');
    expect(staging).not.toContain('https://paralegix.com');

    expect(prod).toContain('https://paralegix.com');
    expect(prod).toContain('https://www.paralegix.com');
    expect(prod).not.toContain('https://staging.paralegix.com');
  });

  test('every target carries the full header and method set', () => {
    // The headers are the point of the config; a target that quietly ships a
    // subset would reintroduce exactly the drift this file guards against.
    for (const name of Object.keys(TARGETS)) {
      const entry = corsConfigFor(name).cors[0];
      expect(entry.responseHeader).toEqual(RESPONSE_HEADERS);
      expect(entry.method).toEqual(METHODS);
      expect(entry.origin.length).toBeGreaterThan(0);
    }
  });

  test('refuses an unknown target rather than defaulting to one', () => {
    // A typo must not silently apply a narrower origin list to a real bucket.
    expect(() => corsConfigFor('production')).toThrow(/Unknown target/);
  });
});
