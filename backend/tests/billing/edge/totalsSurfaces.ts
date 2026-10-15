/**
 * Readers for every billing surface that states a count or a total, plus the
 * expected figures computed from the seeded ledger alone.
 */
import { type World, type Entry, apiRoot, invBase, remainingOf, sum } from './totalsWorld';

const toCents = (dollars: number) => Math.round(dollars * 100);

export const owing = (w: World) => w.ledger.filter((e) => remainingOf(e) > 0);
export const live = (w: World) => w.ledger.filter((e) => !e.voided);
export const isLate = (w: World, e: Entry) => remainingOf(e) > 0 && e.dueDay !== null && e.dueDay < w.today;

/** Figures every surface must state, from the ledger. */
export function expectedFigures(w: World) {
  const lv = live(w);
  const ow = owing(w);
  const late = ow.filter((e) => isLate(w, e));
  return {
    totalInvoices: w.ledger.length,
    billedCents: sum(lv, (e) => e.totalCents),
    collectedCents: sum(lv, (e) => e.paidCents),
    outstandingCents: sum(lv, remainingOf),
    awaitingCount: ow.length,
    overdueCount: late.length,
    overdueCents: sum(late, remainingOf),
  };
}

async function getJson(w: World, path: string) {
  const res = await w.owner.api.get(path);
  expect(res.status).toBe(200);
  return res.body;
}

export async function readWorkbench(w: World) {
  const b = await getJson(w, `${apiRoot(w)}/billing/workbench`);
  return {
    totalInvoices: b.summary.totalInvoices as number,
    collectedCents: toCents(b.summary.totalCollected),
    awaitingCount: b.summary.awaitingCount as number,
    awaitingCents: toCents(b.summary.awaitingAmount),
    overdueCount: b.summary.overdueCount as number,
    overdueCents: toCents(b.summary.overdueAmount),
    collectionsOverdueCount: b.collections.overdueCount as number,
    dueSoonCount: b.collections.dueSoonCount as number,
    partiallyPaidCount: b.collections.partiallyPaidCount as number,
    attentionOverdueRows: (b.attention.rows as any[]).filter((r) => r.kind === 'overdue').length,
  };
}

export async function readAnalytics(w: World) {
  const b = await getJson(w, `${apiRoot(w)}/billing/analytics/billing-summary`);
  return {
    totalInvoices: b.totalInvoices as number,
    billedCents: toCents(b.totalBilled),
    collectedCents: toCents(b.totalCollected),
    outstandingCents: toCents(b.totalOutstanding),
    revenueThisMonthCents: toCents(b.totalRevenueThisMonth),
    overdueCount: b.overdueCount as number,
    overdueCents: toCents(b.overdueAmount),
    awaitingCount: b.awaitingCount as number,
    awaitingCents: toCents(b.awaitingAmount),
  };
}

export async function readDashboard(w: World) {
  const b = await getJson(w, `${apiRoot(w)}/dashboard-summary`);
  return {
    outstandingCents: b.stats.outstandingArCents as number,
    overdueCount: b.stats.overdueInvoiceCount as number,
    overdueCents: b.stats.overdueInvoiceCents as number,
    collectedMonthCents: b.stats.collectedThisMonthCents as number,
  };
}

export async function readList(w: World, query = '') {
  return getJson(w, `${invBase(w)}/firm${query}`);
}

/** Every invoice row the list returns across pages of `limit`, in order. */
export async function readAllPages(w: World, query: string, limit: number) {
  const rows: any[] = [];
  const totals: number[] = [];
  for (let page = 1; page < 100; page += 1) {
    const sep = query ? '&' : '?';
    const b = await readList(w, `${query}${sep}limit=${limit}&page=${page}`);
    totals.push(b.totalItems);
    rows.push(...b.invoices);
    if (b.invoices.length < limit) break;
  }
  return { rows, totals };
}

