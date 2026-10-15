/**
 * Two requests touching the SAME invoice, proved to overlap rather than hoped to.
 *
 * Every invoice mutation that reads current money state and writes a derived
 * patch (`recordPayment`, `updateInvoiceLineItems`, `addAmountToInvoice`, …) goes
 * through `invoicesRepo.runInvoiceTxn`: one transaction that takes
 * `select … for update` on the invoice row, so the read the caller computes
 * against can never be clobbered by a concurrent write to the same row. This
 * file drives that lock through the real HTTP routes, not by calling the
 * service directly, so the assertions cover the whole path: validation,
 * `authorizeContext`, the row lock, and the generated `balance_due_cents`
 * column Postgres computes from whatever actually got written.
 *
 * `gate.ts` pauses every call at `runInvoiceTxn`'s entry so two requests can be
 * PROVED to be inside it at the same time before the test lets them proceed,
 * per its own header's argument against bare `Promise.all`.
 *
 * IMPORTANT superagent/supertest gotcha found while building this file: a bare
 *   const req = owner.api.put(url).send(body);
 * is an INERT, unsent `Test` object. Superagent only dispatches the request
 * once something calls `.then()`/`.end()` on it, and neither `gate.arrived()`
 * nor a plain variable assignment does that. The two existing gated specs this
 * file's structure was copied from (`stripe/stripeInvoiceEffectRecovery.test.ts`,
 * `trust/trustStripeDepositRace.test.ts`) never hit this because their `deliver`
 * helper is an `async function` that `return`s the supertest chain: when an
 * async function returns a thenable, the language itself calls `.then()` on it
 * to adopt the resolution, which is what actually sends the request. Every
 * concurrent pair below is fired through a small `async function fire(...)`
 * helper for exactly that reason — a direct `owner.api.put(...).send(...)`
 * assigned to a variable and awaited only later never overlaps with anything.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

let gate: Gate | null = null;

afterEach(() => {
  // Unconditional: a failed assertion between installing the gate and opening
  // it must not leave a later spec's gate confused by a stale paused call.
  gate?.restore();
  gate = null;
});

/** A matter with `member` on it, so `authorizeContext`'s write-mode check passes. */
async function seedMatter(firmId: string, name: string, clientId: string, member: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, firmId, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [id, member, firmId],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, clientId, firmId],
  );
  return id;
}

/** An unbilled, billable time entry on a matter. `rate_cents` is set explicitly so the
 *  amount does not depend on the rate-resolution chain fixtures this file does not seed. */
async function seedTimeEntry(firmId: string, matterId: string, uid: string, hours: number, rateCents: number) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description, billable)
     values ('time', $1, $2, $3, $4, date '2026-03-10', $5, $6, 'Race work', true) returning id`,
    [id, firmId, matterId, uid, hours, rateCents],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** A client-context invoice, seeded directly so a race test does not depend on `createInvoice`. */
async function seedClientInvoice(firmId: string, clientId: string, totalCents: number, invoiceNumber: string) {
  const { rows } = await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date)
     values (gen_random_uuid(), $1, $2, $2, 'client', $3, 'outstanding', $4, current_date, current_date + 30)
     returning id`,
    [firmId, clientId, invoiceNumber, totalCents],
  );
  return rows[0].id as string;
}

