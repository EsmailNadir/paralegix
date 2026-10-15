/**
 * Portal event ceiling - repository-level test.
 *
 * The portal routes require a client token, which this suite does not have (see
 * portal.test.js, which asserts firm members are blocked). The ceiling lives in
 * SQL, so it is exercised directly against the real database instead.
 *
 * The seeded firm has no matter events of its own, so an assertion against the
 * existing data would be vacuous. This file seeds more client-visible events
 * than the ceiling allows, asserts, and removes them again.
 */

const matterEventsRepo = require('../../../src/modules/matters/matterEvents.repository');
const { pool } = require('../../../src/shared/database/db');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

// One more than the repository default so the default ceiling is actually hit.
const SEEDED_COUNT = 501;
const TITLE_PREFIX = '__TEST__ portal cap ';

let lawFirmId: any;
let matterId: any;
let nowIso: any;

beforeAll(async () => {
  const auth = await getTestToken();
  lawFirmId = await getPrimaryLawFirmId(auth.token);

  const { rows: matters } = await pool.query(
    `select id from matters where law_firm_id = $1 order by created_at asc limit 1`,
    [lawFirmId]
  );
  if (!matters.length) throw new Error(`Test firm ${lawFirmId} has no matters to attach events to`);
  matterId = matters[0].id;

  nowIso = new Date().toISOString();

  // Visible upcoming events, one per hour starting an hour out, so the date
  // ordering is unambiguous and every row passes the portal filter.
  await pool.query(
    `insert into events (law_firm_id, matter_id, title, status, client_visible, date)
     select $1, $2, $3 || g::text, 'upcoming', true, now() + (g || ' hours')::interval
       from generate_series(1, $4) as g`,
    [lawFirmId, matterId, TITLE_PREFIX, SEEDED_COUNT]
  );

  // Rows the portal filter must keep excluding even with the ceiling in place.
  await pool.query(
    `insert into events (law_firm_id, matter_id, title, status, client_visible, date)
     values ($1, $2, $3 || 'cancelled', 'cancelled', true, now() + interval '1 minute'),
            ($1, $2, $3 || 'hidden', 'upcoming', false, now() + interval '2 minutes'),
            ($1, $2, $3 || 'past', 'upcoming', true, now() - interval '10 days')`,
    [lawFirmId, matterId, TITLE_PREFIX]
  );
}, 60000);

afterAll(async () => {
  if (lawFirmId) {
    await pool.query(
      `delete from events where law_firm_id = $1 and title like $2`,
      [lawFirmId, `${TITLE_PREFIX}%`]
    );
  }
  await pool.end().catch(() => {});
});

describe('findUpcomingVisibleForMatters', () => {
  test('honours an explicit limit', async () => {
    const rows = await matterEventsRepo.findUpcomingVisibleForMatters(
      lawFirmId, [matterId], nowIso, { limit: 3 },
    );
    expect(rows).toHaveLength(3);
  });

  test('applies a default ceiling when no limit is given', async () => {
    const rows = await matterEventsRepo.findUpcomingVisibleForMatters(
      lawFirmId, [matterId], nowIso,
    );
    expect(rows).toHaveLength(500);
    // Proves the ceiling bit rather than an accident of the seed size.
    expect(SEEDED_COUNT).toBeGreaterThan(rows.length);
  });

  test('drops the furthest-out events, keeping the earliest', async () => {
    const rows = await matterEventsRepo.findUpcomingVisibleForMatters(
      lawFirmId, [matterId], nowIso, { limit: 5 },
    );
    const dates = rows.map((r: any) => new Date(r.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));

    const { rows: earliest } = await pool.query(
      `select id from events
        where law_firm_id = $1 and matter_id = $2
          and client_visible = true and status <> 'cancelled'
          and date is not null and date >= $3
        order by date asc limit 5`,
      [lawFirmId, matterId, nowIso]
    );
    expect(rows.map((r: any) => r.id)).toEqual(earliest.map((r: any) => r.id));
  });

  test('still excludes cancelled, hidden, and past events', async () => {
    const rows = await matterEventsRepo.findUpcomingVisibleForMatters(
      lawFirmId, [matterId], nowIso, { limit: SEEDED_COUNT + 10 },
    );
    const titles = rows.map((r: any) => r.title);
    expect(titles).not.toContain(`${TITLE_PREFIX}cancelled`);
    expect(titles).not.toContain(`${TITLE_PREFIX}hidden`);
    expect(titles).not.toContain(`${TITLE_PREFIX}past`);
  });

  test('returns nothing for an empty matter set', async () => {
    const rows = await matterEventsRepo.findUpcomingVisibleForMatters(lawFirmId, [], nowIso);
    expect(rows).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
