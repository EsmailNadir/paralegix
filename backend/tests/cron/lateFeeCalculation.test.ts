/**
 * The automatic late-fee sweep, end to end, and what the fee is computed from.
 *
 * A late fee is money charged to a client by a job nobody watches. Three files
 * already touch it and none of them exercises the path that actually bills:
 *
 *   - `tests/billing/lateFeeMath.test.ts` pins `computeLateFeeCents` as pure
 *     arithmetic. It never learns what number is fed in.
 *   - `tests/billing/lateFees.service.test.ts` mocks `forEachFirm`, the
 *     repository AND `applyLateFeeCore`, so it pins the counting and the error
 *     isolation of `applyAutoLateFees` and nothing about which invoices the
 *     sweep selects or what it does to them.
 *   - `tests/billing/invoiceAdjustments.test.ts` drives the MANUAL route with a
 *     flat fee: enabled/not-enabled, inside grace, applied once, permission.
 *
 * So the gaps this file owns are the two halves the others structurally cannot
 * reach:
 *
 *   1. THE SWEEP AGAINST REAL ROWS, through `POST /api/cron/reminders` with
 *      nothing mocked. That is the only way `findUnpaidByDue`'s SQL predicate
 *      (`is_paid = false`, `status <> 'voided'`,
 *      `coalesce(next_payment_date, due_date) < current_date`) and the
 *      `autoApply` gate are executed at all. A mistake in either charges the
 *      wrong clients platform-wide at 3am and reports a cheerful 200.
 *   2. THE BASE THE FEE IS TAKEN ON. `applyLateFeeCore` passes
 *      `invoiceRemainingCents(existing)` into `computeLateFeeCents`. Swap that
 *      for the invoice total and every pure-math case stays green, every
 *      flat-fee case stays green, and every partly paid client is overcharged.
 *      Only a percentage fee on an invoice carrying a real payment can see it.
 *
 * Two things the sweep cases must respect:
 *
 *   - `findUnpaidByDue` compares against Postgres's `current_date`, which
 *     `freezeClockAt` does not move. Every sweep case therefore uses dates
 *     relative to the real today and never freezes the clock. The one case that
 *     does freeze it drives the manual route, where the day comparison is
 *     entirely in Node.
 *   - `.env` ships `DISABLE_ALL_REMINDER_EMAILS=true` and no `CRON_SECRET`, and
 *     CI ships neither. Both are set explicitly below rather than inherited, so
 *     this file behaves identically in both places, and the kill switch gets a
 *     case of its own on each side.
 *
 * Money is asserted in exact integer cents off the stored columns, including the
 * generated `balance_due_cents`, because the response agreeing with itself while
 * the row disagrees is the failure worth catching.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  drainEvents,
  freezeClockAt,
  ownerOf,
  request,
  as,
  tokenFor,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

const CRON_SECRET = 'late-fee-spec-cron-secret';

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
  // Branch 1 of `authorizeCronRequest`, chosen over the loopback developer
  // hatch so the pass is reachable regardless of NODE_ENV and of how supertest's
  // socket presents itself.
  process.env.CRON_SECRET = CRON_SECRET;
  // Off by default here. `.env` sets it, CI does not, and a late fee is money
  // rather than mail, so the sweep must behave the same either way. The case
  // that pins the switch turns it on itself.
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
 * Turn on the firm's late-fee policy.
 *
 * `getFirmBillingSettings` spreads the stored `billing` object over the
 * defaults SHALLOWLY, so a partial `lateFee` does not inherit the missing keys:
 * every field is written here. Late fees are off by default, and `autoApply` is
 * off separately, so a sweep case that forgot either would be asserting against
 * a policy refusal rather than against the fee logic.
 */
async function setLateFeePolicy(
  lawFirmId: string,
  policy: {
    enabled?: boolean;
    autoApply?: boolean;
    flatAmount?: number;
    percent?: number;
    graceDays?: number;
  },
) {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing',
               coalesce(settings -> 'billing', '{}'::jsonb)
                 || jsonb_build_object('lateFee', $2::jsonb))
      where id = $1`,
    [lawFirmId, JSON.stringify({
      enabled: true,
      autoApply: false,
      flatAmount: 0,
      percent: 0,
      graceDays: 0,
      ...policy,
    })],
  );
}

/** The stored money on one invoice, in cents, plus the two flags the sweep filters on. */
async function row(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, total_written_off_cents,
            balance_due_cents, is_paid, status
       from invoices where id = $1`,
    [invoiceId],
  );
  return {
    totalCents: Number(rows[0].total_cents),
    amountPaidCents: Number(rows[0].amount_paid_cents),
    writtenOffCents: Number(rows[0].total_written_off_cents),
    balanceDueCents: Number(rows[0].balance_due_cents),
    isPaid: rows[0].is_paid as boolean,
    status: rows[0].status as string,
  };
}

