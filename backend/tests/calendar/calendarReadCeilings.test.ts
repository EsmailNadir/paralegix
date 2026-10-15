/**
 * The two calendar reads that were missed when the others were capped.
 *
 * `clientEvents.findAllForLawFirm`, `matterEvents.findAll` and
 * `expenses.findAll` were given a ceiling because each returned every matching
 * row and grew with how long the customer had been using the product rather
 * than with the request. These two are the same shape and feed the same
 * screens, and they were left alone:
 *
 *   `calendarEvents.listAll` takes an OPTIONAL range. Without one it returns
 *   every personal event the user has ever created.
 *
 *   `matterEvents.findAllForMatters` also takes an optional range, and spans
 *   every matter the caller can see rather than one.
 *
 * Both refuse rather than truncating, for the same reason as the others: a
 * calendar missing its oldest month looks exactly like a calendar that has
 * nothing in it, and nothing reports the difference.
 */
process.env.UNPAGED_READ_CEILING = '3';

// This file loads with `require` rather than `import`, so that the ceiling above
// is set before the app graph reads it. Without an export, TypeScript then
// treats the file as a global script and its top-level names collide with every
// other such file in the project.
export {};

const {
  testPool, createFirm, ownerOf,
} = require('../support/setupInProcess');

const calendarEventsRepo = require('../../src/modules/calendar/calendarEvents.repository');
const matterEventsRepo = require('../../src/modules/matters/matterEvents.repository');
const { seedMatter } = require('../files/fileWorld');

let firm: any;
let owner: any;

beforeEach(async () => {
  firm = await createFirm({ name: 'Ceiling Calendar LLP' });
  owner = await ownerOf(firm.id);
});

/** Personal calendar events owned by the firm owner. */
async function seedPersonalEvents(dates: string[]) {
  for (const date of dates) {
    // eslint-disable-next-line no-await-in-loop -- ordering keeps ids stable
    await testPool.query(
      `insert into calendar_events (law_firm_id, title, starts_at, created_by)
       values ($1, $2, $3, $4)`,
      [firm.id, `Event ${date}`, `${date}T12:00:00Z`, owner.uid],
    );
  }
}

describe('a personal calendar with no range', () => {
  it('returns everything while it stays inside the ceiling', async () => {
    await seedPersonalEvents(['2026-01-05', '2026-02-05', '2026-03-05']);

    const rows = await calendarEventsRepo.listAll(firm.id, owner.uid);

    expect(rows).toHaveLength(3);
  });

  it('refuses rather than returning a short list', async () => {
    await seedPersonalEvents(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    await expect(calendarEventsRepo.listAll(firm.id, owner.uid))
      .rejects.toMatchObject({ statusCode: 400, code: 'READ_CEILING_EXCEEDED' });
  });

  it('serves a window of the same calendar', async () => {
    // The refusal is a redirection, not a dead end: the month the calendar is
    // drawing is both what it wants and small enough to serve.
    await seedPersonalEvents(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    const rows = await calendarEventsRepo.listAll(firm.id, owner.uid, {
      startUtc: '2026-02-01T00:00:00Z', endUtc: '2026-03-01T00:00:00Z',
    });

    expect(rows.map((r: any) => r.title)).toEqual(['Event 2026-02-05']);
  });

  it('still shows one user nothing of another user calendar', async () => {
    // The ceiling must not become a way around the ownership filter, which is
    // the only thing keeping a colleague's personal calendar private.
    const other = await ownerOf((await createFirm({ name: 'Elsewhere LLP' })).id);
    await seedPersonalEvents(['2026-01-05']);

    const rows = await calendarEventsRepo.listAll(firm.id, other.uid);

    expect(rows).toEqual([]);
  });
});

describe('matter events across many matters with no range', () => {
  async function seedMatterEvents(matterId: string, dates: string[]) {
    for (const date of dates) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps ids stable
      await testPool.query(
        `insert into events (law_firm_id, matter_id, type, title, date, all_day)
         values ($1, $2, 'meeting', $3, $4, true)`,
        [firm.id, matterId, `Event ${date}`, `${date}T12:00:00Z`],
      );
    }
  }

  it('returns everything while it stays inside the ceiling', async () => {
    const matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
    await seedMatterEvents(matterId, ['2026-01-05', '2026-02-05']);

    const rows = await matterEventsRepo.findAllForMatters(firm.id, [matterId]);

    expect(rows).toHaveLength(2);
  });

  it('refuses rather than returning a short list', async () => {
    const matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
    await seedMatterEvents(matterId, ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    await expect(matterEventsRepo.findAllForMatters(firm.id, [matterId]))
      .rejects.toMatchObject({ statusCode: 400, code: 'READ_CEILING_EXCEEDED' });
  });

  it('counts rows across every matter, not per matter', async () => {
    // Two matters of two events each is four rows. A ceiling applied per matter
    // would let the total grow with the number of matters.
    const a = await seedMatter(firm.id, owner.uid, 'Matter A');
    const b = await seedMatter(firm.id, owner.uid, 'Matter B');
    await seedMatterEvents(a, ['2026-01-05', '2026-02-05']);
    await seedMatterEvents(b, ['2026-03-05', '2026-04-05']);

    await expect(matterEventsRepo.findAllForMatters(firm.id, [a, b]))
      .rejects.toMatchObject({ code: 'READ_CEILING_EXCEEDED' });
  });

  it('serves a window across the same matters', async () => {
    const matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
    await seedMatterEvents(matterId, ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    const rows = await matterEventsRepo.findAllForMatters(firm.id, [matterId], {
      startUtc: '2026-02-01T00:00:00Z', endUtc: '2026-03-01T00:00:00Z',
    });

    expect(rows.map((r: any) => r.title)).toEqual(['Event 2026-02-05']);
  });

  it('returns nothing for no matters, without touching the database', async () => {
    await expect(matterEventsRepo.findAllForMatters(firm.id, [])).resolves.toEqual([]);
  });
});
