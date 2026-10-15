/**
 * Tying money to instalments, and taking it back off again.
 *
 * `invoiceInstallments.test.ts` covers the schedule a plan generates.
 * This file covers what happens once real money lands on it: a payment named
 * against a particular instalment, a payment that falls short of one, a payment
 * that overshoots, and the two reversal paths (un-paying an instalment, and
 * deleting a credit note) that have to put the balance back exactly where it
 * was.
 *
 * The invariant every case here checks is the one a firm cannot eyeball: the
 * instalments still PENDING must sum to exactly what the invoice still says is
 * owed. When they drift apart nothing on any screen looks wrong; the client
 * simply pays the schedule and either underpays the bill or overpays it, and
 * the difference surfaces months later as an unexplained balance.
 *
 * A short payment against an instalment has three configured outcomes, and they
 * move the money in three genuinely different directions:
 *   add_to_next     - the shortfall is pushed onto a later instalment
 *   add_to_current  - the instalment stays open for the remainder
 *   write_off       - the shortfall is forgiven, as a credit note
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

/** The invoice's money columns, including the generated balance. */
async function row() {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, total_written_off_cents,
            balance_due_cents, is_paid, next_payment_date
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The instalment schedule in payment order. */
async function installments() {
  const { rows } = await testPool.query(
    `select amount_cents, due_date, status, matched_payment_index
       from invoice_expected_payments where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows;
}

/** The recorded payments in the order the invoice holds them. */
async function payments() {
  const { rows } = await testPool.query(
    `select amount_cents, payment_date from invoice_payments
      where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows;
}

async function creditNotes() {
  const { rows } = await testPool.query(
    `select external_id as credit_id, amount_cents, kind as type, description from invoice_adjustments
      where invoice_id = $1 and direction = 'credit' order by sort_order`,
    [invoiceId],
  );
  return rows;
}

/** Cents still scheduled to be collected. */
const pendingCents = async () =>
  (await installments())
    .filter((i: any) => i.status !== 'paid')
    .reduce((sum: number, i: any) => sum + Number(i.amount_cents), 0);

/** A four-instalment plan of $250 over the $1,000 invoice. */
async function setPlan() {
  const res = await owner.api.post(onInvoice('/payment-plan')).send({
    installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01',
  });
  expect(res.status).toBe(200);
  expect((await installments()).map((i: any) => Number(i.amount_cents)))
    .toEqual([25_000, 25_000, 25_000, 25_000]);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Instalment Client' });

  const created = await owner.api.post(B()).send({
    invoiceName: 'Plan Invoice',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: 1000,
    flatFeesAmount: 1000,
    flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('a payment named against one instalment', () => {
  it('settles exactly that instalment and points it at the payment', async () => {
    await setPlan();

    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: 1,
    });

    expect(res.status).toBe(200);
    const after = await installments();
    // The SECOND instalment, not the first. A payment credited to the wrong row
    // leaves an instalment the client paid still showing as owed, and settles
    // one they have not reached.
    expect(after.map((i: any) => i.status)).toEqual(['pending', 'paid', 'pending', 'pending']);
    // The pointer back into `payments[]` is what makes the payment reversible
    // later; a null here strands the money.
    expect(after[1].matched_payment_index).toBe(0);
    // Settling an instalment must not rewrite the rest of the schedule. Reading
    // the amount and date off the wrong row is invisible here (all four are
    // $250) except in the dates, so they are pinned: the settled row has to keep
    // its own 1 May, not inherit the 1 April of the instalment before it.
    expect(after.map((i: any) => i.due_date))
      .toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
    expect(await pendingCents()).toBe(Number((await row()).balance_due_cents));
  });

  it('cascades an overpayment onto the instalments that follow it', async () => {
    await setPlan();

    // $600 against a $250 instalment: the first two are covered outright and
    // $100 lands on the third.
    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 600, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect(res.status).toBe(200);

    const after = await installments();
    expect(after.map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [25_000, 'paid'], [25_000, 'paid'], [15_000, 'pending'], [25_000, 'pending'],
    ]);
    // Both settled instalments trace back to the single payment that covered
    // them, so reversing that payment can find every instalment it touched.
    expect(after[0].matched_payment_index).toBe(0);
    expect(after[1].matched_payment_index).toBe(0);
    // $400 left owed, $400 left scheduled.
    expect(Number((await row()).balance_due_cents)).toBe(40_000);
    expect(await pendingCents()).toBe(40_000);
  });

  it('allocates an unnamed payment from the front of the schedule', async () => {
    await setPlan();

    // No installmentIndex: the money goes against the oldest open instalment
    // and stops there, part-paying it rather than being spread across all four.
    const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });
    expect(res.status).toBe(200);

    expect((await installments()).map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [15_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'],
    ]);
    expect(await pendingCents()).toBe(90_000);
    expect(Number((await row()).balance_due_cents)).toBe(90_000);
  });
});

