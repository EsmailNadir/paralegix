/**
 * The ceiling on the firm-wide client-event read, through the real route.
 *
 * `findAllForLawFirm` selects every standalone client event in a firm, and
 * without a date range that is every event the firm has ever had. It is the
 * fastest-growing read in the product: it grows with the customer's history
 * rather than with the request, on the 512 MiB container that also signs
 * documents.
 *
 * What must NOT happen is a `limit` that returns a short array. This read draws
 * a calendar, and a calendar missing its oldest events looks exactly like a
 * calendar that has none. So the read asks for one row past the ceiling and
 * refuses when it gets it, which the caller can see and act on.
 *
 * The ceiling is lowered here rather than seeding five thousand events. It is
 * read from the environment at module load, so it is set before the app graph
 * is required.
 */
process.env.UNPAGED_READ_CEILING = '3';

// This file loads with `require` rather than `import`, so that the ceiling above
// is set before the app graph reads it. Without an export, TypeScript then
// treats the file as a global script and its top-level names collide with every
// other such file in the project.
export {};

// `require`, not `import`: an import is hoisted above the assignment above it,
// and the ceiling is read when the module loads.
const { testPool, createFirm, createPersonClient, ownerOf } = require('../support/setupInProcess');

let firm: any;
let owner: any;
let client: any;

// Per test, not once: the harness truncates between tests, so a firm made in
// beforeAll is gone by the second case.
beforeEach(async () => {
  firm = await createFirm({ name: 'Ceiling LLP' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Ada Client' });
});

/** Insert a standalone client event directly, so the count is exact. */
async function seedEvents(dates: string[]): Promise<void> {
  for (const date of dates) {
    // eslint-disable-next-line no-await-in-loop -- ordering keeps the ids stable
    await testPool.query(
      `insert into events (law_firm_id, client_id, type, title, date, all_day)
       values ($1, $2, 'meeting', $3, $4, true)`,
      [firm.id, client.id, `Event ${date}`, `${date}T12:00:00Z`],
    );
  }
}

const listAll = () => owner.api.get(`/api/lawfirms/${firm.id}/clients/events`);
const listRange = (from: string, to: string) =>
  owner.api.get(`/api/lawfirms/${firm.id}/clients/events`).query({ from, to });

describe('a read inside the ceiling', () => {
  it('returns every event', async () => {
    await seedEvents(['2026-01-05', '2026-02-05', '2026-03-05']);

    const res = await listAll();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
  });
});

describe('a read past the ceiling', () => {
  it('refuses instead of returning a short list', async () => {
    await seedEvents(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    const res = await listAll();

    // The failure that this replaces is a 200 carrying three of the four
    // events, which no caller can tell from a complete answer.
    expect(res.status).toBe(400);
    expect(res.body.events).toBeUndefined();
  });

  it('says which read would not fit, so the response is actionable', async () => {
    await seedEvents(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    const res = await listAll();

    expect(res.body.code).toBe('READ_CEILING_EXCEEDED');
    expect(String(res.body.error)).toMatch(/client events/i);
    expect(String(res.body.error)).toMatch(/date range|paged/i);
  });
});

describe('narrowing to a window', () => {
  it('returns only the window, and stays inside the ceiling doing it', async () => {
    // The same firm whose unranged read is refused above. A month of that
    // history is both the answer the calendar wants and small enough to serve,
    // which is what makes the refusal a redirection rather than a dead end.
    await seedEvents(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);

    const res = await listRange('2026-02-01', '2026-02-28');

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe('Event 2026-02-05');
  });

  it('leaves another firm out of the window', async () => {
    const other = await createFirm({ name: 'Other LLP' });
    const otherClient = await createPersonClient(other.id, { name: 'Bob' });
    await testPool.query(
      `insert into events (law_firm_id, client_id, type, title, date, all_day)
       values ($1, $2, 'meeting', 'Not Mine', '2026-02-10T12:00:00Z', true)`,
      [other.id, otherClient.id],
    );
    await seedEvents(['2026-02-05']);

    const res = await listRange('2026-02-01', '2026-02-28');

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: any) => e.title)).toEqual(['Event 2026-02-05']);
  });
});
