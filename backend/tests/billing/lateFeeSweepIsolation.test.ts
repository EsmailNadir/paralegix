/**
 * B08.2 late fees: three job-specific properties `tests/cron/lateFeeCalculation.test.ts`
 * and `tests/billing/lateFees.service.test.ts` do not reach.
 *
 * `lateFees.service.test.ts` mocks `getFirmBillingSettings`, `forEachFirm`,
 * `invoicesRepo` AND `applyLateFeeCore`, so it pins the counting shape only.
 * `lateFeeCalculation.test.ts` drives the real sweep but never puts `enabled`
 * and `autoApply` at odds with each other, never races the sweep against a
 * concurrent payment on the same invoice, and never forces one invoice's
 * `applyLateFeeCore` call to throw to see whether the rest of the pass
 * survives it. All three are real financial-integrity properties:
 *
 *   1. ENABLED AND AUTO-APPLY GATE INDEPENDENTLY. The sweep's guard is
 *      `lateFee.enabled !== true || lateFee.autoApply !== true`, i.e. an AND.
 *      A firm that flips `autoApply` on without also confirming `enabled`
 *      (or vice versa) must not get charged; either flag alone silently
 *      gating the sweep on would be a policy-confusion bug that charges (or
 *      fails to charge) real clients.
 *   2. AN INVOICE PAID BETWEEN SELECTION AND ACTION MUST NOT BE CHARGED.
 *      `findUnpaidByDue` selects overdue invoices, then the loop applies a
 *      fee to each one in turn under `runInvoiceTxn`'s row lock. If a payment
 *      lands on an invoice after it was selected but before its turn in the
 *      loop, charging it anyway would fee a client who has already paid.
 *      Proved with a real overlap (`gateMethod`), not `Promise.all` and hope.
 *   3. ONE INVOICE'S FAILURE MUST NOT COST ITS SIBLINGS OR OTHER FIRMS.
 *      `applyAutoLateFees` catches per-invoice, and `forEachFirm` catches
 *      per-firm, so a single throw should be invisible to every other
 *      invoice and firm in the same pass. Proved by forcing exactly one real
 *      call to reject (via the same gate's fault-injection side) and
 *      checking that everything else in the pass still landed.
 *
 * Kept in its own file (rather than added to `lateFeeCalculation.test.ts`)
 * specifically so the fault-injection test controls every firm and invoice
 * that exists when the sweep runs: this file's per-file DB truncation is the
 * isolation the test needs, since a stray leftover eligible invoice from an
 * earlier `it()` in the same file would silently steal the single injected
 * failure or the single gate arrival.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  drainEvents,
  request,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const invoicesService = require('../../src/modules/billing/invoices/invoices.service');

const CRON_SECRET = 'late-fee-isolation-cron-secret';

let savedCronSecret: string | undefined;
let savedRemindersDisabled: string | undefined;

beforeAll(() => {
  savedCronSecret = process.env.CRON_SECRET;
  savedRemindersDisabled = process.env.DISABLE_ALL_REMINDER_EMAILS;
});

afterAll(() => {
  if (savedCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedCronSecret;
  if (savedRemindersDisabled === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = savedRemindersDisabled;
});

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.DISABLE_ALL_REMINDER_EMAILS;
});

/** Fire the reminders pass the way Cloud Scheduler does with a secret configured. */
function runReminderCron() {
  return request().post('/api/cron/reminders').set('x-cron-secret', CRON_SECRET);
}

/** `offset` days from today, as the 'YYYY-MM-DD' a `date` column stores. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
}

/**
 * Turn on a firm's late-fee policy. Every field is written explicitly, so a
 * case that means to test only one flag still states the full policy rather
 * than inheriting whatever the default is.
 */