describe('a payment that falls short of its instalment', () => {
  it('pushes the shortfall onto the next instalment when asked to', async () => {
    await setPlan();

    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 150, paidDate: '2026-04-01', installmentIndex: 0, shortfallAction: 'add_to_next',
    });
    expect(res.status).toBe(200);

    // The instalment closes at what was actually received, and the missing
    // $100 is carried, not forgiven: instalment two is now $350.
    expect((await installments()).map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [15_000, 'paid'], [35_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'],
    ]);
    const stored = await row();
    expect(Number(stored.total_written_off_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(85_000);
    expect(await pendingCents()).toBe(85_000);
  });

  it('keeps the instalment open for the remainder when asked to', async () => {
    await setPlan();

    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 150, paidDate: '2026-04-01', installmentIndex: 0, shortfallAction: 'add_to_current',
    });
    expect(res.status).toBe(200);

    // Same money in, a different schedule out: the instalment stays pending for
    // the $100 still due on its own date, instead of moving to the next one.
    expect((await installments()).map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [10_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'],
    ]);
    expect(Number((await row()).balance_due_cents)).toBe(85_000);
    expect(await pendingCents()).toBe(85_000);
  });

  it('gives the instalment its full amount back when the payment is removed', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 150, paidDate: '2026-04-01', installmentIndex: 0, shortfallAction: 'add_to_current',
    });

    const removed = await owner.api.delete(onInvoice('/payment?paymentIndex=0'));
    expect(removed.status).toBe(200);

    // 'add_to_current' rewrites the instalment down to what is still due on it.
    // Removing the payment gives that money back to the client, so an instalment
    // left at the reduced figure would under-collect the invoice for good, with
    // no record anywhere of the $100 that went missing.
    expect(await pendingCents()).toBe(100_000);
    expect(Number((await row()).balance_due_cents)).toBe(100_000);
  });

  it('forgives the shortfall as a credit note when asked to', async () => {
    await setPlan();

    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 150, paidDate: '2026-04-01', installmentIndex: 0, shortfallAction: 'write_off',
    });
    expect(res.status).toBe(200);

    // The only one of the three that reduces what the client owes rather than
    // moving it. The forgiveness has to be recorded as a credit note, or the
    // firm has written off $100 with nothing on the books saying who did it.
    const notes = await creditNotes();
    expect(notes).toHaveLength(1);
    expect(Number(notes[0].amount_cents)).toBe(10_000);
    expect(notes[0].type).toBe('write_off');
    expect(notes[0].description).toMatch(/installment #1/i);

    const stored = await row();
    expect(Number(stored.amount_paid_cents)).toBe(15_000);
    expect(Number(stored.total_written_off_cents)).toBe(10_000);
    // 1000 - 150 received - 100 forgiven.
    expect(Number(stored.balance_due_cents)).toBe(75_000);
    // The instalments left standing carry exactly that, with the forgiven $100
    // gone from the schedule rather than lingering on a later date.
    expect(await pendingCents()).toBe(75_000);
  });

  it('keeps the instalment open for the remainder when no shortfall action is given', async () => {
    await setPlan();

    // No shortfallAction behaves like 'add_to_current', so the open rows always
    // sum to the balance the invoice still owes.
    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 150, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect(res.status).toBe(200);

    const after = await installments();
    expect(after[0]).toMatchObject({ status: 'pending', amount_cents: '10000' });
    expect((await installments()).map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [10_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'],
    ]);
    expect(await pendingCents()).toBe(85_000);
    expect(Number((await row()).balance_due_cents)).toBe(85_000);
  });
});

