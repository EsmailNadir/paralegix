/**
 * `events` holds matter events and standalone client events in ONE table
 * (migration 0205), and the parent is two nullable foreign keys with a CHECK
 * rather than a `(parent_type, parent_id)` pair.
 *
 * The pair was rejected for the reason migration 0202 gives for notes: a
 * polymorphic parent id can carry no foreign key, and both halves cascade from
 * their parent today, so a matter delete would leave its events behind.
 *
 * Two guarantees are worth pinning, and they fail in opposite directions.
 *
 * THE DATABASE ENFORCES "EXACTLY ONE PARENT". Before the merge that was not a
 * rule at all, it was two tables whose shape made it true. A row naming both
 * parents, or neither, is meaningless to every reader: the matter reads filter
 * on `matter_id` and the client reads on `client_id`, so a two-parent row would
 * appear in both lists and a no-parent row in neither, while still counting
 * toward the firm's totals.
 *
 * A FIRM-WIDE READ MUST SAY WHICH PARENT IT WANTS. This is the merge's live
 * hazard and it is not hypothetical: two reads reached the parent only by
 * joining `clients`, and a LEFT JOIN does not narrow, so both would have
 * returned every matter event in the firm as a client event with a null name.
 * The matter-side equivalents were safe only because their joins to `matters`
 * are INNER. The last case below drives the client-events route rather than the
 * repository, so it goes red if that predicate is dropped anywhere on the path.
 *
 * Deliberately NOT covered here: `calendar_events`, which is a separate table
 * and stays one. It mirrors events synced INTO Paralegix from Google and
 * Outlook; these are the firm's own records, which sync OUT.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;
let clientId: string;

async function createMatter(lawFirmId: string, name = 'Parent matter'): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  return id;
}

const insertEvent = (cols: string, values: any[]) => testPool.query(
  `insert into events (id, law_firm_id, title, ${cols})
   values ($1, $2, 'An event', ${values.map((_, i) => `$${i + 3}`).join(', ')})`,
  [randomUUID(), firm.id, ...values],
);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = await createMatter(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Parent client' })).id;
});

describe('events_parent_ck: exactly one parent', () => {
  it('accepts a matter event', async () => {
    const res = await insertEvent('matter_id', [matterId]);
    expect(res.rowCount).toBe(1);
  });

  it('accepts a client event', async () => {
    const res = await insertEvent('client_id', [clientId]);
    expect(res.rowCount).toBe(1);
  });

  it('refuses a row naming BOTH parents', async () => {
    await expect(
      insertEvent('matter_id, client_id', [matterId, clientId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a row naming NEITHER parent', async () => {
    await expect(insertEvent('type', ['hearing'])).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an UPDATE that would leave a row with two parents', async () => {
    const id = randomUUID();
    await testPool.query(
      `insert into events (id, law_firm_id, title, matter_id) values ($1, $2, 'An event', $3)`,
      [id, firm.id, matterId],
    );
    // The CHECK is not an insert-time-only rule: a row can be walked into an
    // invalid state by an update just as easily.
    await expect(
      testPool.query(`update events set client_id = $2 where id = $1`, [id, clientId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('a firm-wide client-events read does not leak matter events', () => {
  it('lists only the client events, not every event in the firm', async () => {
    const clientEventId = randomUUID();
    await testPool.query(
      `insert into events (id, law_firm_id, client_id, title, type, status, date)
       values ($1, $2, $3, 'Intake meeting', 'meeting', 'upcoming', '2026-10-01T15:00:00Z')`,
      [clientEventId, firm.id, clientId],
    );
    // Same firm, same date range, different parent. Without an explicit
    // `client_id is not null`, this is the row that comes back as a client
    // event with a null client name.
    await testPool.query(
      `insert into events (id, law_firm_id, matter_id, title, type, status, date)
       values ($1, $2, $3, 'Hearing', 'hearing', 'upcoming', '2026-10-01T16:00:00Z')`,
      [randomUUID(), firm.id, matterId],
    );

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients/events`);
    expect(res.status).toBe(200);

    // The envelope key is read directly rather than through a `??` chain: a
    // fallback would keep this green if the field were renamed away.
    expect(res.body.totalEvents).toBe(1);
    // Named exactly, not counted: a length assertion alone would pass against a
    // response that returned the wrong single event.
    expect(res.body.events.map((e: any) => e.id)).toEqual([clientEventId]);
  });
});
