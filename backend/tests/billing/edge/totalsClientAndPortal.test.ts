/**
 * What a client is told about their own billing, on every surface that tells
 * them: the staff-side client header, the client billing tab, the portal
 * billing page and the portal firm card.
 *
 * `main` is a client with twelve invoices (live, part-paid, paid, credited,
 * written off, zero-total, voided, plan, trust-paid, Stripe-paid, matter-billed)
 * and a portal login. The figures are computed from the seeded ledger.
 *
 * RED IF: any of these surfaces counts a voided invoice's money, drops a
 * paid-in-part invoice, or disagrees with another about the same client.
 */
import { testPool, createPortalUser, as, tokenFor } from '../../support/setupInProcess';
import { buildWorld, remainingOf, sum, apiRoot, type World } from './totalsWorld';
import { billedTo, readList, readPortal, cents } from './totalsSurfaces';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

const header = async (clientKey: string) =>
  (await w.owner.api.get(`${apiRoot(w)}/clients/${w.clients[clientKey]}/summary`)).body.billing;

describe('client header and billing tab', () => {
  it('state the same invoice count, billed and paid, equal to the ledger', async () => {
    const rows = billedTo(w, 'main');
    const owned = rows.filter((e) => !e.voided);
    const h = await header('main');
    const tab = await readList(w, `?clientScope=${w.clients.main}`);

    expect(h.invoiceCount).toBe(rows.length);
    expect(tab.statusCounts.all).toBe(rows.length);
    expect(tab.totalItems).toBe(rows.length);
    expect(h.totalBilledCents).toBe(sum(owned, (e) => e.totalCents));
    expect(h.totalPaidCents).toBe(sum(owned, (e) => e.paidCents));
    expect(cents(tab.summary.totalBilled)).toBe(h.totalBilledCents);
    expect(cents(tab.summary.totalPaid)).toBe(h.totalPaidCents);
    expect(tab.summary.ownedCount).toBe(owned.length);
  });

  it('count a co-client share on a shared matter in the invoice count but not in the money', async () => {
    const h = await header('split1');
    const tab = await readList(w, `?clientScope=${w.clients.split1}`);

    // Three shares sit on the matter, so the page lists three; only the one billed to split1 is its money.
    expect(h.invoiceCount).toBe(3);
    expect(tab.totalItems).toBe(3);
    expect(h.totalBilledCents).toBe(3334);
    expect(h.totalPaidCents).toBe(0);
    expect(tab.summary.ownedCount).toBe(1);
  });

  it('a three-way split that does not divide evenly keeps every share in cents on header and tab', async () => {
    const expected: Record<string, number> = { split1: 3334, split2: 3333, split3: 3333 };
    for (const [key, centsWant] of Object.entries(expected)) {
      const h = await header(key);
      const tab = await readList(w, `?clientScope=${w.clients[key]}`);
      expect(h.totalBilledCents).toBe(centsWant);
      expect(h.outstandingCents).toBe(centsWant);
      expect(cents(tab.summary.totalBilled)).toBe(centsWant);
      expect(cents(tab.summary.totalOutstanding)).toBe(centsWant);
    }
    expect(sum(billedTo(w, 'split1').concat(billedTo(w, 'split2'), billedTo(w, 'split3')), (e) => e.totalCents)).toBe(10_000);
  });

  it('the header count for a person with no organization link equals the rows the tab lists', async () => {
    const h = await header('idle');
    const tab = await readList(w, `?clientScope=${w.clients.idle}`);

    expect(h.invoiceCount).toBe(billedTo(w, 'idle').length);
    expect(tab.totalItems).toBe(h.invoiceCount);
    expect(cents(tab.summary.totalOutstanding)).toBe(h.outstandingCents);
  });
});