describe('un-paying an instalment', () => {
  const unpay = (index: number) =>
    owner.api.delete(onInvoice(`/payment-plan/installment/${index}/payment`));

  it('removes the payment it was tied to and restores the balance', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect(Number((await row()).amount_paid_cents)).toBe(25_000);

    const res = await unpay(0);
    expect(res.status).toBe(200);

    // Reversing an instalment has to take the money off the invoice as well as
    // reopening the row. Leaving `amount_paid_cents` at 25,000 with no payment
    // behind it is a balance the firm can never reconcile.
    const stored = await row();
    expect(Number(stored.amount_paid_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(100_000);
    expect(await payments()).toHaveLength(0);
    expect((await installments())[0]).toMatchObject({ status: 'pending', matched_payment_index: null });
  });

  it('re-points the surviving instalments at the payments that moved', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250, installmentIndex: 0 });
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250, installmentIndex: 1 });
    expect((await installments()).map((i: any) => i.matched_payment_index)).toEqual([0, 1, null, null]);

    const res = await unpay(0);
    expect(res.status).toBe(200);

    // Removing payments[0] shifts payments[1] down to index 0, so the second
    // instalment's pointer has to follow it.
    expect(await payments()).toHaveLength(1);
    expect((await installments())[1].matched_payment_index).toBe(0);
    expect(Number((await row()).amount_paid_cents)).toBe(25_000);
  });

  it('can still reverse the second instalment after the first was reversed', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250, installmentIndex: 0 });
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250, installmentIndex: 1 });
    await unpay(0);

    const res = await unpay(1);
    expect(res.status).toBe(200);

    // The consequence of the re-pointing above, and the reason it matters. A
    // stale pointer aims past the end of `payments[]`, so this reversal would
    // remove nothing: the invoice would report $250 collected with no payment
    // on it, and a balance $250 short of the truth forever.
    expect(await payments()).toHaveLength(0);
    const stored = await row();
    expect(Number(stored.amount_paid_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(100_000);
    expect((await installments()).map((i: any) => i.status))
      .toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('refuses to reverse an instalment nobody has paid', async () => {
    await setPlan();

    const res = await unpay(2);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not paid/i);
    // Prove the refusal left the money alone rather than asserting an absence
    // against an invoice that never had a payment on it.
    expect(Number((await row()).amount_paid_cents)).toBe(0);
    expect(await pendingCents()).toBe(100_000);
  });

  it('refuses an instalment index past the end of the schedule', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250, installmentIndex: 0 });

    const res = await unpay(9);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer exists/i);
    expect(Number((await row()).amount_paid_cents)).toBe(25_000);
  });
});

describe('reversing a credit note', () => {
  /** Write off `amount` against the invoice and return the credit note's id. */
  async function writeOff(amount: number) {
    const res = await owner.api.post(onInvoice('/credit-note')).send({
      amount, type: 'write_off', description: `Write off ${amount}`,
    });
    expect(res.status).toBe(200);
    const notes = await creditNotes();
    return notes[notes.length - 1].credit_id;
  }

  const remove = (creditNoteId: string) =>
    owner.api.delete(onInvoice(`/credit-note?creditNoteId=${creditNoteId}`));

  it('puts back exactly the balance it removed', async () => {
    const noteId = await writeOff(300);
    expect(Number((await row()).balance_due_cents)).toBe(70_000);

    const res = await remove(noteId);

    expect(res.status).toBe(200);
    const stored = await row();
    expect(Number(stored.total_written_off_cents)).toBe(0);
    // Back to the full bill. A reversal that moved the balance the other way,
    // or not at all, leaves the firm chasing or forgiving the wrong figure.
    expect(Number(stored.balance_due_cents)).toBe(100_000);
    expect(await creditNotes()).toHaveLength(0);
  });

  it('recomputes the written-off total from the notes that survive', async () => {
    const first = await writeOff(300);
    await writeOff(150.25);
    expect(Number((await row()).total_written_off_cents)).toBe(45_025);

    const res = await remove(first);
    expect(res.status).toBe(200);

    // Only the deleted note's value comes back; the other write-off stands.
    // 150.25 is deliberately not a round figure, so a cents conversion that
    // dropped the fraction would show here.
    const stored = await row();
    expect(Number(stored.total_written_off_cents)).toBe(15_025);
    expect(Number(stored.balance_due_cents)).toBe(84_975);
    expect(await creditNotes()).toHaveLength(1);
  });

  it('reopens an invoice that the write-off had settled', async () => {
    const noteId = await writeOff(1000);
    const settled = await row();
    // Forgiven money was not collected, so the settled invoice is not marked paid.
    expect(settled.is_paid).toBe(false);
    expect(Number(settled.balance_due_cents)).toBe(0);

    const res = await remove(noteId);
    expect(res.status).toBe(200);

    const stored = await row();
    // The whole point of the reversal. An invoice left flagged settled while a
    // full $1,000 is owed drops out of every outstanding list and every
    // reminder run, and nobody ever chases it.
    expect(stored.is_paid).toBe(false);
    expect(Number(stored.balance_due_cents)).toBe(100_000);
    expect(res.body.invoice.status).not.toBe('paid');
    expect(res.body.invoice.remainingBalance).toBe(1000);
  });

  it('keeps a settled invoice settled when the payment, not the credit, cleared it', async () => {
    // $700 collected and $300 forgiven. Reversing the credit leaves $300 owed,
    // so the invoice must reopen; this pins that the reopen decision reads the
    // live balance rather than "was there a payment".
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 700 });
    expect(paid.status).toBe(200);
    const noteId = await writeOff(300);
    expect((await row()).is_paid).toBe(false);

    const res = await remove(noteId);
    expect(res.status).toBe(200);

    const stored = await row();
    expect(stored.is_paid).toBe(false);
    expect(Number(stored.amount_paid_cents)).toBe(70_000);
    expect(Number(stored.balance_due_cents)).toBe(30_000);
  });

  it('refuses a credit note that is not on this invoice', async () => {
    await writeOff(300);

    const res = await remove('cn_not_a_real_note');

    expect(res.status).toBe(404);
    // The write-off that IS there must survive the failed delete.
    expect(await creditNotes()).toHaveLength(1);
    expect(Number((await row()).balance_due_cents)).toBe(70_000);
  });

  it('refuses a delete that names no credit note at all', async () => {
    await writeOff(300);

    const res = await owner.api.delete(onInvoice('/credit-note'));

    expect(res.status).toBe(400);
    expect(await creditNotes()).toHaveLength(1);
    expect(Number((await row()).total_written_off_cents)).toBe(30_000);
  });
});