/** Every late-fee adjustment row on one invoice, oldest first. */
async function lateFeeAdjustments(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_cents, description as note, kind, created_by as added_by
       from invoice_adjustments
      where invoice_id = $1 and direction = 'charge' and kind = 'late_fee'
      order by sort_order`,
    [invoiceId],
  );
  return rows;
}

/**
 * One firm with an owner and a client, ready to be billed.
 *
 * Invoice names must be unique per firm (the name becomes the invoice number),
 * so the counter is per world rather than global.
 */
interface World {
  firm: Firm;
  owner: Actor;
  client: ClientRecord;
  base: string;
  seq: number;
}

async function makeWorld(name: string): Promise<World> {
  const firm = await createFirm({ name });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: `${name} Client` });
  return {
    firm,
    owner,
    client,
    base: `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`,
    seq: 0,
  };
}

/**
 * An invoice, created through the real create route rather than by
 * INSERT: `status` is written by the service from the live amounts, and the
 * sweep filters on that column, so a hand-built row would be testing a status
 * this app never produces.
 */
async function issueInvoice(
  world: World,
  { totalAmount, dueDate }: { totalAmount: number; dueDate: string | null },
): Promise<string> {
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
/*  The sweep, through the real cron route                             */
/* ------------------------------------------------------------------ */

describe('the automatic sweep, through POST /api/cron/reminders', () => {
  it('charges the auto-apply firm and leaves an identical invoice at another firm alone', async () => {
    const auto = await makeWorld('Auto Apply LLP');
    await setLateFeePolicy(auto.firm.id, { autoApply: true, flatAmount: 25 });
    const charged = await issueInvoice(auto, { totalAmount: 1000, dueDate: day(-30) });

    // Late fees ENABLED but not automatic. The firm applies them by hand, so the
    // cron must not do it for them. Same amount, same due date, same policy but
    // for the one flag, which is what makes the pair a real comparison.
    const manual = await makeWorld('Manual Only LLP');
    await setLateFeePolicy(manual.firm.id, { autoApply: false, flatAmount: 25 });
    const untouched = await issueInvoice(manual, { totalAmount: 1000, dueDate: day(-30) });

    const res = await runReminderCron();
    expect(res.status).toBe(200);
    expect(res.body.lateFees).toMatchObject({ applied: 1, skipped: 0, errors: 0 });
    await drainEvents();

    // $1,000 plus the $25 flat fee, in cents, and the generated balance column
    // agreeing with it.
    expect(await row(charged)).toMatchObject({ totalCents: 102_500, balanceDueCents: 102_500 });
    expect(await row(untouched)).toMatchObject({ totalCents: 100_000, balanceDueCents: 100_000 });
  });

  it('does not stack a second fee when the scheduler retries the pass', async () => {
    const world = await makeWorld('Retried Sweep LLP');
    await setLateFeePolicy(world.firm.id, { autoApply: true, flatAmount: 25 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    const first = await runReminderCron();
    expect(first.body.lateFees).toMatchObject({ applied: 1, skipped: 0 });
    await drainEvents();

    // Cloud Scheduler is at-least-once, so this is the ordinary case rather than
    // an exotic one. Idempotency here is the tagged adjustment row, not a
    // boolean column: `lateFeeEligibility` refuses an invoice that already
    // carries an adjustment of kind `late_fee`.
    const second = await runReminderCron();
    expect(second.body.lateFees).toMatchObject({ applied: 0, skipped: 1, errors: 0 });
    await drainEvents();

    expect(await row(id)).toMatchObject({ totalCents: 102_500 });
    expect(await lateFeeAdjustments(id)).toHaveLength(1);
  });

  it('charges past the grace period and not inside it, in the same pass', async () => {
    const world = await makeWorld('Grace Period LLP');
    await setLateFeePolicy(world.firm.id, { autoApply: true, flatAmount: 25, graceDays: 10 });

    // Both are overdue, so both are SELECTED by findUnpaidByDue and the split
    // between them is the grace rule alone.
    const pastGrace = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });
    const insideGrace = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-5) });

    const res = await runReminderCron();
    expect(res.body.lateFees).toMatchObject({ applied: 1, skipped: 1, errors: 0 });
    await drainEvents();

    expect(await row(pastGrace)).toMatchObject({ totalCents: 102_500 });
    expect(await row(insideGrace)).toMatchObject({ totalCents: 100_000 });
  });

  it('leaves an invoice whose next installment is not yet due alone', async () => {
    const world = await makeWorld('Payment Plan LLP');
    await setLateFeePolicy(world.firm.id, { autoApply: true, flatAmount: 25 });

    // A payment plan moves the effective due day onto the next installment. The
    // invoice's own dueDate is two months past, so an implementation that read
    // `due_date` alone would charge a client who is paying exactly on schedule.
    const onPlan = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-60) });
    await testPool.query(
      'update invoices set next_payment_date = $2 where id = $1',
      [onPlan, day(15)],
    );

    // Identical but for the installment date, so the exclusion above cannot be
    // an empty pass or a broken policy.
    const noPlan = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-60) });

    const res = await runReminderCron();
    expect(res.body.lateFees).toMatchObject({ applied: 1, errors: 0 });
    await drainEvents();

    expect(await row(onPlan)).toMatchObject({ totalCents: 100_000 });
    expect(await row(noPlan)).toMatchObject({ totalCents: 102_500 });
  });

  it('skips a voided and a settled invoice while charging the ordinary overdue one', async () => {
    const world = await makeWorld('Excluded Rows LLP');
    await setLateFeePolicy(world.firm.id, { autoApply: true, flatAmount: 25 });

    const voided = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });
    const voidRes = await world.owner.api.post(`${world.base}/${voided}/void`).send({});
    expect(voidRes.status).toBe(200);

    const settled = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });
    const paid = await world.owner.api.put(`${world.base}/${settled}/payment`)
      .send({ paymentAmount: 1000, isPaid: true, paidDate: day(-1) });
    expect(paid.status).toBe(200);
    expect(await row(settled)).toMatchObject({ isPaid: true, balanceDueCents: 0 });

    const ordinary = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    const res = await runReminderCron();
    expect(res.body.lateFees).toMatchObject({ applied: 1, errors: 0 });
    await drainEvents();

    // A voided invoice is cancelled and a settled invoice owes nothing;
    // charging either is charging a client for a debt that does not exist.
    expect(await row(voided)).toMatchObject({ totalCents: 100_000 });
    expect(await row(settled)).toMatchObject({ totalCents: 100_000, balanceDueCents: 0 });
    expect(await row(ordinary)).toMatchObject({ totalCents: 102_500 });
  });

  it('still charges the fee while DISABLE_ALL_REMINDER_EMAILS silences the mail', async () => {
    const world = await makeWorld('Kill Switch LLP');
    await setLateFeePolicy(world.firm.id, { autoApply: true, flatAmount: 25 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    process.env.DISABLE_ALL_REMINDER_EMAILS = 'true';
    const res = await runReminderCron();
    await drainEvents();

    // The switch is an EMAIL switch. `invoiceReminders` reports itself disabled
    // in the same response, which proves the flag was live for this pass rather
    // than ignored, and the fee lands anyway. Putting the money pass behind this
    // flag would silently stop revenue in an environment set up to be quiet.
    expect(res.body.invoiceReminders.disabled).toBe(true);
    expect(res.body.lateFees).toMatchObject({ applied: 1, errors: 0 });
    expect(res.body.lateFees.disabled).toBeUndefined();
    expect(await row(id)).toMatchObject({ totalCents: 102_500 });
  });
});

/* ------------------------------------------------------------------ */
/*  What the fee is taken on                                           */
/* ------------------------------------------------------------------ */

describe('the balance the fee is computed from', () => {
  let world: World;

  beforeEach(async () => {
    world = await makeWorld('Percentage LLP');
  });

  it('takes the percentage on what is still owed, not on the invoice total', async () => {
    await setLateFeePolicy(world.firm.id, { flatAmount: 25, percent: 10 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    const paid = await world.owner.api.put(`${world.base}/${id}/payment`)
      .send({ paymentAmount: 400, paidDate: day(-2) });
    expect(paid.status).toBe(200);
    expect(await row(id)).toMatchObject({ amountPaidCents: 40_000, balanceDueCents: 60_000 });

    const res = await world.owner.api.post(`${world.base}/${id}/late-fee`);
    expect(res.status).toBe(200);
    await drainEvents();

    // $25 flat plus 10% of the $600 REMAINING, which is $85. On the invoice
    // total it would be $125, and the invoice would read 112_500. Both figures
    // are reachable from the same correct arithmetic, so only a partly paid
    // invoice can tell the two apart.
    expect(res.body.lateFeeAmount).toBe(85);
    expect(await row(id)).toMatchObject({
      totalCents: 108_500,
      amountPaidCents: 40_000,
      balanceDueCents: 68_500,
    });
  });

  it('counts an amount written off as no longer owed', async () => {
    await setLateFeePolicy(world.firm.id, { flatAmount: 0, percent: 10 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    const credit = await world.owner.api.post(`${world.base}/${id}/credit-note`)
      .send({ amount: 600, type: 'write_off', description: 'Fee dispute' });
    expect([200, 201]).toContain(credit.status);
    expect(await row(id)).toMatchObject({ writtenOffCents: 60_000, balanceDueCents: 40_000 });

    const res = await world.owner.api.post(`${world.base}/${id}/late-fee`);
    expect(res.status).toBe(200);
    await drainEvents();

    // 10% of the $400 the firm still expects. A write-off is a debt the firm
    // gave up, so penalising the client on it charges them for money the firm
    // already agreed not to collect.
    expect(res.body.lateFeeAmount).toBe(40);
    expect(await row(id)).toMatchObject({ totalCents: 104_000, balanceDueCents: 44_000 });
  });

  it('records the charge as one tagged adjustment naming who applied it', async () => {
    await setLateFeePolicy(world.firm.id, { flatAmount: 25 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });

    const res = await world.owner.api.post(`${world.base}/${id}/late-fee`);
    expect(res.status).toBe(200);
    await drainEvents();

    // This row is not bookkeeping colour: `kind = 'late_fee'` IS the idempotency
    // key the eligibility check reads, so losing the tag silently re-arms the
    // charge on every cron pass. `amount_cents` is integer cents from a dollar
    // input, which is the other place a 100x error can hide.
    const adjustments = await lateFeeAdjustments(id);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({
      amount_cents: '2500',
      // The literal the product writes into the client-visible adjustment note.
      note: 'Late fee',
      kind: 'late_fee',
      added_by: world.owner.uid,
    });
  });

  it('refuses an invoice with nothing left owing and charges nothing', async () => {
    await setLateFeePolicy(world.firm.id, { flatAmount: 25 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: day(-30) });
    await world.owner.api.put(`${world.base}/${id}/payment`)
      .send({ paymentAmount: 1000, isPaid: true, paidDate: day(-1) });

    const res = await world.owner.api.post(`${world.base}/${id}/late-fee`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no outstanding balance/i);
    expect(await row(id)).toMatchObject({ totalCents: 100_000, balanceDueCents: 0 });
    expect(await lateFeeAdjustments(id)).toHaveLength(0);
  });

  it('refuses an invoice that has no due date at all', async () => {
    await setLateFeePolicy(world.firm.id, { flatAmount: 25 });
    const id = await issueInvoice(world, { totalAmount: 1000, dueDate: null });

    const res = await world.owner.api.post(`${world.base}/${id}/late-fee`);

    // With no due day there is no day to be past. Treating a missing date as
    // immediately overdue would charge every invoice a firm never dated.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no due date/i);
    expect(await row(id)).toMatchObject({ totalCents: 100_000 });
  });
});

/* ------------------------------------------------------------------ */
/*  Whose calendar day the grace period is measured in                 */
/* ------------------------------------------------------------------ */

describe('the calendar day the grace cutoff is measured in', () => {
  /**
   * 02:00 UTC on 16 March is still 22:00 on 15 March in New York, so at this one
   * instant the two zones disagree about what "today" is. An invoice due on the
   * 15th with no grace is therefore past due in UTC and not past due in New
   * York, and nothing but the caller's zone separates the two answers.
   *
   * Frozen rather than derived from the real clock: this is the only pair of
   * requests in the file whose result depends on the hour, and the manual route
   * compares days entirely in Node, so Postgres's own `current_date` (which
   * `freezeClockAt` cannot move) is not involved.
   */
  const INSTANT = '2026-03-16T02:00:00Z';
  const DUE_DAY = '2026-03-15';

  it('charges in a zone whose day has rolled over and refuses in one that has not', async () => {
    const world = await makeWorld('Timezone LLP');
    await setLateFeePolicy(world.firm.id, { flatAmount: 25, graceDays: 0 });

    // Two invoices, because a late fee is one-time: applying to a single invoice
    // twice would refuse the second call for `already_applied` and say nothing
    // about the zone.
    const forUtc = await issueInvoice(world, { totalAmount: 1000, dueDate: DUE_DAY });
    const forNewYork = await issueInvoice(world, { totalAmount: 1000, dueDate: DUE_DAY });

    const token = tokenFor({ uid: world.owner.uid });
    const utcCaller = as(token, 'UTC');
    const newYorkCaller = as(token, 'America/New_York');

    freezeClockAt(INSTANT);
    const utc = await utcCaller.post(`${world.base}/${forUtc}/late-fee`);
    const newYork = await newYorkCaller.post(`${world.base}/${forNewYork}/late-fee`);

    expect(utc.status).toBe(200);
    expect(newYork.status).toBe(400);
    expect(newYork.body.error).toMatch(/not yet past due/i);
    expect(await row(forUtc)).toMatchObject({ totalCents: 102_500 });
    expect(await row(forNewYork)).toMatchObject({ totalCents: 100_000 });
  });
});