describe('portal billing page', () => {
  it('states billed, paid and outstanding for the client in whole cents, net of write-offs', async () => {
    const owned = billedTo(w, 'main').filter((e) => !e.voided);
    const body = await readPortal(w);

    expect(cents(body.summary.totalBilled)).toBe(sum(owned, (e) => e.totalCents));
    expect(cents(body.summary.totalPaid)).toBe(sum(owned, (e) => e.paidCents));
    expect(cents(body.summary.totalOutstanding)).toBe(sum(owned, remainingOf));
  });

  it('lists every invoice once and counts each in exactly one chip, the voided one included', async () => {
    const body = await readPortal(w);
    const rows = billedTo(w, 'main');

    expect(body.totalItems).toBe(rows.length);
    expect(body.invoices.map((i: any) => i.id).sort()).toEqual(rows.map((e) => e.id).sort());
    const chipTotal = Object.values(body.statusCounts as Record<string, number>).reduce((s, n) => s + n, 0);
    expect(chipTotal).toBe(rows.length);
    expect(body.statusCounts.voided).toBe(1);
    expect(body.statusCounts.partially_paid).toBe(billedTo(w, 'main').filter((e) => !e.voided && e.paidCents > 0 && remainingOf(e) > 0).length);
  });

  it.each([1, 4, 5])('pages of %i return every invoice once with the same total on each page', async (limit) => {
    const rows: any[] = [];
    const totals: number[] = [];
    for (let page = 1; page < 50; page += 1) {
      const res = await w.portal.api.get(
        `/api/client-portal/lawfirm/${w.firm.id}/billing?clientRecordId=${w.clients.main}&limit=${limit}&page=${page}`,
      );
      expect(res.status).toBe(200);
      totals.push(res.body.totalItems);
      rows.push(...res.body.invoices);
      if (res.body.invoices.length < limit) break;
    }
    const whole = await readPortal(w);

    expect(new Set(totals)).toEqual(new Set([billedTo(w, 'main').length]));
    expect(rows.map((r) => r.id)).toEqual(whole.invoices.map((i: any) => i.id));
  });

  it('a status filter returns as many rows as its chip counts', async () => {
    const whole = await readPortal(w);
    for (const status of ['paid', 'partially_paid', 'voided', 'outstanding']) {
      const res = await w.portal.api.get(
        `/api/client-portal/lawfirm/${w.firm.id}/billing?clientRecordId=${w.clients.main}&status=${status}`,
      );
      expect(res.body.totalItems).toBe(whole.statusCounts[status]);
    }
  });

  it('the portal firm card balance equals the client outstanding on the billing page', async () => {
    const card = await w.portal.api.get('/api/client-portal/firm-summaries');
    const body = await readPortal(w);

    expect(card.body.lawFirms.find((f: any) => f.id === w.firm.id).outstandingBalanceCents)
      .toBe(cents(body.summary.totalOutstanding));
  });
});

describe('the staff-side list for a client that is on a matter', () => {
  it('counts the matter invoice billed to the client under that client, and never under a co-client', async () => {
    const mainTab = await readList(w, `?clientScope=${w.clients.main}`);
    const split1Tab = await readList(w, `?clientScope=${w.clients.split1}`);

    expect(mainTab.invoices.map((i: any) => i.invoiceName)).toContain('matterBilled');
    expect(split1Tab.invoices.map((i: any) => i.invoiceName).sort()).toEqual(['splitA', 'splitB', 'splitC']);
    // The two co-clients' shares are on this client's page for context, but only the
    // share billed to split1 is owned, so only 33.34 of the 100.00 is this client's money.
    expect(split1Tab.summary).toEqual({ ownedCount: 1, totalBilled: 33.34, totalPaid: 0, totalOutstanding: 33.34 });
  });
});

describe('a person on an organization roster', () => {
  it('sees each relationship separately, and the firm card adds both balances', async () => {
    const personLogin = await createPortalUser();
    await testPool.query('update clients set user_id = $1 where id = $2', [personLogin.uid, w.clients.person]);
    const api = as(tokenFor({ uid: personLogin.uid }), w.tz);
    const P = `/api/client-portal/lawfirm/${w.firm.id}`;
    const own = w.ledger.filter((e) => e.clientId === w.clients.person && !e.voided);
    const org = w.ledger.filter((e) => e.clientId === w.clients.org && !e.voided);

    const personSide = (await api.get(`${P}/billing?clientRecordId=${w.clients.person}`)).body;
    const orgSide = (await api.get(`${P}/billing?clientRecordId=${w.clients.org}`)).body;
    const card = (await api.get('/api/client-portal/firm-summaries')).body.lawFirms.find((f: any) => f.id === w.firm.id);

    expect(cents(personSide.summary.totalOutstanding)).toBe(sum(own, remainingOf));
    expect(cents(personSide.summary.totalBilled)).toBe(sum(own, (e) => e.totalCents));
    expect(cents(orgSide.summary.totalOutstanding)).toBe(sum(org, remainingOf));
    expect(card.outstandingBalanceCents).toBe(sum(own, remainingOf) + sum(org, remainingOf));
    expect(personSide.totalItems).toBe(w.ledger.filter((e) => e.clientId === w.clients.person).length);
    expect(orgSide.totalItems).toBe(1);
  });
});
