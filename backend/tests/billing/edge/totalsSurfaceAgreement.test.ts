/**
 * Billing counts and totals agree across surfaces: the client header, the billing
 * tab, the invoice list chips and filters, the workbench, the portal, the daily
 * digest and the analytics summary.
 */
import { freezeClockAt, unfreezeClock } from '../../support/clock';
import { createFirm, createPersonClient, ownerOf, as, tokenFor } from '../../support/setupInProcess';
import { findDigestInvoices } from '../../../src/modules/notifications/digest/digest.repository';
import { mini, day } from './totalsMini';

afterEach(() => unfreezeClock());

it('client summary header outstanding is net of write-offs, like the billing tab and the report', async () => {
  const m = await mini();
  const id = await m.issue('written off in part', 1000, day(10));
  const cn = await m.api.post(`${m.B}/invoices/client/${m.client.id}/${id}/credit-note`)
    .send({ amount: 300, type: 'write_off', description: 'goodwill' });
  expect(cn.status).toBe(200);

  const header = (await m.api.get(`/api/lawfirms/${m.firm.id}/clients/${m.client.id}/summary`)).body.billing;
  const tab = (await m.api.get(`${m.B}/invoices/firm?clientScope=${m.client.id}`)).body.summary;

  expect(Math.round(tab.totalOutstanding * 100)).toBe(70_000);
  expect(header.outstandingCents).toBe(70_000);
});

it('an invoice that owes nothing is not counted in the overdue chip, which must equal the overdue filter and the workbench', async () => {
  const m = await mini();
  await m.issue('zero total, due yesterday', 0, day(-1));

  const list = (await m.api.get(`${m.B}/invoices/firm`)).body;
  const filtered = (await m.api.get(`${m.B}/invoices/firm?status=overdue`)).body;
  const wb = (await m.api.get(`${m.B}/workbench`)).body;
  const portal = (await m.portal.get(`/api/client-portal/lawfirm/${m.firm.id}/billing?clientRecordId=${m.client.id}`)).body;

  expect(filtered.totalItems).toBe(0);
  expect(wb.summary.overdueCount).toBe(0);
  expect(list.statusCounts.overdue ?? 0).toBe(0);
  expect(portal.statusCounts.overdue ?? 0).toBe(0);
});

it('the unpaid filter equals the outstanding, overdue and part-paid chips together', async () => {
  const m = await mini();
  await m.issue('zero total, due in two days', 0, day(2));

  const { statusCounts } = (await m.api.get(`${m.B}/invoices/firm`)).body;
  const unpaid = (await m.api.get(`${m.B}/invoices/firm?status=unpaid`)).body;

  const chips = (statusCounts.outstanding ?? 0) + (statusCounts.overdue ?? 0) + (statusCounts.partially_paid ?? 0);
  expect(unpaid.totalItems).toBe(0);
  expect(chips).toBe(unpaid.totalItems);
});

it('the workbench due-soon count leaves out an invoice that owes nothing', async () => {
  const m = await mini();
  await m.issue('zero total, due tomorrow', 0, day(1));
  await m.issue('owed, due tomorrow', 50, day(1));

  const wb = (await m.api.get(`${m.B}/workbench`)).body;

  expect(wb.summary.awaitingCount).toBe(1);
  expect(wb.collections.dueSoonCount).toBe(1);
});

it('the portal summary states whole cents, not float sums', async () => {
  const m = await mini();
  await m.issue('ten cents', 0.1, day(5));
  await m.issue('twenty cents', 0.2, day(5));

  const { summary } = (await m.portal.get(`/api/client-portal/lawfirm/${m.firm.id}/billing?clientRecordId=${m.client.id}`)).body;

  expect(summary).toEqual({ totalBilled: 0.3, totalPaid: 0, totalOutstanding: 0.3 });
});

