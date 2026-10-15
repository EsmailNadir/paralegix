/**
 * Work waiting to be invoiced: the workbench ready-to-bill tile, the billing
 * summary's unbilled count, the dashboard work-in-progress, and the
 * unbilled-work list, against the entries the test seeded.
 *
 * The world already billed one hour (the three-way split). On top of it sit
 * two unbilled time entries (1.5 h at 200.00 and 0.25 h at 160.00) and one
 * unbilled flat fee (75.00). Voiding the split invoices releases their hour
 * back to unbilled.
 *
 * RED IF: a surface counts the billed hour or a voided invoice's lines as
 * work to bill, or two surfaces disagree on the
 * unbilled hours or amount.
 */
import { buildWorld, apiRoot, voidIt, entry, type World } from './totalsWorld';
import { cents } from './totalsSurfaces';

let w: World;

const addTime = async (hours: number, rate: number, extra: Record<string, unknown> = {}) => {
  const res = await w.owner.api.post(`${apiRoot(w)}/billing/time-entries`).send({
    matterId: w.matters.main, userId: w.owner.uid, hours, date: w.today, hourlyRate: rate, description: 'time entry', ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
};

beforeEach(async () => {
  w = await buildWorld();
  await addTime(1.5, 200);
  await addTime(0.25, 160);
  const fee = await w.owner.api.post(`${apiRoot(w)}/billing/flat-fees`).send({
    clientId: w.clients.main, description: 'Filing', amount: 75, date: w.today,
  });
  expect(fee.status).toBe(201);
});

const workbenchBody = async () => (await w.owner.api.get(`${apiRoot(w)}/billing/workbench`)).body;

it('the workbench counts two entries and one flat fee as ready to bill, at 415.00', async () => {
  const s = (await workbenchBody()).summary;

  expect(s.readyToBillCount).toBe(3);
  expect(cents(s.readyToBillAmount)).toBe(30_000 + 4_000 + 7_500);
  expect(s.unbilledHours).toBe(1.75);
  expect(s.uninvoicedTimeEntryCount).toBe(2);
});

it('the billing summary counts the same two unbilled entries and all hours logged this month', async () => {
  const raw = (await w.owner.api.get(`${apiRoot(w)}/billing/analytics/billing-summary`)).body;

  expect(raw.unbilledTimeEntryCount).toBe(2);
  // 1 billed hour + 1.5 + 0.25, all dated today.
  expect(raw.totalHoursThisMonth).toBe(2.75);
});

it('the dashboard work-in-progress is the same 415.00 and the same 1.75 hours', async () => {
  const stats = (await w.owner.api.get(`${apiRoot(w)}/dashboard-summary`)).body.stats;

  expect(stats.unbilledWipCents).toBe(41_500);
  expect(stats.unbilledHours).toBe(1.75);
});

it('the workbench and the billing summary agree on the unbilled entry count', async () => {
  const wb = (await workbenchBody()).summary;
  const an = (await w.owner.api.get(`${apiRoot(w)}/billing/analytics/billing-summary`)).body;

  expect(wb.uninvoicedTimeEntryCount).toBe(an.unbilledTimeEntryCount);
});

it('voiding an invoice releases its lines back to every unbilled figure', async () => {
  // The split matter's hour sits on three invoices; voiding all three frees it.
  for (const key of ['splitA', 'splitB', 'splitC']) await voidIt(w, entry(w, key));
  const s = (await workbenchBody()).summary;
  const stats = (await w.owner.api.get(`${apiRoot(w)}/dashboard-summary`)).body.stats;
  const an = (await w.owner.api.get(`${apiRoot(w)}/billing/analytics/billing-summary`)).body;

  expect(s.uninvoicedTimeEntryCount).toBe(3);
  expect(s.unbilledHours).toBe(2.75);
  expect(an.unbilledTimeEntryCount).toBe(3);
  expect(stats.unbilledHours).toBe(2.75);
  expect(stats.unbilledWipCents).toBe(41_500 + 10_000);
  expect(cents(s.readyToBillAmount)).toBe(41_500 + 10_000);
});
