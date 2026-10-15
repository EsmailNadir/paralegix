/**
 * Which client's negotiated rate a time entry is billed at.
 *
 * A matter can carry several clients, each with its own negotiated rates, and
 * rate tiers 3 and 4 read "the matter's billing client". No payer is chosen
 * until an invoice is composed, so every read path took the matter's FIRST
 * client by name. On a matter shared between two clients on different rates,
 * work for the second was priced at the first one's rate, and the pick moved if
 * a client was renamed.
 *
 * That was left alone on purpose while rates resolved live on every read:
 * changing the rule would have silently repriced every unbilled entry. Migration
 * 0233 ended that. A rate is now stamped on the row when the entry is written
 * and read back from there, and the backfill stamped every entry that already
 * existed, so the rule only ever applies to work nobody has rated yet.
 *
 * A time entry can already name its payer in `matter_client_ids`. When it does,
 * that is the client whose rate applies. The alphabetical pick stays for an
 * entry that names nobody, because there is still nothing better to go on.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;
let alphaId: string;
let betaId: string;

const invoicesBase = () => `/api/lawfirms/${firm.id}/billing/invoices`;

/** A matter client on a negotiated default rate. */
async function attachClient(name: string, defaultRate: number): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type, billing_rates)
     values ($1, $2, $3, 'person', jsonb_build_object('defaultRate', $4::numeric))`,
    [id, firm.id, name, defaultRate],
  );
  await testPool.query(
    `insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)`,
    [firm.id, matterId, id],
  );
  return id;
}

/**
 * An unrated time entry, written straight to the table so live resolution is
 * what answers. A row created through the route carries a stamped rate, which
 * is a different question and has its own case below.
 */
async function unratedEntry(payerIds: string[] | null): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, name, matter_client_ids)
     values ('time', $1, $2, $3, $4, current_date, 2, 'Shared matter work', $5::jsonb)`,
    [id, firm.id, matterId, owner.uid, payerIds ? JSON.stringify(payerIds) : null],
  );
  return id;
}

async function unbilledRate(entryId: string): Promise<number> {
  const res = await owner.api.get(`${invoicesBase()}/matter/${matterId}/unbilled-summary`);
  expect(res.status).toBe(200);
  const entry = res.body.unbilledTimeEntries.find((e: any) => e.id === entryId);
  expect(entry).toBeTruthy();
  return entry.rate;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Shared matter', $3)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
  );
  // Alpha sorts first, so it is the client every path used to pick. Beta is on
  // five times the rate, which is what makes a wrong pick visible in money.
  alphaId = await attachClient('Alpha Corp', 100);
  betaId = await attachClient('Beta LLC', 500);
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firm.id, matterId, owner.uid],
  );
  await drainEvents();
});

describe('an entry that names its payer', () => {
  it('is rated at THAT client negotiated rate, not the first client by name', async () => {
    const entryId = await unratedEntry([betaId]);

    // $500 is Beta's rate. $100 would be Alpha's, billed to a client who never
    // agreed to it, on a matter where both rates are on file.
    expect(await unbilledRate(entryId)).toBe(500);
  });

  it('still reads the first client by name when it names nobody', async () => {
    const entryId = await unratedEntry(null);

    // The fallback has to stay: with no payer named there is nothing better to
    // resolve against, and removing it would drop these entries to zero.
    expect(await unbilledRate(entryId)).toBe(100);
  });

  it('falls back rather than failing when the named payer is not on the matter', async () => {
    const strangerId = randomUUID();
    await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type, billing_rates)
       values ($1, $2, 'Detached Client', 'person', jsonb_build_object('defaultRate', 900::numeric))`,
      [strangerId, firm.id],
    );
    const entryId = await unratedEntry([strangerId]);

    // A stale id on the entry must not reach a rate off the matter entirely,
    // and must not zero the entry either.
    expect(await unbilledRate(entryId)).toBe(100);
  });

  it('holds on the firm-wide sweep, which reads every matter at once', async () => {
    await unratedEntry([betaId]);

    const res = await owner.api.get(`${invoicesBase()}/firm/unbilled-summaries`);
    expect(res.status).toBe(200);

    // A second reader, batched across every matter in the firm rather than one
    // at a time. It builds the same rate params from a different query, so it
    // is where the two paths drift apart without anyone noticing. It reports
    // money rather than rates: two hours at Beta's $500 is $1000, where Alpha's
    // $100 would show $200 and understate the firm's unbilled work fivefold.
    const summary = res.body.summaries.find((s: any) => s.entityId === matterId);
    expect(summary).toBeTruthy();
    expect(summary.unbilledTimeAmount).toBe(1000);
  });
});

describe('the rate stamped when the entry is written', () => {
  async function storedRate(entryId: string) {
    const { rows } = await testPool.query(
      `select resolved_rate_cents, rate_source from activities where kind = 'time' and id = $1`,
      [entryId],
    );
    return rows[0];
  }

  it('freezes the payer own rate, so the pick cannot drift later', async () => {
    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/time-entries`)
      .send({
        matterId,
        userId: owner.uid,
        date: '2026-05-01',
        hours: 2,
        name: 'Work for Beta',
        matterClientIds: [betaId],
      });
    expect(res.status).toBe(201);

    // This is the value that matters most. It is written once and read back
    // forever, so a wrong pick here is not repriced by any later fix.
    const stored = await storedRate(res.body.timeEntryId || res.body.timeEntry?.id);
    expect(Number(stored.resolved_rate_cents)).toBe(50_000);
    expect(stored.rate_source).toBe('client default rate');
  });
});