it('an invoice due today in the viewer zone is not "overdue" on its row, matching the chips and the overdue filter', async () => {
  // 22:00 in New York on 15 March is already 16 March in UTC.
  freezeClockAt('2026-03-15T22:00:00-04:00');
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Evening', email: 'evening@example.test' });
  const api = as(tokenFor({ uid: owner.uid }), 'America/New_York');
  const B = `/api/lawfirms/${firm.id}/billing`;
  expect((await api.post(`${B}/invoices/client/${client.id}`).send({
    invoiceName: 'due today in New York', invoiceDate: '2026-03-10', dueDate: '2026-03-15',
    totalAmount: 100, flatFeesAmount: 100, flatFees: [{ description: 'x', amount: 100 }],
  })).status).toBe(201);

  const list = (await api.get(`${B}/invoices/firm`)).body;
  const overdueRows = (await api.get(`${B}/invoices/firm?status=overdue`)).body.totalItems;

  expect(overdueRows).toBe(0);
  expect(list.statusCounts.overdue ?? 0).toBe(0);
  expect(list.invoices[0].status).toBe('outstanding');
});

it('the client header invoice count equals the rows the client billing tab lists, for a person on an organization roster', async () => {
  const m = await mini();
  const org = await m.createOrgClient((m.firm as any).id, { name: 'Org Holdings' });
  await m.linkPersonToOrg((m.firm as any).id, m.client.id, org.id, { canViewBilling: true });
  await m.issue('person invoice', 100, day(5));
  const res = await m.api.post(`${m.B}/invoices/client/${org.id}`).send({
    invoiceName: 'org invoice', invoiceDate: day(-2), dueDate: day(5),
    totalAmount: 250, flatFeesAmount: 250, flatFees: [{ description: 'x', amount: 250 }],
  });
  expect(res.status).toBe(201);

  const header = (await m.api.get(`/api/lawfirms/${m.firm.id}/clients/${m.client.id}/summary`)).body.billing;
  const tab = (await m.api.get(`${m.B}/invoices/firm?clientScope=${m.client.id}`)).body;

  expect(tab.totalItems).toBe(2);
  expect(header.invoiceCount).toBe(tab.totalItems);
});

it('the daily digest lists an invoice whose payment-plan instalment is overdue, as every billing surface does', async () => {
  const m = await mini();
  const id = await m.issue('plan with a late first instalment', 600, day(-30));
  const plan = await m.api.post(`${m.B}/invoices/client/${m.client.id}/${id}/payment-plan`)
    .send({ installmentAmount: 200, frequencyDays: 30, planStartDate: day(-10) });
  expect(plan.status).toBe(200);

  const wb = (await m.api.get(`${m.B}/workbench`)).body;
  const dash = (await m.api.get(`/api/lawfirms/${m.firm.id}/dashboard-summary`)).body.stats;
  const digest = await findDigestInvoices(m.firm.id, day(0), day(7));

  expect(wb.summary.overdueCount).toBe(1);
  expect(dash.overdueInvoiceCount).toBe(1);
  expect(digest.map((d: any) => d.id)).toContain(id);
});

it('a non-billable entry is not counted as unbilled work on a surface that also reports zero unbilled hours', async () => {
  const m = await mini();
  const matterRes = await m.api.post(`/api/lawfirms/${m.firm.id}/matters`).send({
    name: 'Pro bono', clients: [{ clientId: m.client.id, name: 'Mini' }],
  });
  expect(matterRes.status).toBe(201);
  const te = await m.api.post(`${m.B}/time-entries`).send({
    matterId: matterRes.body.matterId, userId: m.owner.uid, hours: 2, date: day(0), hourlyRate: 200, billable: false, description: 'pro bono',
  });
  expect(te.status).toBe(201);

  const wb = (await m.api.get(`${m.B}/workbench`)).body.summary;
  const an = (await m.api.get(`${m.B}/analytics/billing-summary`)).body;
  const dash = (await m.api.get(`/api/lawfirms/${m.firm.id}/dashboard-summary`)).body.stats;

  expect(wb.readyToBillCount).toBe(0);
  expect(wb.unbilledHours).toBe(0);
  expect(dash.unbilledHours).toBe(0);
  expect(wb.uninvoicedTimeEntryCount).toBe(0);
  expect(an.unbilledTimeEntryCount).toBe(0);
});