/**
 * The schedule against every balance change. Both were REAL DEFECTS and both are
 * now fixed; these are the regressions.
 *
 * `rebalancePendingInstallments` exists precisely because regenerating a whole
 * schedule discards instalments that have already been collected.
 * `addCreditNote`, `deleteCreditNote` and `deletePayment` used to call
 * `rebuildSchedule` instead, and `editPayment` did not touch the schedule at
 * all. Every balance-changing path now rebalances only the pending tail.
 *
 * This block used to say both tests were EXPECTED TO FAIL. That is no longer
 * true and the wording mattered: it told a reader to ignore exactly the two
 * failures that would mean the fix had been undone.
 */
describe('the schedule follows every balance change', () => {
  it('a write-off must not erase an instalment the client already paid', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect((await installments())[0]).toMatchObject({ status: 'paid', matched_payment_index: 0 });

    const res = await owner.api.post(onInvoice('/credit-note')).send({ amount: 200, type: 'write_off' });
    expect(res.status).toBe(200);

    const after = await installments();
    // `addCreditNote` used to regenerate the whole schedule from the plan start
    // date, which brought the collected instalment back as pending, on a date the
    // client had already paid, with its link to `payments[0]` gone. The payment
    // row survives either way, so the invoice balance stayed right at $550 and
    // nothing on screen looked wrong: the only symptom was the plan showing the
    // client owing an instalment they had settled, immediately overdue, and
    // `unpayInstallment` refusing to reverse that payment at all because the row
    // no longer read as paid.
    //
    // Every balance-changing path now rebalances only the pending tail.
    expect(after[0]).toMatchObject({ status: 'paid', matched_payment_index: 0 });
    expect(after.filter((i: any) => i.status === 'paid')).toHaveLength(1);
  });

  it('correcting a payment amount must refit the schedule to the new balance', async () => {
    await setPlan();
    await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: 0,
    });

    // The firm corrects a mis-keyed payment: $250 was really $100.
    const edited = await owner.api.patch(onInvoice('/payment')).send({ paymentIndex: 0, amount: 100 });
    expect(edited.status).toBe(200);
    expect(Number((await row()).balance_due_cents)).toBe(90_000);

    // `editPayment` used to return without touching the payment plan, so the
    // schedule went on showing instalment one settled at $250 and only $750
    // pending against $900 owed. The client would pay the plan to its end and be
    // left $150 short, with every screen agreeing with itself along the way,
    // which is why nothing caught it.
    expect(await pendingCents()).toBe(90_000);
  });
});

