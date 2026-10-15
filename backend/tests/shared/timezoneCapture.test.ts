/**
 * Opportunistic timezone capture - unit tests against a fake Postgres pool, no database.
 *
 * `persistTimezone` is fire-and-forget and de-duped in-memory, so the two things
 * worth pinning are: it writes exactly once per actual change (not once per
 * request), and a failed write does not permanently poison the cache for that
 * user - a transient DB blip must not mean their zone never gets stored.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/timezoneCapture.test.js
 */

// An in-memory stand-in for the `user_settings` table, driven by the single
// upsert statement persistTimezone issues. Prefixed `mock` so Jest permits
// referencing it from inside the jest.mock() factory below.
let mockQueries: any;
let mockFailNext = false;

jest.mock('../../src/shared/database/db', () => ({
  pool: {
    query: async (text: any, params: any) => {
      mockQueries.push({ text: typeof text === 'string' ? text : text.text, params });
      if (mockFailNext) {
        mockFailNext = false;
        throw new Error('connection terminated unexpectedly');
      }
      return { rows: [] };
    },
  },
}));

// Lets the fire-and-forget promise chain (the .catch in persistTimezone) settle
// before assertions run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// persistTimezone's de-dupe cache is module-level state, so each test gets a
// fresh module instance - otherwise a zone persisted in one test would make an
// identical call in a later test look like a no-op.
let persistTimezone: any;

beforeEach(() => {
  mockQueries = [];
  mockFailNext = false;
  jest.resetModules();
  ({ persistTimezone } = require('../../src/shared/middleware/timezone'));
});

describe('persistTimezone', () => {
  test('a first call for a user issues a write', async () => {
    persistTimezone('user-a', 'America/New_York');
    await flush();

    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0].text).toMatch(/update users set timezone/);
    // One parameter per placeholder OCCURRENCE, in order of appearance:
    // `set timezone = $2 ... where id = $1 and timezone is distinct from $2`.
    expect(mockQueries[0].params).toEqual([
      'America/New_York',
      'user-a',
      'America/New_York',
    ]);
  });

  test('an immediate repeat call with the same zone issues no second query', async () => {
    persistTimezone('user-a', 'America/New_York');
    await flush();
    persistTimezone('user-a', 'America/New_York');
    await flush();

    expect(mockQueries).toHaveLength(1);
  });

  test('a call with a changed zone issues another query', async () => {
    persistTimezone('user-a', 'America/New_York');
    await flush();
    persistTimezone('user-a', 'America/Los_Angeles');
    await flush();

    expect(mockQueries).toHaveLength(2);
    expect(mockQueries[1].params).toEqual([
      'America/Los_Angeles',
      'user-a',
      'America/Los_Angeles',
    ]);
  });

  test('a missing userId is a no-op', async () => {
    persistTimezone(undefined, 'America/New_York');
    persistTimezone(null, 'America/New_York');
    persistTimezone('', 'America/New_York');
    await flush();

    expect(mockQueries).toHaveLength(0);
  });

  test('a missing tz is a no-op', async () => {
    persistTimezone('user-a', undefined);
    persistTimezone('user-a', null);
    persistTimezone('user-a', '');
    await flush();

    expect(mockQueries).toHaveLength(0);
  });

  test('a rejected query clears the cache entry so the next identical call retries', async () => {
    mockFailNext = true;
    persistTimezone('user-b', 'Europe/London');
    await flush();
    expect(mockQueries).toHaveLength(1);

    // Same user, same zone: had the cache entry survived the rejection this
    // would be swallowed as a no-op and the zone would never get stored.
    persistTimezone('user-b', 'Europe/London');
    await flush();

    expect(mockQueries).toHaveLength(2);
    expect(mockQueries[1].params).toEqual([
      'Europe/London',
      'user-b',
      'Europe/London',
    ]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