async function setLateFeePolicy(
  lawFirmId: string,
  policy: { enabled: boolean; autoApply: boolean; flatAmount?: number; percent?: number; graceDays?: number },
) {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing',
               coalesce(settings -> 'billing', '{}'::jsonb)
                 || jsonb_build_object('lateFee', $2::jsonb))
      where id = $1`,
    [lawFirmId, JSON.stringify({ flatAmount: 0, percent: 0, graceDays: 0, ...policy })],
  );
}

/** The stored money on one invoice, in cents, plus the flags the sweep filters on. */
async function row(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, balance_due_cents, is_paid, status
       from invoices where id = $1`,
    [invoiceId],
  );
  return {
    totalCents: Number(rows[0].total_cents),
    balanceDueCents: Number(rows[0].balance_due_cents),
    isPaid: rows[0].is_paid as boolean,
    status: rows[0].status as string,
  };
}

/** Every late-fee adjustment row on one invoice. Presence is the idempotency tag. */
async function lateFeeAdjustments(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_cents from invoice_adjustments where invoice_id = $1 and direction = 'charge' and kind = 'late_fee'`,
    [invoiceId],
  );
  return rows;
}

interface World {
  firm: Firm;
  client: ClientRecord;
  base: string;
  owner: Actor;
  seq: number;
}

async function makeWorld(name: string): Promise<World> {
  const firm = await createFirm({ name });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: `${name} Client` });
  return {
    firm,
    client,
    owner,
    base: `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`,
    seq: 0,
  };
}

/** An invoice through the real create route, so `status` matches what the app produces. */
async function issueInvoice(world: World, totalAmount: number, dueDate: string): Promise<string> {
  world.seq += 1;
  const res = await world.owner.api.post(world.base).send({
    invoiceName: `Invoice ${world.seq}`,
    invoiceDate: day(-60),
    dueDate,
    totalAmount,
    flatFeesAmount: totalAmount,
    flatFees: [{ description: 'Fixed fee', amount: totalAmount }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

/* ------------------------------------------------------------------ */
/*  1. enabled and auto-apply gate independently                       */
/* ------------------------------------------------------------------ */

describe('enabled and auto-apply gate the sweep independently', () => {
  it('charges only the firm with both flags true, in one pass with all three combinations present', async () => {
    // Both true: the only firm the sweep may touch.
    const both = await makeWorld('Both Flags LLP');
    await setLateFeePolicy(both.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    const bothInvoice = await issueInvoice(both, 1000, day(-30));

    // Auto-apply on, but the firm never turned late fees on at all. A sweep
    // that read `autoApply` alone (skipping the `enabled` half of the guard)
    // would charge this client with no live late-fee policy behind it.
    const autoOnly = await makeWorld('Auto Only Not Enabled LLP');
    await setLateFeePolicy(autoOnly.firm.id, { enabled: false, autoApply: true, flatAmount: 25 });
    const autoOnlyInvoice = await issueInvoice(autoOnly, 1000, day(-30));

    // Enabled, but never switched to automatic. The firm applies fees by
    // hand; a sweep that read `enabled` alone would take over their manual
    // process without being asked.
    const enabledOnly = await makeWorld('Enabled Only Manual LLP');
    await setLateFeePolicy(enabledOnly.firm.id, { enabled: true, autoApply: false, flatAmount: 25 });
    const enabledOnlyInvoice = await issueInvoice(enabledOnly, 1000, day(-30));

    const res = await runReminderCron();
    expect(res.status).toBe(200);
    expect(res.body.lateFees).toMatchObject({ applied: 1, skipped: 0, errors: 0 });
    await drainEvents();

    expect(await row(bothInvoice)).toMatchObject({ totalCents: 102_500, balanceDueCents: 102_500 });
    expect(await row(autoOnlyInvoice)).toMatchObject({ totalCents: 100_000, balanceDueCents: 100_000 });
    expect(await row(enabledOnlyInvoice)).toMatchObject({ totalCents: 100_000, balanceDueCents: 100_000 });
    expect(await lateFeeAdjustments(autoOnlyInvoice)).toHaveLength(0);
    expect(await lateFeeAdjustments(enabledOnlyInvoice)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  1b. a firm that never configured late fees                         */
/* ------------------------------------------------------------------ */

describe('a firm that never touched its late-fee settings', () => {
  // Red if the default ever turns late fees or auto-apply on: the brand-new
  // firm's overdue invoice would be charged. The configured firm in the same
  // pass proves the sweep ran and reached firms at all.
  it('is not charged, while a configured firm in the same pass is', async () => {
    const fresh = await makeWorld('Never Configured LLP');
    const freshInvoice = await issueInvoice(fresh, 1000, day(-30));
    const { rows } = await testPool.query('select settings from law_firms where id = $1', [fresh.firm.id]);
    expect(rows[0].settings.billing).toBeUndefined();

    const configured = await makeWorld('Configured LLP');
    await setLateFeePolicy(configured.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    const configuredInvoice = await issueInvoice(configured, 1000, day(-30));

    const res = await runReminderCron();
    expect(res.status).toBe(200);
    expect(res.body.lateFees).toMatchObject({ applied: 1, errors: 0 });
    await drainEvents();

    expect(await row(configuredInvoice)).toMatchObject({ totalCents: 102_500 });
    expect(await row(freshInvoice)).toMatchObject({ totalCents: 100_000, balanceDueCents: 100_000 });
    expect(await lateFeeAdjustments(freshInvoice)).toHaveLength(0);
  });

  // Turning late fees on through the settings screen's write path, with no
  // auto-apply field sent, must not switch on automatic charging. Red if the
  // nested defaults merge ever fills autoApply with anything but false.
  it('is not auto-charged after enabling late fees with only enabled and an amount sent', async () => {
    const partial = await makeWorld('Enabled Flag Only LLP');
    const put = await partial.owner.api
      .put(`/api/lawfirms/${partial.firm.id}/settings/firm`)
      .send({ settings: { billing: { lateFee: { enabled: true, flatAmount: 25 } } } });
    expect(put.status).toBe(200);
    const partialInvoice = await issueInvoice(partial, 1000, day(-30));

    const configured = await makeWorld('Auto LLP');
    await setLateFeePolicy(configured.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    await issueInvoice(configured, 1000, day(-30));

    const res = await runReminderCron();
    expect(res.status).toBe(200);
    expect(res.body.lateFees).toMatchObject({ applied: 1, errors: 0 });
    await drainEvents();

    expect(await row(partialInvoice)).toMatchObject({ totalCents: 100_000 });
    expect(await lateFeeAdjustments(partialInvoice)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  2. paid invoice between selection and action                       */
/* ------------------------------------------------------------------ */

describe('an invoice paid between selection and action', () => {
  it('is not charged when the payment lands while the sweep is mid-pass', async () => {
    const world = await makeWorld('Race Window LLP');
    await setLateFeePolicy(world.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    const id = await issueInvoice(world, 1000, day(-30));

    // Paused at the exact boundary the sweep calls per invoice, AFTER
    // `findUnpaidByDue` already selected this row as unpaid and overdue.
    const gate = gateMethod(invoicesService, 'applyLateFeeCore');
    try {
      // A bare `const cronCall = runReminderCron();` is an INERT, unsent
      // supertest `Test` object: superagent only dispatches once something
      // calls `.then()`/`.end()` on it, and neither `gate.arrived()` nor a
      // plain assignment does that (documented at the top of
      // `tests/billing/invoiceConcurrency.test.ts`, found the same way here:
      // the request never fired, so the gate waited the full timeout with
      // zero calls ever entering it). Wrapping it in an `async function` that
      // RETURNS the supertest chain works because returning a thenable from
      // an async function makes the language call `.then()` on it immediately
      // to adopt the resolution, which is what actually sends the request.
      async function fireCron() {
        return runReminderCron();
      }
      const cronCall = fireCron();
      await gate.arrived(1);

      // While the sweep is paused right before applying the fee, a real
      // payment (a different request, a different code path entirely) pays
      // the invoice off in full.
      const payment = await world.owner.api.put(`${world.base}/${id}/payment`)
        .send({ paymentAmount: 1000, isPaid: true, paidDate: day(-1) });
      expect(payment.status).toBe(200);
      expect(await row(id)).toMatchObject({ isPaid: true, balanceDueCents: 0 });

      // Now let the sweep's call through. `applyLateFeeCore` re-reads the
      // invoice under `runInvoiceTxn`'s row lock rather than trusting the
      // pre-selection snapshot, so it must see the payment and refuse.
      gate.open();
      const res = await cronCall;
      expect(res.status).toBe(200);
      expect(res.body.lateFees).toMatchObject({ applied: 0, skipped: 1, errors: 0 });
      await drainEvents();

      expect(await row(id)).toMatchObject({ totalCents: 100_000, balanceDueCents: 0, isPaid: true });
      expect(await lateFeeAdjustments(id)).toHaveLength(0);
    } finally {
      gate.restore();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  3. one invoice's failure does not cost its siblings or other firms  */
/* ------------------------------------------------------------------ */

describe('one invoice failing during the sweep', () => {
  it('still charges its sibling invoice and an unrelated firm in the same pass', async () => {
    // Two eligible invoices on one firm, so the pass has a sibling to lose
    // if a per-invoice failure aborted the firm's own loop.
    const flaky = await makeWorld('Flaky Firm LLP');
    await setLateFeePolicy(flaky.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    const flakyA = await issueInvoice(flaky, 1000, day(-30));
    const flakyB = await issueInvoice(flaky, 700, day(-30));

    // A second, entirely unrelated firm, so the pass has a NEXT FIRM to lose
    // if the failure escaped the per-invoice catch and reached `forEachFirm`.
    const other = await makeWorld('Unrelated Firm LLP');
    await setLateFeePolicy(other.firm.id, { enabled: true, autoApply: true, flatAmount: 25 });
    const otherInvoice = await issueInvoice(other, 500, day(-30));

    // The fault injector makes exactly the NEXT real call to
    // `applyLateFeeCore` reject, then lets every call after it run for real.
    // Which of the three invoices draws the failure is Postgres's row order,
    // not something this test controls or needs to: the property under test
    // is that the OTHER two land correctly and the response counts exactly
    // one error, not which invoice happened to be first.
    const gate = gateMethod(invoicesService, 'applyLateFeeCore');
    try {
      gate.failNext(new Error('simulated late-fee application failure'));
      gate.open();

      const res = await runReminderCron();
      expect(res.status).toBe(200);
      expect(res.body.lateFees).toMatchObject({ applied: 2, skipped: 0, errors: 1 });
      await drainEvents();

      const results = await Promise.all(
        [flakyA, flakyB, otherInvoice].map(async (id) => ({ id, ...(await row(id)) })),
      );

      const totals: Record<string, number> = { [flakyA]: 102_500, [flakyB]: 72_500, [otherInvoice]: 52_500 };
      const originals: Record<string, number> = { [flakyA]: 100_000, [flakyB]: 70_000, [otherInvoice]: 50_000 };

      const chargedIds = results.filter((r) => r.totalCents === totals[r.id]).map((r) => r.id);
      const failedIds = results.filter((r) => r.totalCents === originals[r.id]).map((r) => r.id);

      // Every row landed on exactly one of the two possible totals (charged
      // or untouched) -- nothing partially applied, nothing double-applied --
      // and exactly one of the three is the untouched one.
      expect(chargedIds.length + failedIds.length).toBe(3);
      expect(failedIds).toHaveLength(1);
      expect(chargedIds).toHaveLength(2);

      for (const id of failedIds) {
        expect(await lateFeeAdjustments(id)).toHaveLength(0);
      }
      for (const id of chargedIds) {
        expect(await lateFeeAdjustments(id)).toHaveLength(1);
      }
    } finally {
      gate.restore();
    }
  });
});