export async function readReports(w: World) {
  const byClient = await getJson(w, `${apiRoot(w)}/billing/reports/by-client`);
  const byMatter = await getJson(w, `${apiRoot(w)}/billing/reports/by-matter`);
  return { byClient, byMatter };
}

export async function readPortal(w: World, clientKey = 'main') {
  const res = await w.portal.api.get(
    `/api/client-portal/lawfirm/${w.firm.id}/billing?clientRecordId=${w.clients[clientKey]}`,
  );
  expect(res.status).toBe(200);
  return res.body;
}

export const cents = toCents;

/** The ledger rows billed to one client, voided included. */
export const billedTo = (w: World, clientKey: string) =>
  w.ledger.filter((e) => e.clientId === w.clients[clientKey]);

/**
 * Assert that every count and total any surface states about the firm equals
 * the ledger. Called after each mutation so a surface that stops following one
 * is named by the first figure that moves.
 */
export async function expectAllSurfacesAgree(w: World) {
  const want = expectedFigures(w);
  const wb = await readWorkbench(w);
  const an = await readAnalytics(w);
  const dash = await readDashboard(w);

  expect({
    wb: [wb.totalInvoices, wb.collectedCents, wb.awaitingCount, wb.awaitingCents, wb.overdueCount, wb.overdueCents],
    an: [an.totalInvoices, an.billedCents, an.collectedCents, an.outstandingCents, an.awaitingCount, an.overdueCount, an.overdueCents],
    dash: [dash.outstandingCents, dash.overdueCount, dash.overdueCents, dash.collectedMonthCents],
  }).toEqual({
    wb: [want.totalInvoices, want.collectedCents, want.awaitingCount, want.outstandingCents, want.overdueCount, want.overdueCents],
    an: [want.totalInvoices, want.billedCents, want.collectedCents, want.outstandingCents, want.awaitingCount, want.overdueCount, want.overdueCents],
    dash: [want.outstandingCents, want.overdueCount, want.overdueCents, want.collectedCents],
  });

  const all = await readList(w);
  const unpaid = await readList(w, '?status=unpaid');
  const tiles = (await readList(w, '?awaitingOnly=true')).dueGroupTotals.all;
  expect([all.totalItems, all.statusCounts.all, unpaid.totalItems, tiles.count, cents(tiles.amount)])
    .toEqual([want.totalInvoices, want.totalInvoices, want.awaitingCount, want.awaitingCount, want.outstandingCents]);

  const { byClient, byMatter } = await readReports(w);
  const clientRows = byClient.rows as any[];
  expect([
    clientRows.reduce((s, r) => s + cents(r.totalBilled), 0) + cents(byClient.unattributedInvoices.totalAmount),
    clientRows.reduce((s, r) => s + cents(r.totalOutstanding), 0),
    clientRows.reduce((s, r) => s + r.invoiceCount, 0) + byClient.unattributedInvoices.count,
  ]).toEqual([want.billedCents, want.outstandingCents, w.ledger.length]);
  const matterRows = byMatter.rows as any[];
  expect(
    matterRows.reduce((s, r) => s + cents(r.totalBilled), 0) + cents(byMatter.unlinkedInvoices.totalAmount),
  ).toBe(want.billedCents);

  const mainRows = billedTo(w, 'main').filter((e) => !e.voided);
  const mainOutstanding = mainRows.reduce((s, e) => s + remainingOf(e), 0);
  const portal = await readPortal(w);
  expect([cents(portal.summary.totalBilled), cents(portal.summary.totalPaid), cents(portal.summary.totalOutstanding)])
    .toEqual([mainRows.reduce((s, e) => s + e.totalCents, 0), mainRows.reduce((s, e) => s + e.paidCents, 0), mainOutstanding]);
  const card = await w.portal.api.get('/api/client-portal/firm-summaries');
  expect(card.body.lawFirms.find((f: any) => f.id === w.firm.id).outstandingBalanceCents).toBe(mainOutstanding);
}