describe('the end of the schedule', () => {
  it('adds an instalment a month after the last one when a shortfall on the LAST instalment has nowhere to go', async () => {
    // 'add_to_next' carries the missing money forward. On the final instalment
    // there is no next one, and dropping the shortfall would quietly forgive it.
    await setPlan();
    for (const index of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- instalments are paid in order
      const paid = await owner.api.put(onInvoice('/payment')).send({
        paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: index,
      });
      expect(paid.status).toBe(200);
    }
    const lastDue = (await installments())[3].due_date;

    const res = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 149.99, paidDate: '2026-07-01', installmentIndex: 3, shortfallAction: 'add_to_next',
    });

    expect(res.status).toBe(200);
    const schedule = await installments();
    expect(schedule.map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [25_000, 'paid'], [25_000, 'paid'], [25_000, 'paid'], [14_999, 'paid'], [10_001, 'pending'],
    ]);
    const nextMonth = new Date(`${lastDue}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    expect(schedule[4].due_date).toBe(nextMonth.toISOString().slice(0, 10));
    expect(Number((await row()).balance_due_cents)).toBe(10_001);
    expect(await pendingCents()).toBe(10_001);
  });

  it('marks every instalment paid, and clears the next payment date, when the invoice is marked paid outright', async () => {
    await setPlan();

    const res = await owner.api.put(onInvoice('/payment')).send({ isPaid: true });

    expect(res.status).toBe(200);
    expect((await installments()).map((i: any) => i.status)).toEqual(['paid', 'paid', 'paid', 'paid']);
    const stored = await row();
    expect(stored.is_paid).toBe(true);
    expect(Number(stored.amount_paid_cents)).toBe(100_000);
    expect(Number(stored.balance_due_cents)).toBe(0);
    expect(stored.next_payment_date).toBeNull();
  });

  it('moves only the next payment date when that is all the request names', async () => {
    const res = await owner.api.put(onInvoice('/payment')).send({ nextPaymentDate: '2026-05-15' });

    expect(res.status).toBe(200);
    const stored = await row();
    expect(stored.next_payment_date).toBe('2026-05-15');
    expect(Number(stored.amount_paid_cents)).toBe(0);
    expect(await payments()).toEqual([]);
  });
});

describe('adding an amount to an invoice', () => {
  it('reopens a paid invoice and schedules the added amount after the last instalment', async () => {
    // Work found after the invoice was settled. The invoice owes money again,
    // so it cannot stay marked paid, and on a payment plan the new money needs
    // a date or nothing ever asks the client for it.
    await setPlan();
    expect((await owner.api.put(onInvoice('/payment')).send({ isPaid: true })).status).toBe(200);
    const lastDue = (await installments())[3].due_date;

    const res = await owner.api.patch(onInvoice('/add-amount')).send({ amount: 123.45, note: 'Late filing fee' });

    expect(res.status).toBe(200);
    const stored = await row();
    expect(stored.is_paid).toBe(false);
    expect(Number(stored.total_cents)).toBe(112_345);
    expect(Number(stored.balance_due_cents)).toBe(12_345);
    const schedule = await installments();
    expect(schedule.map((i: any) => [Number(i.amount_cents), i.status])).toEqual([
      [25_000, 'paid'], [25_000, 'paid'], [25_000, 'paid'], [25_000, 'paid'], [12_345, 'pending'],
    ]);
    const nextMonth = new Date(`${lastDue}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    expect(schedule[4].due_date).toBe(nextMonth.toISOString().slice(0, 10));
    expect(await pendingCents()).toBe(12_345);
  });

  it('schedules the added amount on a plan still being paid, a month after its last instalment', async () => {
    await setPlan();
    const pendingDue = (await installments())[3].due_date;

    const res = await owner.api.patch(onInvoice('/add-amount')).send({ amount: 50 });

    expect(res.status).toBe(200);
    const schedule = await installments();
    expect(schedule.map((i: any) => Number(i.amount_cents))).toEqual([25_000, 25_000, 25_000, 25_000, 5_000]);
    const nextMonth = new Date(`${pendingDue}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    expect(schedule[4].due_date).toBe(nextMonth.toISOString().slice(0, 10));
    expect(Number((await row()).balance_due_cents)).toBe(105_000);
    expect(await pendingCents()).toBe(105_000);
  });
});
