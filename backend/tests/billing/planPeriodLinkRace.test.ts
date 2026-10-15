/**
 * A period that produced an invoice stays linked to it.
 *
 * Every plans GET recomputes periods and upserts them. One that read a period
 * just before `createDraftFromPeriod` linked it would write back the unlinked
 * snapshot it read, reopening the period for a second draft and clearing the
 * coverage on its time. The stale write is replayed here directly against the
 * repository, which is exactly what that GET calls.
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
import plansRepo from '../../src/modules/billing/plans/plans.repository';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let planId: string;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;

const periodRow = async (start: string) => (await testPool.query(
  `select status, generated_invoice_id, amount_cents::text as amount_cents
     from billing_plan_periods where billing_plan_id = $1 and period_start_date = $2`,
  [planId, start],
)).rows[0];

const coverageOf = async (entryId: string) => (await testPool.query(
  'select billing_plan_period_id is not null as linked, coverage from activities where id = $1', [entryId],
)).rows[0];

/** What a GET computed for an UNLINKED period before the draft landed. */
const staleSnapshot = (start: string, end: string, amount = 500) => ({
  periodStartDate: start,
  periodEndDate: end,
  dueDate: end,
  status: 'ready_to_bill',
  amount,
  includedHours: 5,
  consumedHours: 0,
  overageHours: 0,
  coveredTimeEntryIds: [],
  overageTimeEntryIds: [],
  generatedInvoiceId: null,
  generatedInvoiceContextType: null,
  generatedInvoiceEntityId: null,
  generatedAt: null,
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Race Client' });
  const created = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours: 5,
  });
  expect(created.status).toBe(201);
  planId = created.body.plan.id;
  await drainEvents();
});

/**
 * Red without the `where generated_invoice_id is null` guard: the stale write
 * nulls the link, flips the status back to ready_to_bill, clears the entry's
 * coverage, and a second draft is then accepted.
 */
it('keeps the invoice link, the status and the coverage of a drafted period', async () => {
  const entry = await owner.api.post(`/api/lawfirms/${firm.id}/billing/time-entries`).send({
    clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
  });
  expect(entry.status).toBe(201);
  const entryId = entry.body.timeEntry.id;
  // A plan created after the time exists generates its periods with that entry
  // recorded as covered by March. (Periods behind a plan's run date are not
  // recomputed by later reads, so the coverage has to be written at creation.)
  const created = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Second', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours: 5,
  });
  expect(created.status).toBe(201);
  planId = created.body.plan.id;
  expect(await coverageOf(entryId)).toEqual({ linked: true, coverage: 'covered' });

  const drafted = await owner.api.post(`${P()}/${planId}/periods/2026-03-01/create-draft`).send({});
  expect(drafted.status).toBe(201);
  const invoiceId = drafted.body.invoice.id;
  expect(await periodRow('2026-03-01')).toMatchObject({ status: 'draft_created', generated_invoice_id: invoiceId });

  await plansRepo.upsertPeriods(firm.id, planId, [staleSnapshot('2026-03-01', '2026-03-31')]);

  expect(await periodRow('2026-03-01')).toMatchObject({ status: 'draft_created', generated_invoice_id: invoiceId });
  expect(await coverageOf(entryId)).toEqual({ linked: true, coverage: 'covered' });

  const again = await owner.api.post(`${P()}/${planId}/periods/2026-03-01/create-draft`).send({});
  expect(again.status).toBe(400);
  const count = await testPool.query('select count(*)::int c from invoices where billing_plan_id = $1', [planId]);
  expect(count.rows[0].c).toBe(1);
});

/** Regression: an unlinked period is still rewritten. Red if the guard is inverted. */
it('still updates a period that has no invoice', async () => {
  expect((await periodRow('2026-04-01')).amount_cents).toBe('50000');

  await plansRepo.upsertPeriods(firm.id, planId, [staleSnapshot('2026-04-01', '2026-04-30', 700)]);

  expect(await periodRow('2026-04-01')).toMatchObject({ amount_cents: '70000', generated_invoice_id: null });
});
