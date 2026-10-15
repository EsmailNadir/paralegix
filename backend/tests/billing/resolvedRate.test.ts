/**
 * A time entry carries the rate it was resolved at when it was written (B3,
 * migration 0233).
 *
 * Before this the rate was resolved on every READ from up to eight sources, so
 * raising a member's default rate silently revalued every unbilled entry they
 * had ever logged and every report with it. Now the entry stores
 * `resolved_rate_cents` and `rate_source` at write time, `amount_cents` is
 * generated from that rate, and a later change to a source leaves old work
 * where it was until the firm asks to re-rate.
 *
 * RED IF: the write path stops storing the rate (the entry reads back with no
 * source), a read path goes back to live resolution (the summary moves when the
 * member's default changes), the re-rate route stops moving unbilled work or
 * starts moving billed work, or a row nothing has rated stops resolving live.
 */
import { randomUUID } from 'crypto';

import {
  testPool, createFirm, createFirmMember, createPersonClient, createInvoice, ownerOf, memberWith,
  type Firm, type Actor,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: { id: string };
let timekeeper: string;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const summaryUrl = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}/unbilled-summary`;

async function setMemberDefaultRate(uid: string, dollars: number | null) {
  await testPool.query(
    'update members set default_hourly_rate_cents = $3 where law_firm_id = $1 and user_id = $2',
    [firm.id, uid, dollars == null ? null : Math.round(dollars * 100)],
  );
}

async function stored(id: string) {
  const { rows } = await testPool.query(
    'select resolved_rate_cents, rate_source, amount_cents from activities where id = $1', [id],
  );
  return rows[0];
}

async function logHours(hours: number, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(base()).send({
    context: 'client', clientId: client.id, userId: timekeeper, hours, date: '2026-03-02', description: 'Drafting', ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry;
}

async function summaryRateFor(id: string) {
  const res = await owner.api.get(summaryUrl());
  expect(res.status).toBe(200);
  const entry = res.body.unbilledTimeEntries.find((e: any) => e.id === id);
  return entry?.rate ?? null;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  ({ uid: timekeeper } = await memberWith(firm.id, ['billing.manageTimeEntries', 'billing.viewTimeEntries']));
  client = await createPersonClient(firm.id, { name: 'Rated Client' });
  await setMemberDefaultRate(timekeeper, 200);
});

describe('the rate is stored when the entry is written', () => {
  it('records the resolved rate, its source, and an amount summable in SQL', async () => {
    const entry = await logHours(1.5);

    expect(entry.resolvedRate).toBe(200);
    expect(entry.rateSource).toBe('user default rate');
    expect(entry.amount).toBe(300);
    expect(await stored(entry.id)).toEqual({ resolved_rate_cents: '20000', rate_source: 'user default rate', amount_cents: '30000' });
  });

  it('records an explicit override as the override, ahead of every other source', async () => {
    const entry = await logHours(2, { hourlyRate: 350 });

    expect(entry.resolvedRate).toBe(350);
    expect(entry.rateSource).toBe('time entry override');
    expect(await stored(entry.id)).toMatchObject({ resolved_rate_cents: '35000', amount_cents: '70000' });
  });

  it('records that nothing applied, rather than leaving the row unrated', async () => {
    await setMemberDefaultRate(timekeeper, null);
    const entry = await logHours(1);

    expect(entry.resolvedRate).toBeNull();
    expect(entry.rateSource).toBe('none');
    expect(await stored(entry.id)).toEqual({ resolved_rate_cents: null, rate_source: 'none', amount_cents: '0' });
  });
});

describe('a later rate change does not move old work', () => {
  it('keeps the unbilled summary at the stored rate after the member default changes', async () => {
    const entry = await logHours(1);
    expect(await summaryRateFor(entry.id)).toBe(200);

    await setMemberDefaultRate(timekeeper, 450);

    // Still 200: the rate was decided when the work was recorded.
    expect(await summaryRateFor(entry.id)).toBe(200);
    expect((await stored(entry.id)).amount_cents).toBe('20000');
  });

  it('re-rates the entry when one of its own inputs changes', async () => {
    const entry = await logHours(1);
    await setMemberDefaultRate(timekeeper, 450);

    const res = await owner.api.put(`${base()}/client/${client.id}/${entry.id}`).send({ hourlyRate: 500 });
    expect(res.status).toBe(200);
    expect(res.body.timeEntry.resolvedRate).toBe(500);
    expect(res.body.timeEntry.rateSource).toBe('time entry override');

    // Clearing the override re-resolves against today's sources, not yesterday's.
    const cleared = await owner.api.put(`${base()}/client/${client.id}/${entry.id}`).send({ hourlyRate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.timeEntry.resolvedRate).toBe(450);
    expect(cleared.body.timeEntry.rateSource).toBe('user default rate');
  });

  it('leaves the stored rate alone when only the description changes', async () => {
    const entry = await logHours(1);
    await setMemberDefaultRate(timekeeper, 450);

    const res = await owner.api.put(`${base()}/client/${client.id}/${entry.id}`).send({ description: 'Drafting the reply' });
    expect(res.status).toBe(200);
    expect(res.body.timeEntry.resolvedRate).toBe(200);
  });
});

describe('re-rating on request', () => {
  it('moves every unbilled entry in the context to the current sources and reports the count', async () => {
    const first = await logHours(1);
    const second = await logHours(2);
    await setMemberDefaultRate(timekeeper, 450);

    const res = await owner.api.post(`${base()}/client/${client.id}/rerate`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rerated: 2, skippedBilled: 0 });

    expect((await stored(first.id))).toMatchObject({ resolved_rate_cents: '45000', amount_cents: '45000' });
    expect((await stored(second.id))).toMatchObject({ resolved_rate_cents: '45000', amount_cents: '90000' });
    expect(await summaryRateFor(first.id)).toBe(450);
  });

  it('counts and rewrites only the entries whose rate actually moved', async () => {
    // A charge-code rate is the second source. One entry is pinned to it and
    // one rides the member default; only the default changes, so only that
    // entry is re-rated. Counting both would tell the firm two entries moved
    // when one bill line changed.
    const { rows: [code] } = await testPool.query(
      `insert into billing_codes (law_firm_id, kind, code, name, is_active, default_rate, default_rate_cents)
       values ($1, 'charge', 'LIT-1', 'Litigation', true, 312.50, 31250) returning id`,
      [firm.id],
    );
    const pinned = await logHours(1.5, { chargeCodeId: code.id });
    const floating = await logHours(1);
    expect((await stored(pinned.id)).resolved_rate_cents).toBe('31250');
    await setMemberDefaultRate(timekeeper, 333.33);

    const res = await owner.api.post(`${base()}/client/${client.id}/rerate`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rerated: 1, skippedBilled: 0 });
    expect(await stored(pinned.id)).toMatchObject({ resolved_rate_cents: '31250', amount_cents: '46875' });
    expect(await stored(floating.id)).toMatchObject({ resolved_rate_cents: '33333', amount_cents: '33333' });
  });

  it('never touches an entry that is already on an invoice', async () => {
    const billed = await logHours(1);
    const open = await logHours(1);
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 20000 });
    await testPool.query(
      `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
       values ($1, $2, 'time_entry', $3, 1, 20000, 20000)`,
      [invoice.id, firm.id, billed.id],
    );
    await setMemberDefaultRate(timekeeper, 450);

    const res = await owner.api.post(`${base()}/client/${client.id}/rerate`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rerated: 1, skippedBilled: 1 });
    expect((await stored(billed.id)).resolved_rate_cents).toBe('20000');
    expect((await stored(open.id)).resolved_rate_cents).toBe('45000');
  });

  it('refuses a caller from another firm', async () => {
    const rival = await createFirm();
    const rivalOwner = await ownerOf(rival.id);
    const res = await rivalOwner.api.post(`${base()}/client/${client.id}/rerate`).send({});
    expect(res.status).toBe(403);
  });

  /**
   * Re-rating restates the stored rate on everyone's unbilled work in a context,
   * so it needs the same standing as editing or deleting another member's time.
   * Red if only billing.manageTimeEntries is checked: the member's request
   * answers 200 and the teammate's entry is re-rated.
   */
  describe('whose entries it would change', () => {
    let narrow: Actor;
    const rerate = (actor: Actor) => actor.api.post(`${base()}/client/${client.id}/rerate`).send({});
    const logAs = async (actor: Actor, hours: number) => {
      const res = await actor.api.post(base()).send({
        context: 'client', clientId: client.id, userId: actor.uid, hours, date: '2026-03-02', description: 'Own work',
      });
      expect(res.status).toBe(201);
      return res.body.timeEntry;
    };

    beforeEach(async () => {
      narrow = await memberWith(firm.id, ['billing.manageTimeEntries']);
      await setMemberDefaultRate(narrow.uid, 200);
    });

    it('refuses a member without manageOthersTimeEntries when a teammate has an unbilled entry, and changes nothing', async () => {
      const own = await logAs(narrow, 1);
      const teammates = await logHours(1);
      await setMemberDefaultRate(narrow.uid, 450);
      await setMemberDefaultRate(timekeeper, 450);

      const res = await rerate(narrow);

      expect(res.status).toBe(403);
      expect((await stored(own.id)).resolved_rate_cents).toBe('20000');
      expect((await stored(teammates.id)).resolved_rate_cents).toBe('20000');
    });

    it('refuses the same member when the unbilled entry is firm-level time', async () => {
      const firmLevel = await logHours(1, { userId: 'FIRM' });
      expect((await stored(firmLevel.id)).rate_source).toBe('none');

      const res = await rerate(narrow);

      expect(res.status).toBe(403);
    });

    it('re-rates a member\'s own entries when no one else has unbilled work in the context', async () => {
      const own = await logAs(narrow, 1);
      await setMemberDefaultRate(narrow.uid, 450);

      const res = await rerate(narrow);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rerated: 1, skippedBilled: 0 });
      expect((await stored(own.id)).resolved_rate_cents).toBe('45000');
    });

    it('re-rates everyone\'s entries for a member who holds manageOthersTimeEntries', async () => {
      const manager = await memberWith(firm.id, ['billing.manageTimeEntries', 'billing.manageOthersTimeEntries']);
      const teammates = await logHours(1);
      await setMemberDefaultRate(timekeeper, 450);

      const res = await rerate(manager);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rerated: 1 });
      expect((await stored(teammates.id)).resolved_rate_cents).toBe('45000');
    });

    it('does not count a teammate\'s billed entry, which re-rating leaves alone', async () => {
      const own = await logAs(narrow, 1);
      const billed = await logHours(1);
      const invoice = await createInvoice(firm.id, client.id, { totalCents: 20000 });
      await testPool.query(
        `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
         values ($1, $2, 'time_entry', $3, 1, 20000, 20000)`,
        [invoice.id, firm.id, billed.id],
      );
      await setMemberDefaultRate(narrow.uid, 450);
      await setMemberDefaultRate(timekeeper, 450);

      const res = await rerate(narrow);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rerated: 1, skippedBilled: 1 });
      expect((await stored(own.id)).resolved_rate_cents).toBe('45000');
      expect((await stored(billed.id)).resolved_rate_cents).toBe('20000');
    });
  });
});

describe('a row nothing has rated still resolves live', () => {
  it('reads a hand-written entry at the current sources, so old fixtures and pre-migration rows keep working', async () => {
    const id = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, description)
       values ('time', $1, $2, $3, $4, '2026-03-02', 1, 'Unrated')`,
      [id, firm.id, client.id, timekeeper],
    );
    expect(await summaryRateFor(id)).toBe(200);

    await setMemberDefaultRate(timekeeper, 450);
    // No stored source, so the reader resolves live and follows the change.
    expect(await summaryRateFor(id)).toBe(450);
  });
});
