/**
 * Overdue and due-soon counts at the edges of the viewer's calendar day, with
 * the clock frozen: one second either side of local midnight, across daylight
 * saving changes, and for viewers far ahead of and behind UTC.
 *
 * A ladder of unpaid invoices is due at fixed offsets from the viewer's own
 * today (computed here from the frozen instant, not by the app). Every
 * surface that reads the app clock must put the same invoices in the same
 * buckets. The dashboard reads the database clock, which a frozen app clock
 * cannot move, so it is not part of this file.
 *
 * RED IF: a surface rolls an invoice into overdue or out of due-soon at the
 * server's midnight (UTC) rather than the viewer's, or the day-count math
 * slips an hour across a daylight saving change.
 */
import {
  createFirm, createPersonClient, createPortalUser, ownerOf, as, tokenFor, drainEvents,
} from '../../support/setupInProcess';
import { freezeClockAt, unfreezeClock } from '../../support/clock';
import { dayIn } from './totalsWorld';

afterEach(() => unfreezeClock());

const OFFSETS = [-1, 0, 1, 7, 8, 30, 31];

interface Case { label: string; tz: string; at: string }
const CASES: Case[] = [
  { label: 'New York, last minute of the day', tz: 'America/New_York', at: '2026-12-10T23:59:30-05:00' },
  { label: 'New York, first minute of the next day', tz: 'America/New_York', at: '2026-12-11T00:00:30-05:00' },
  { label: 'New York, first hour of the fall-back day', tz: 'America/New_York', at: '2026-11-01T00:30:00-04:00' },
  { label: 'New York, last half hour of the 25-hour fall-back day', tz: 'America/New_York', at: '2026-11-01T23:30:00-05:00' },
  { label: 'New York, just before the spring-forward gap', tz: 'America/New_York', at: '2027-03-14T01:59:00-05:00' },
  { label: 'New York, just after the spring-forward gap', tz: 'America/New_York', at: '2027-03-14T03:01:00-04:00' },
  { label: 'Auckland, last minute of the day (UTC is still yesterday)', tz: 'Pacific/Auckland', at: '2026-12-10T10:59:30Z' },
  { label: 'Auckland, first minute of the next day', tz: 'Pacific/Auckland', at: '2026-12-10T11:00:30Z' },
  { label: 'Honolulu, last minute of the day (UTC is already tomorrow)', tz: 'Pacific/Honolulu', at: '2026-12-11T09:59:30Z' },
  { label: 'Honolulu, first minute of the next day', tz: 'Pacific/Honolulu', at: '2026-12-11T10:00:30Z' },
];

async function ladder(c: Case) {
  const today = dayIn(c.tz, 0, new Date(c.at));
  const day = (offset: number) => dayIn(c.tz, offset, new Date(c.at));
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const login = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Ladder', email: 'ladder@example.test', userId: login.uid });
  const api = as(tokenFor({ uid: owner.uid }), c.tz);
  const portal = as(tokenFor({ uid: login.uid }), c.tz);
  const B = `/api/lawfirms/${firm.id}/billing`;
  const byOffset = new Map<number, string>();
  for (const offset of OFFSETS) {
    const amount = 100 + offset + 50; // distinct cents-free amounts, all positive
    const res = await api.post(`${B}/invoices/client/${client.id}`).send({
      invoiceName: `due${offset}`, invoiceDate: day(-40), dueDate: day(offset),
      totalAmount: amount, flatFeesAmount: amount, flatFees: [{ description: 'x', amount }],
    });
    expect(res.status).toBe(201);
    byOffset.set(offset, res.body.invoice.id);
  }
  await drainEvents();
  return { today, day, firm, api, portal, client, B, byOffset };
}

describe.each(CASES)('$label', (c) => {
  it('puts every ladder invoice in the viewer-day bucket on the workbench, list, billing summary and portal', async () => {
    const L = await ladder(c);
    freezeClockAt(c.at);
    const ids = (offsets: number[]) => offsets.map((o) => L.byOffset.get(o)!).sort();

    const wb = (await L.api.get(`${L.B}/workbench`)).body;
    expect(wb.summary.overdueCount).toBe(1);
    expect(wb.collections.overdueCount).toBe(1);
    // Due today, tomorrow and in seven days are due soon; eight days out is not.
    expect(wb.collections.dueSoonCount).toBe(3);

    const overdue = (await L.api.get(`${L.B}/invoices/firm?status=overdue`)).body;
    expect(overdue.invoices.map((i: any) => i.id).sort()).toEqual(ids([-1]));

    const dueSoon = (await L.api.get(`${L.B}/invoices/firm?status=due_soon`)).body;
    expect(dueSoon.invoices.map((i: any) => i.id).sort()).toEqual(ids([0, 1, 7, 8, 30]));

    const tiles = (await L.api.get(`${L.B}/invoices/firm?awaitingOnly=true`)).body.dueGroupTotals;
    expect([tiles.overdue.count, tiles.this_week.count, tiles.this_month.count, tiles.later.count, tiles.no_date.count])
      .toEqual([1, 3, 2, 1, 0]);
    const amount = (offsets: number[]) => offsets.reduce((s, o) => s + 150 + o, 0);
    expect(tiles.overdue.amount).toBe(amount([-1]));
    expect(tiles.this_week.amount).toBe(amount([0, 1, 7]));
    expect(tiles.this_month.amount).toBe(amount([8, 30]));
    expect(tiles.later.amount).toBe(amount([31]));

    const chips = (await L.api.get(`${L.B}/invoices/firm`)).body.statusCounts;
    expect([chips.all, chips.overdue, chips.outstanding]).toEqual([7, 1, 6]);

    const analytics = (await L.api.get(`${L.B}/analytics/billing-summary`)).body;
    expect(analytics.overdueCount).toBe(1);
    expect(analytics.overdueAmount).toBe(amount([-1]));

    const portal = (await L.portal.get(`/api/client-portal/lawfirm/${L.firm.id}/billing?clientRecordId=${L.client.id}`)).body;
    expect([portal.statusCounts.overdue, portal.statusCounts.outstanding]).toEqual([1, 6]);
  });
});
