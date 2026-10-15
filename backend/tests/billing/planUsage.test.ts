/**
 * Retainer usage: which time a plan period counts against its included hours,
 * and what it bills as overage.
 *
 * Non-billable time is written off: it never reaches an invoice
 * (`createInvoice` refuses it). A period that counted it would hand the
 * allowance to work the client is not paying for, and when that work fell into
 * overage the draft would be refused forever.
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

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;
const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

/** Log time against the client at $200/h and return its id. */
async function logTime(hours: number, date: string, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, hourlyRate: 200, description: 'Work', ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

/** A monthly $500 client retainer starting 2026-03-01. */
async function createPlan(includedHours: number) {
  const res = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours,
  });
  expect(res.status).toBe(201);
  return res.body.plan.id as string;
}

/** The March period as the plans list reports it (a fresh recompute). */
async function marchPeriod(planId: string) {
  const res = await owner.api.get(P());
  expect(res.status).toBe(200);
  const plan = res.body.plans.find((p: any) => p.id === planId);
  return plan.periods.find((p: any) => p.id === '2026-03-01');
}

const draft = (planId: string) =>
  owner.api.post(`${P()}/${planId}/periods/2026-03-01/create-draft`).send({});

const invoiceTotal = async (invoiceId: string) => Number((await testPool.query(
  'select total_cents from invoices where id = $1', [invoiceId],
)).rows[0].total_cents);

const timeLines = async (invoiceId: string) => (await testPool.query(
  `select source_id, quantity::text as quantity, amount_cents::text as amount_cents
     from invoice_line_items where invoice_id = $1 and kind = 'time_entry' order by source_id`,
  [invoiceId],
)).rows;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Retainer Client' });
  await drainEvents();
});

describe('non-billable time and the allowance', () => {
  /**
   * Red if `billable === false` entries are counted: the non-billable hour
   * (dated first) takes the whole allowance and the billable hour becomes
   * overage.
   */
  it('does not let non-billable time consume included hours', async () => {
    const writtenOff = await logTime(1, '2026-03-05', { billable: false });
    const billable = await logTime(1, '2026-03-10');
    const planId = await createPlan(1);

    const period = await marchPeriod(planId);

    expect(period.consumedHours).toBe(1);
    expect(period.overageHours).toBe(0);
    expect(period.coveredTimeEntryIds).toEqual([billable]);
    expect(period.overageTimeEntryIds).toEqual([]);
    expect(period.coveredTimeEntryIds).not.toContain(writtenOff);
  });

  /**
   * Red if non-billable time reaches the overage list: `createInvoice` refuses
   * it and the draft answers 400 for this period on every attempt.
   */
  it('drafts an invoice for a period whose overage window holds non-billable time', async () => {
    await logTime(1, '2026-03-05');
    await logTime(2, '2026-03-10', { billable: false });
    const planId = await createPlan(1);

    const res = await draft(planId);

    expect(res.status).toBe(201);
    expect(await invoiceTotal(res.body.invoice.id)).toBe(50_000);
    expect(await timeLines(res.body.invoice.id)).toEqual([]);
  });

  /**
   * Regression: billable overage is still billed. Red if the filter drops
   * billable entries too (total would be 50_000 with no time line).
   */
  it('still bills billable overage at the entry rate', async () => {
    const billable = await logTime(1.5, '2026-03-05');
    const planId = await createPlan(1);

    const res = await draft(planId);

    expect(res.status).toBe(201);
    // $500 retainer + 0.5h overage at $200 = $600.
    expect(await invoiceTotal(res.body.invoice.id)).toBe(60_000);
    const lines = await timeLines(res.body.invoice.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].source_id).toBe(billable);
    expect(Number(lines[0].quantity)).toBe(0.5);
    expect(lines[0].amount_cents).toBe('10000');
  });
});

describe('the allowance is exact arithmetic', () => {
  /**
   * 0.3 - 0.1 - 0.1 is 0.09999999999999998 in binary floats, which is less
   * than the third 0.1h entry. Red with float subtraction: the third entry is
   * listed as overage with a ~3e-17h remainder.
   */
  it('uses a 0.3h allowance on three 0.1h entries with no overage', async () => {
    const ids = [
      await logTime(0.1, '2026-03-02'),
      await logTime(0.1, '2026-03-03'),
      await logTime(0.1, '2026-03-04'),
    ];
    const planId = await createPlan(0.3);

    const period = await marchPeriod(planId);

    expect(period.overageTimeEntryIds).toEqual([]);
    expect(period.overageHours).toBe(0);
    expect(period.consumedHours).toBe(0.3);
    expect([...period.coveredTimeEntryIds].sort()).toEqual([...ids].sort());
  });

  /** The draft from that period carries the retainer and no time line. */
  it('drafts that period with no time line', async () => {
    await logTime(0.1, '2026-03-02');
    await logTime(0.1, '2026-03-03');
    await logTime(0.1, '2026-03-04');
    const planId = await createPlan(0.3);

    const res = await draft(planId);

    expect(res.status).toBe(201);
    expect(await timeLines(res.body.invoice.id)).toEqual([]);
    expect(await invoiceTotal(res.body.invoice.id)).toBe(50_000);
  });

  /** Boundary: a real 0.1h overage is still found and priced exactly. */
  it('bills exactly 0.1h of overage on 0.4h of work against 0.3h included', async () => {
    await logTime(0.1, '2026-03-02');
    await logTime(0.1, '2026-03-03');
    const straddler = await logTime(0.2, '2026-03-04');
    const planId = await createPlan(0.3);

    const period = await marchPeriod(planId);
    // A straddling entry is stored as covered (it is partly inside the
    // allowance); only the overage hours and the draft's line carry the rest.
    expect(period.coveredTimeEntryIds).toContain(straddler);
    expect(period.overageHours).toBe(0.1);

    const res = await draft(planId);
    expect(res.status).toBe(201);
    // $500 + 0.1h at $200.
    expect(await invoiceTotal(res.body.invoice.id)).toBe(52_000);
    const lines = await timeLines(res.body.invoice.id);
    expect(lines.map((l: any) => [l.source_id, Number(l.quantity), l.amount_cents]))
      .toEqual([[straddler, 0.1, '2000']]);
  });

  /**
   * Ten 0.1h entries against 1.0h. Passes before the fix as well (the float
   * drift on this sequence runs upward, leaving 1.4e-16h spare); kept as a
   * regression guard.
   */
  it('uses a 1.0h allowance on ten 0.1h entries with no overage', async () => {
    for (let day = 1; day <= 10; day += 1) {
      await logTime(0.1, `2026-03-${String(day).padStart(2, '0')}`);
    }
    const planId = await createPlan(1);

    const period = await marchPeriod(planId);

    expect(period.overageTimeEntryIds).toEqual([]);
    expect(period.consumedHours).toBe(1);
  });
});
