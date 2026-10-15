/**
 * Retainer coverage against the invoice composer and the period lifecycle.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;
const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

async function logTime(hours: number, date: string, rate = 200) {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, hourlyRate: rate, description: 'Work',
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}
async function createPlan(includedHours: number, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.plan.id as string;
}
const period = async (planId: string, id = '2026-03-01') => {
  const res = await owner.api.get(P());
  return res.body.plans.find((p: any) => p.id === planId).periods.find((p: any) => p.id === id);
};
const draft = (planId: string, id = '2026-03-01') => owner.api.post(`${P()}/${planId}/periods/${id}/create-draft`).send({});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Retainer Client', email: 'ret@example.test' });
  await drainEvents();
});

it('shows hours logged after the period opened in that period usage', async () => {
  const planId = await createPlan(10);
  const entry = await logTime(2, '2026-03-10');

  const p = await period(planId);

  expect({ consumed: p.consumedHours, covered: p.coveredTimeEntryIds }).toEqual({ consumed: 2, covered: [entry] });
});

it('does not offer retainer-covered hours as unbilled work in the composer', async () => {
  const covered = await logTime(2, '2026-03-10');
  const planId = await createPlan(10);
  expect((await period(planId)).coveredTimeEntryIds).toEqual([covered]);

  const res = await owner.api.get(`${INV()}/unbilled-summary`);

  expect(res.status).toBe(200);
  expect(res.body.unbilledTimeEntries.map((e: any) => e.id)).not.toContain(covered);
});

it('lets the period be drafted again after its invoice is voided', async () => {
  await logTime(3, '2026-03-10');
  const planId = await createPlan(1);
  const first = await draft(planId);
  expect(first.status).toBe(201);
  const voided = await owner.api.post(`${INV()}/${first.body.invoice.id}/void`);
  expect(voided.status).toBe(200);
  await drainEvents();

  const p = await period(planId);
  const second = await draft(planId);

  expect({ status: p.status, generated: p.generatedInvoiceId, secondStatus: second.status })
    .toEqual({ status: 'ready_to_bill', generated: null, secondStatus: 201 });
});

it('keeps work logged after the plan existed out of the composer once the entry event settles', async () => {
  await createPlan(10);
  const entry = await logTime(2, '2026-03-10');
  await drainEvents();

  const res = await owner.api.get(`${INV()}/unbilled-summary`);

  expect(res.body.unbilledTimeEntries.map((e: any) => e.id)).not.toContain(entry);
});

it('offers entries wholly in overage and withholds the covered one', async () => {
  const included = await logTime(1, '2026-03-09');
  const over = await logTime(2, '2026-03-10');
  const planId = await createPlan(1);
  const p = await period(planId);
  expect({ covered: p.coveredTimeEntryIds, overage: p.overageTimeEntryIds }).toEqual({ covered: [included], overage: [over] });

  const res = await owner.api.get(`${INV()}/unbilled-summary`);

  expect(res.body.unbilledTimeEntries.map((e: any) => e.id)).toEqual([over]);
});