async function invoiceMoneyState(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, balance_due_cents, is_paid, status
       from invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

async function paymentRows(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_cents from invoice_payments where invoice_id = $1 order by amount_cents`,
    [invoiceId],
  );
  return rows;
}

async function invoicesForMatter(matterId: string) {
  const { rows } = await testPool.query(
    `select id, invoice_name from invoices where matter_id = $1 order by invoice_name`,
    [matterId],
  );
  return rows;
}

async function lineItemSourceIds(invoiceId: string) {
  const { rows } = await testPool.query(
    `select source_id from invoice_line_items where invoice_id = $1 and kind = 'time_entry'`,
    [invoiceId],
  );
  return rows.map((r: any) => r.source_id);
}

describe('M08: two partial payments raced against one balance', () => {
  let firm: Firm;
  let owner: Actor;
  let clientId: string;
  let invoiceId: string;
  const TOTAL_CENTS = 100_000; // $1,000.00

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'M08 Client' });
    clientId = client.id;
    invoiceId = await seedClientInvoice(firm.id, clientId, TOTAL_CENTS, 'INV-M08-1');
  });

  it('lets exactly one $600 payment land against a $1,000 invoice when both race the same balance', async () => {
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');

    const url = `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/payment`;
    async function fire() {
      return owner.api.put(url).send({ paymentAmount: 600 });
    }
    const first = fire();
    const second = fire();

    // The evidence: both requests are paused INSIDE the locking transaction,
    // neither has read the other's write yet, before the test releases them.
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);

    gate.open();
    const [resA, resB] = await Promise.all([first, second]);
    await drainEvents();

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    // One payment applies; the other collides with the remaining-balance guard
    // once it reads the row under the lock and must fail cleanly, not hang or
    // silently overpay.
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.amount_paid_cents)).toBe(60_000);
    // The generated column, not application arithmetic: the database itself
    // computed total - paid - written_off, so this cannot be an assertion
    // written against the same formula the code under test used.
    expect(Number(state.balance_due_cents)).toBe(40_000);
    expect(state.is_paid).toBe(false);

    const payments = await paymentRows(invoiceId);
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount_cents)).toBe(60_000);

    // Both requests actually reached the contested function; nothing here is a
    // sequential run that happened to look like a race.
    expect(gate.entered()).toBe(2);
  });

  it('control: the barrier actually fired — two sequential $600 payments are individually rejected, not raced', async () => {
    // Without this control, a route that rejected every payment above some
    // unrelated threshold would satisfy the case above for the wrong reason.
    const url = `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/payment`;
    const first = await owner.api.put(url).send({ paymentAmount: 600 });
    expect(first.status).toBe(200);
    const second = await owner.api.put(url).send({ paymentAmount: 600 });
    expect(second.status).toBe(400);

    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.amount_paid_cents)).toBe(60_000);
    expect(Number(state.balance_due_cents)).toBe(40_000);
  });
});

describe('M06: a line-item edit racing a payment never leaves a negative balance', () => {
  let firm: Firm;
  let owner: Actor;
  let clientId: string;
  let invoiceId: string;
  const TOTAL_CENTS = 100_000; // $1,000.00

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'M06 Client' });
    clientId = client.id;
    invoiceId = await seedClientInvoice(firm.id, clientId, TOTAL_CENTS, 'INV-M06-1');
  });

  it('a $600 payment racing an edit that drops the total to $500 never commits both halves', async () => {
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');

    const paymentUrl = `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/payment`;
    const lineItemsUrl = `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/line-items`;

    async function firePayment() {
      return owner.api.put(paymentUrl).send({ paymentAmount: 600 });
    }
    // A total of $500 with nothing paid yet is a perfectly legal edit on its
    // own — it only becomes a problem if it lands AFTER the $600 payment, which
    // is exactly the interleaving the gate is here to force and observe.
    async function fireEdit() {
      return owner.api.patch(lineItemsUrl).send({
        timeEntries: [{ description: 'Reduced scope', hours: 5, rate: 100 }],
      });
    }
    const payment = firePayment();
    const edit = fireEdit();

    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);

    gate.open();
    const [payRes, editRes] = await Promise.all([payment, edit]);
    await drainEvents();

    const state = await invoiceMoneyState(invoiceId);
    // The invariant this test exists to pin: whichever order the lock actually
    // serialized these in, the generated column must never go negative. Either
    // the edit lands first (total $500, then the $600 payment is rejected by
    // the over-payment guard) or the payment lands first (amount_paid $600,
    // then the edit is rejected by the below-settled guard) — never both.
    expect(Number(state.balance_due_cents)).toBeGreaterThanOrEqual(0);

    const statuses = [payRes.status, editRes.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    if (editRes.status === 200) {
      // The edit won the lock: total is now $500, unpaid, and the payment that
      // read the row afterward saw $500 remaining and correctly refused $600.
      expect(Number(state.total_cents)).toBe(50_000);
      expect(Number(state.amount_paid_cents)).toBe(0);
      expect(payRes.status).toBe(400);
    } else {
      // The payment won the lock: $600 is applied against the original $1,000
      // total, and the edit that read the row afterward saw $600 already paid
      // against a proposed $500 total and was refused as below-settled.
      expect(Number(state.amount_paid_cents)).toBe(60_000);
      expect(Number(state.total_cents)).toBe(TOTAL_CENTS);
      expect(editRes.status).toBe(409);
    }

    expect(gate.entered()).toBe(2);
  });

  it('control: the same edit with no payment in flight succeeds on its own', async () => {
    const lineItemsUrl = `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/line-items`;
    const res = await owner.api.patch(lineItemsUrl).send({
      timeEntries: [{ description: 'Reduced scope', hours: 5, rate: 100 }],
    });
    expect(res.status).toBe(200);

    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.total_cents)).toBe(50_000);
    expect(Number(state.balance_due_cents)).toBe(50_000);
  });
});

describe('M05: the invoice-number counter under concurrent bulk-create', () => {
  let firm: Firm;
  let owner: Actor;
  let clientId: string;
  let matterA: string;
  let matterB: string;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'M05 Client' });
    clientId = client.id;
    matterA = await seedMatter(firm.id, 'M05 Matter A', clientId, owner.uid);
    matterB = await seedMatter(firm.id, 'M05 Matter B', clientId, owner.uid);
    await seedTimeEntry(firm.id, matterA, owner.uid, 5, 20_000); // $1,000 unbilled
    await seedTimeEntry(firm.id, matterB, owner.uid, 3, 20_000); // $600 unbilled
    // Pre-seed the counter row so both racing allocations skip the
    // `insert ... on conflict do nothing` upsert branch (which would otherwise
    // serialize a FIRST-EVER allocation on its own conflict lock, masking
    // whatever the steady-state allocation step does or does not protect).
    await testPool.query(
      `insert into firm_counters (law_firm_id, counter_type, next_val)
       values ($1, 'invoice_number', 1)
       on conflict (law_firm_id, counter_type) do nothing`,
      [firm.id],
    );
  });

  it('two concurrent bulk-create requests for different matters allocate distinct numbers', async () => {
    gate = gateMethod(invoicesRepo, 'allocateInvoiceNumber');

    const url = `/api/lawfirms/${firm.id}/billing/invoices/bulk`;
    async function fire(matterId: string) {
      return owner.api.post(url).send({
        contexts: [{ type: 'matter', entityId: matterId }],
        invoiceDate: '2026-03-15',
      });
    }
    const first = fire(matterA);
    const second = fire(matterB);

    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);

    gate.open();
    const [resA, resB] = await Promise.all([first, second]);
    await drainEvents();

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    // A bulk run reports a per-context write failure (e.g. a duplicate
    // invoice_number colliding with the unique index) as a 201 with a
    // populated `failed`/`errors` entry, not as a non-2xx response — so the
    // status codes alone cannot prove both contexts actually got billed.
    expect(resA.body.failed).toEqual([]);
    expect(resB.body.failed).toEqual([]);
    expect(resA.body.created).toHaveLength(1);
    expect(resB.body.created).toHaveLength(1);

    const rowsA = await invoicesForMatter(matterA);
    const rowsB = await invoicesForMatter(matterB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);

    // The counter is per-firm, shared by both matters here — the whole point of
    // this test. Two concurrent allocations against the SAME row must never
    // hand out the same number twice.
    expect(rowsA[0].invoice_name).not.toBe(rowsB[0].invoice_name);

    expect(gate.entered()).toBe(2);
  });
});

describe('M04: two invoice-create requests claim the same unbilled time entry', () => {
  // Both requests finish their preflight reads before either transaction
  // writes. The repository must recheck availability under the context lock.
  let firm: Firm;
  let owner: Actor;
  let clientId: string;
  let matterId: string;
  let timeEntryId: string;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'M04 Client' });
    clientId = client.id;
    matterId = await seedMatter(firm.id, 'M04 Matter', clientId, owner.uid);
    timeEntryId = await seedTimeEntry(firm.id, matterId, owner.uid, 5, 10_000); // $500
  });

  it('only one overlapping request can bill the same time entry', async () => {
    gate = gateMethod(invoicesRepo, 'findByContext');

    const url = `/api/lawfirms/${firm.id}/billing/invoices`;
    // Distinct invoice names so the (law_firm_id, context, invoice_name) unique
    // index — a real, separate guard — cannot be what decides this race. Only
    // the double-billing check is under test here.
    async function fire(invoiceName: string) {
      return owner.api.post(url).send({
        matterId,
        invoiceName,
        invoiceDate: '2026-03-10',
        timeEntries: [{ id: timeEntryId, description: 'Race work', hours: 5, amount: 500 }],
        totalAmount: 500,
        totalHours: 5,
      });
    }
    const first = fire('INV-M04-A');
    const second = fire('INV-M04-B');

    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);

    gate.open();
    const [resA, resB] = await Promise.all([first, second]);
    await drainEvents();

    // A preflight read is insufficient: the competing transaction must be
    // refused after the winner commits its source claims.
    expect([resA.status, resB.status].sort()).toEqual([201, 400]);
    expect([resA, resB].find((res) => res.status === 400)?.body.error).toMatch(/already billed/i);

    const rows = await invoicesForMatter(matterId);
    expect(rows).toHaveLength(1);

    // Exactly one invoice carries the source work.
    const sourcesA = await lineItemSourceIds(rows[0].id);
    expect(sourcesA).toEqual([timeEntryId]);

    expect(gate.entered()).toBe(2);
  });

  it('control: the same time entry billed twice SEQUENTIALLY is refused by the guard on the second call', async () => {
    // Without this control, a guard that never worked at all (always lets
    // duplicate billing through) would satisfy the race case above too, and
    // nobody would notice the guard was never the reason either result held.
    const url = `/api/lawfirms/${firm.id}/billing/invoices`;
    const firstRes = await owner.api.post(url).send({
      matterId,
      invoiceName: 'INV-M04-SEQ-A',
      invoiceDate: '2026-03-10',
      timeEntries: [{ id: timeEntryId, description: 'Race work', hours: 5, amount: 500 }],
      totalAmount: 500,
      totalHours: 5,
    });
    expect(firstRes.status).toBe(201);

    const secondRes = await owner.api.post(url).send({
      matterId,
      invoiceName: 'INV-M04-SEQ-B',
      invoiceDate: '2026-03-10',
      timeEntries: [{ id: timeEntryId, description: 'Race work', hours: 5, amount: 500 }],
      totalAmount: 500,
      totalHours: 5,
    });
    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toMatch(/already billed/i);

    const rows = await invoicesForMatter(matterId);
    expect(rows).toHaveLength(1);
  });
});

/**
 * M09: the late-fee row lock (B08.1 J05 — "claim acquired, provider rejects").
 *
 * `applyLateFeeCore` (`invoices.service.ts`) is the ONE code path both the
 * manual `POST .../late-fee` route and the automatic cron sweep call, and both
 * run it through the same `runInvoiceTxn` row lock the M08 payment race above
 * proves out. A late fee is a one-time charge — `lateFeeEligibility` refuses an
 * invoice that already carries a `kind = 'late_fee'` adjustment — so the same
 * lock that stops two payments overpaying an invoice is what stops the manual
 * route and an overlapping cron pass from stacking two fees on the same
 * invoice. Sequential double-application is already pinned in
 * `invoiceAdjustments.test.ts`; this is the concurrent case, proved to
 * overlap rather than hoped to, the way M08 proves its own race.
 */
describe('M09: two late-fee applications raced against the same overdue invoice', () => {
  let firm: Firm;
  let owner: Actor;
  let clientId: string;
  let invoiceId: string;

  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'M09 Client' });
    clientId = client.id;

    await testPool.query(
      `update law_firms
          set settings = coalesce(settings, '{}'::jsonb)
            || jsonb_build_object('billing', jsonb_build_object('lateFee', $2::jsonb))
        where id = $1`,
      [firm.id, JSON.stringify({ enabled: true, autoApply: false, flatAmount: 25, percent: 0, graceDays: 0 })],
    );

    const res = await owner.api.post(base()).send({
      invoiceName: 'M09 Overdue Invoice',
      invoiceDate: '2026-02-01',
      dueDate: '2026-02-15', // long past due against the real clock, no grace configured
      totalAmount: 1000,
      flatFeesAmount: 1000,
      flatFees: [{ description: 'Fixed fee', amount: 1000 }],
    });
    expect(res.status).toBe(201);
    invoiceId = res.body.invoice.id as string;
  });

  it('applies exactly one fee when two manual requests race the same invoice', async () => {
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');

    const url = `${base()}/${invoiceId}/late-fee`;
    async function fire() {
      return owner.api.post(url);
    }
    const first = fire();
    const second = fire();

    // Both requests are paused INSIDE the row-locking transaction before
    // either has read the other's write, exactly as M08 proves for payments.
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);

    gate.open();
    const [resA, resB] = await Promise.all([first, second]);
    await drainEvents();

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    // One applies; the other reads the row under the lock AFTER the first
    // commits, finds the adjustment already there, and is refused cleanly —
    // never a second fee and never a hang.
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(400);

    const { rows: invoiceRows } = await testPool.query(
      `select total_cents, balance_due_cents from invoices where id = $1`,
      [invoiceId],
    );
    // $1,000 plus exactly ONE $25 fee. Two racing fees would read 102_500 vs
    // 105_000; this is the number that tells them apart.
    expect(Number(invoiceRows[0].total_cents)).toBe(102_500);
    expect(Number(invoiceRows[0].balance_due_cents)).toBe(102_500);

    const { rows: feeRows } = await testPool.query(
      `select amount_cents from invoice_adjustments where invoice_id = $1 and direction = 'charge' and kind = 'late_fee'`,
      [invoiceId],
    );
    expect(feeRows).toHaveLength(1);
    expect(Number(feeRows[0].amount_cents)).toBe(2_500);

    // Both requests actually reached the contested function — this is a proven
    // race, not a sequential run that happened to look like one.
    expect(gate.entered()).toBe(2);
  });

  it('control: the barrier actually fired — two SEQUENTIAL requests already behave this way on their own', async () => {
    // Without this control, a route that refused every second call regardless
    // of timing would satisfy the race case above for the wrong reason.
    const url = `${base()}/${invoiceId}/late-fee`;
    const first = await owner.api.post(url);
    expect(first.status).toBe(200);
    const second = await owner.api.post(url);
    expect(second.status).toBe(400);

    const { rows } = await testPool.query(
      `select total_cents from invoices where id = $1`, [invoiceId],
    );
    expect(Number(rows[0].total_cents)).toBe(102_500);
  });
});
