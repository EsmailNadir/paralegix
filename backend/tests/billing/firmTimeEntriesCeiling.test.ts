/**
 * The ceiling on `GET /billing/time-entries/firm`.
 *
 * The route used to document that an absent `limit` returns the firm's COMPLETE
 * time log, and the frontend's "select all matching" read relies on that by
 * sending no `limit` at all. An instance shares one 12-connection pool against a
 * Supabase pooler that allows 15, so a firm with tens of thousands of entries
 * held a connection while the whole log was read, derived and serialized, on a
 * page that already holds several other reads.
 *
 * The ceiling is `MAX_PAGE_SIZE` rows and it applies at the HTTP boundary only:
 *
 *   - An explicit `limit` ABOVE the ceiling is refused (400), not clamped. A
 *     caller that asked for 5,000 rows and silently received 200 would page
 *     wrongly forever; the 400 tells it the ceiling exists.
 *   - An absent `limit` is clamped to the ceiling AND the response says so, via
 *     `truncated`. Refusing it instead would break the select-all read with no
 *     fallback; clamping without saying so would hand a caller 200 rows it
 *     believes are all of them and let it bulk-act on the wrong set.
 *   - `totalItems` and `summary` are computed over the WHOLE match set, before
 *     any window, so a truncated response never understates the firm's hours or
 *     value.
 *
 * The in-process callers (`getBillingWorkbench`, `billingAnalytics`) call
 * `firmBillingService.listFirmTimeEntries` directly and still get every row,
 * which is what their firm-wide aggregates are summed from. The workbench case
 * below is what goes red if the ceiling is pushed down into the shared service
 * instead of the route's own wrapper.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

const { MAX_PAGE_SIZE } = require('../../src/modules/billing/shared/firmBillingWindow');

/** Hours and rate per seeded entry, so every total below is exact. */
const HOURS_PER_ENTRY = 1;
const RATE_CENTS_PER_ENTRY = 10_000;

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries/firm`;

/** `count` client-context time entries, inserted in one statement. */
async function seedEntries(count: number) {
  await testPool.query(
    `insert into activities
       (kind, id, law_firm_id, client_id, user_id, activity_date, hours, resolved_rate_cents, rate_source, name, billable)
     select 'time', gen_random_uuid(), $1, $2, $3, current_date, $4, $5, 'firm default rate', 'Entry ' || g, true
     from generate_series(1, $6) g`,
    [firm.id, client.id, owner.uid, HOURS_PER_ENTRY, RATE_CENTS_PER_ENTRY, count],
  );
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: `Ceiling Client ${randomUUID().slice(0, 8)}` });
});

describe('GET /billing/time-entries/firm ceiling', () => {
  /**
   * Red if the schema's `max` is raised or the `limit` bound is dropped. A
   * clamp here instead of a refusal would also go red, which is the point: the
   * two choices are not interchangeable for a caller that pages.
   */
  it('refuses a limit above the ceiling', async () => {
    await seedEntries(3);

    const res = await owner.api.get(`${base()}?limit=${MAX_PAGE_SIZE + 1}`);

    expect(res.status).toBe(400);
  });

  /**
   * The ceiling itself. Red if an absent `limit` goes back to returning the
   * whole log, which is the unbounded read this exists to stop.
   */
  it('caps a request with no limit at the ceiling', async () => {
    await seedEntries(MAX_PAGE_SIZE + 1);

    const res = await owner.api.get(base());

    expect(res.status).toBe(200);
    expect(res.body.timeEntries).toHaveLength(MAX_PAGE_SIZE);
    expect(res.body.totalItems).toBe(MAX_PAGE_SIZE + 1);
  });

  /**
   * The honesty half. Red if the cap is applied without flagging it, which
   * would let "select all matching" act on 200 of 201 entries while telling the
   * user it had them all.
   */
  it('says so when the ceiling withheld rows', async () => {
    await seedEntries(MAX_PAGE_SIZE + 1);

    const res = await owner.api.get(base());

    expect(res.body.truncated).toBe(true);
  });

  /** Red if `truncated` is hard-coded true, or set for a firm that fits. */
  it('reports no truncation for a firm that fits under the ceiling', async () => {
    await seedEntries(3);

    const res = await owner.api.get(base());

    expect(res.status).toBe(200);
    expect(res.body.timeEntries).toHaveLength(3);
    expect(res.body.totalItems).toBe(3);
    expect(res.body.truncated).toBe(false);
  });

  /**
   * A truncated page must not shrink the figures the firm reads off it. Red if
   * the summary or `totalItems` is ever computed after the window.
   */
  it('still totals the whole match set when it truncates', async () => {
    const seeded = MAX_PAGE_SIZE + 1;
    await seedEntries(seeded);

    const res = await owner.api.get(base());

    expect(res.body.summary.totalHours).toBe(seeded * HOURS_PER_ENTRY);
    expect(res.body.summary.totalAmount).toBe(seeded * HOURS_PER_ENTRY * (RATE_CENTS_PER_ENTRY / 100));
  });

  /**
   * An ordinary paged request is untouched by the ceiling: the caller chose its
   * own window, so nothing was withheld from it that it did not ask to withhold.
   * Red if `truncated` starts reporting "this is a page" rather than "the server
   * cut you off".
   */
  it('leaves a normal paged request unchanged', async () => {
    const seeded = MAX_PAGE_SIZE + 1;
    await seedEntries(seeded);

    const res = await owner.api.get(`${base()}?limit=10&page=1`);

    expect(res.status).toBe(200);
    expect(res.body.timeEntries).toHaveLength(10);
    expect(res.body.totalItems).toBe(seeded);
    expect(res.body.truncated).toBe(false);
    expect(res.body.summary.totalHours).toBe(seeded * HOURS_PER_ENTRY);
  });

  /**
   * The workbench aggregates over every entry in the firm and must never see a
   * page. Red if the ceiling is applied inside `firmBillingService`, where the
   * workbench and the analytics read would both inherit it and start reporting
   * the first 200 entries' hours as the firm's unbilled backlog.
   */
  it('does not cap the firm-wide totals the workbench computes', async () => {
    const seeded = MAX_PAGE_SIZE + 1;
    await seedEntries(seeded);

    const res = await owner.api
      .get(`/api/lawfirms/${firm.id}/billing/workbench`)
      .set('x-timezone', 'America/New_York');

    expect(res.status).toBe(200);
    expect(res.body.summary.unbilledHours).toBe(seeded * HOURS_PER_ENTRY);
  });
});
