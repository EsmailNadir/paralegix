/**
 * The client detail header figures, computed in SQL.
 *
 * The client page used to page through EVERY matter the client is on (500 at a
 * time) and EVERY invoice related to them (200 at a time) only to derive five
 * numbers: the matter count, the invoice count, and total billed / paid /
 * outstanding over the invoices billed to this client. This endpoint answers
 * those numbers directly.
 *
 * The expectation for each number is NOT restated here from the SQL. The
 * `oldDerivation` helper below re-runs what the page did: it calls the same
 * list endpoints and applies the page's own filters (`deriveClientMatters` and
 * the "owned" branch of `classifyInvoiceForClient` in
 * `frontend/src/components/clientComp/`). A summary that disagrees with the
 * figures the page used to show goes red, and so does one that agrees with a
 * derivation that silently returned nothing, because each case also pins the
 * hand-computed totals for its seeded world.
 *
 * The seeded world is chosen so that every rule has a row that would be counted
 * wrongly without it: an invoice billed to another client on a shared matter, a
 * matter-level invoice billed to nobody, an invoice with a zero total and
 * recorded flat fees (worth nothing: the stored total is canonical), a linked company's matter (counted) and that company's invoice
 * (not counted), a matter the member is walled off from, and a second client and
 * a second firm whose rows must never appear.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  ownerOf,
  memberWith,
  stranger,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { DEFAULT_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

const summary = (actor: Actor, clientId: string, lawFirmId: string = firm.id) =>
  actor.api.get(`/api/lawfirms/${lawFirmId}/clients/${clientId}/summary`);

async function seedMatter(
  lawFirmId: string, name: string, clientIds: string[], memberUids: string[] = [], status = 'active',
) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status) values ($1, $2, $3, $4, $5)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`, status],
  );
  for (const clientId of clientIds) {
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [id, clientId, lawFirmId],
    );
  }
  for (const uid of memberUids) {
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at) values ($1, $2, $3, 'member', now())`,
      [id, uid, lawFirmId],
    );
  }
  return id;
}

async function seedInvoice(lawFirmId: string, options: {
  matterId?: string;
  clientContextId?: string;
  clientId?: string | null;
  matterClientId?: string | null;
  totalCents?: number;
  flatFeesCents?: number;
  paidCents?: number;
  status?: string;
}) {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_context_id, client_id, matter_client_id,
                           context_type, invoice_number, status, total_cents, flat_fees_amount_cents,
                           amount_paid_cents, invoice_date, due_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '2026-04-01', '2026-05-01')`,
    [
      id, lawFirmId, options.matterId ?? null, options.clientContextId ?? null,
      options.clientId ?? null, options.matterClientId ?? null,
      options.matterId ? 'matter' : 'client', `INV-${id.slice(0, 8)}`,
      options.status ?? 'outstanding', options.totalCents ?? 0, options.flatFeesCents ?? 0, options.paidCents ?? 0,
    ],
  );
  return id;
}

/**
 * What the client page derived, reproduced from the lists it read.
 * Money is summed in cents here; the page summed dollars, which agree to the
 * cent for these whole-cent fixtures.
 */
async function oldDerivation(actor: Actor, clientId: string) {
  const base = `/api/lawfirms/${firm.id}`;
  const clientRes = await actor.api.get(`${base}/clients/${clientId}`);
  expect(clientRes.status).toBe(200);
  const client = clientRes.body;

  const matters: any[] = [];
  for (let page = 1; ; page += 1) {
    const res = await actor.api.get(`${base}/matters?clientId=${clientId}&page=${page}&limit=500`);
    expect(res.status).toBe(200);
    matters.push(...res.body.matters);
    if (matters.length >= res.body.totalItems || res.body.matters.length === 0) break;
  }

  const relationships = client.clientType === 'company'
    ? []
    : (await actor.api.get(`${base}/clients/${clientId}/company-relationships`)).body.relationships;
  const companyIds = new Set((relationships || []).map((r: any) => r.companyClientId));
  const matterIdSet = new Set((client.matterIds || []).filter(Boolean));
  const clientMatters = matters.filter((m) => {
    if (matterIdSet.has(m.id)) return true;
    if (Array.isArray(m.clients) && m.clients.some((mc: any) => companyIds.has(mc.id))) return true;
    if (matterIdSet.size === 0 && Array.isArray(m.clientUserIds) && m.clientUserIds.includes(clientId)) return true;
    return false;
  });

  const invoices: any[] = [];
  for (let page = 1; ; page += 1) {
    const res = await actor.api.get(
      `${base}/billing/invoices/firm?relatedClientId=${clientId}&includeDetails=true&page=${page}&limit=200`,
    );
    expect(res.status).toBe(200);
    invoices.push(...res.body.invoices);
    if (invoices.length >= res.body.totalItems || res.body.invoices.length === 0) break;
  }
  const cents = (dollars: number) => Math.round((dollars || 0) * 100);
  const owned = invoices.filter((invoice) => {
    if (invoice.contextType === 'client') return !invoice.entityId || invoice.entityId === client.id;
    return Boolean(invoice.clientId) && invoice.clientId === client.id;
  });
  // A voided invoice is a row in the list but not money: it is neither billed nor owed.
  const money = owned.filter((invoice) => invoice.status !== 'voided');
  const totalBilledCents = money.reduce((sum, invoice) => sum + cents(invoice.totalAmount), 0);
  const totalPaidCents = money.reduce((sum, invoice) => sum + cents(invoice.amountPaid), 0);

  return {
    matters: { count: clientMatters.length },
    billing: {
      invoiceCount: invoices.length,
      totalBilledCents,
      totalPaidCents,
      outstandingCents: totalBilledCents - totalPaidCents,
    },
  };
}

/**
 * The world described in the file header. The member holds `billing.viewInvoices`
 * unless told otherwise, since the invoice read is not part of the baseline.
 */
async function seedWorld(memberPermissions: string[] = ['billing.viewInvoices']) {
  const member = await memberWith(firm.id, memberPermissions);
  const pat = await createPersonClient(firm.id, { name: 'Pat Person' });
  const quinn = await createPersonClient(firm.id, { name: 'Quinn Other' });
  const acme = await createOrgClient(firm.id, { name: 'Acme Corp' });
  await linkPersonToOrg(firm.id, pat.id, acme.id, { canViewBilling: false });

  const own = await seedMatter(firm.id, 'Pat Own Matter', [pat.id], [member.uid]);
  // Every status counts: the page's matter list applies no status filter.
  const shared = await seedMatter(firm.id, 'Shared Matter', [pat.id, quinn.id], [], 'closed');
  const company = await seedMatter(firm.id, 'Acme Matter', [acme.id], [member.uid], 'on_hold');
  const walled = await seedMatter(firm.id, 'Walled Matter', [pat.id], [], 'archived');
  await seedMatter(firm.id, 'Quinn Only Matter', [quinn.id], [member.uid], 'pending');

  // Owned: billed straight to Pat.
  await seedInvoice(firm.id, { matterId: own, clientId: pat.id, totalCents: 100_000, paidCents: 25_000, status: 'partially_paid' });
  // Owned: billed to Pat through the matter-client column only.
  await seedInvoice(firm.id, { matterId: own, matterClientId: pat.id, totalCents: 50_000 });
  // Related but not owned: another client on a shared matter, and a bill to nobody.
  await seedInvoice(firm.id, { matterId: shared, clientId: quinn.id, totalCents: 70_000, paidCents: 70_000, status: 'paid' });
  await seedInvoice(firm.id, { matterId: shared, totalCents: 30_000 });
  // Not related: the linked company's own invoice is not widened into Pat's list.
  await seedInvoice(firm.id, { matterId: company, clientId: acme.id, totalCents: 90_000 });
  // Owned direct invoices: one with a zero total beside recorded flat fees, one voided.
  await seedInvoice(firm.id, { clientContextId: pat.id, clientId: pat.id, flatFeesCents: 20_000 });
  await seedInvoice(firm.id, { clientContextId: pat.id, clientId: pat.id, totalCents: 10_000, status: 'voided' });
  // Owned, but on a matter the member is walled off from.
  await seedInvoice(firm.id, { matterId: walled, clientId: pat.id, totalCents: 40_000 });
  // Another client's direct invoice.
  await seedInvoice(firm.id, { clientContextId: quinn.id, clientId: quinn.id, totalCents: 55_000 });

  // A second firm with the same shapes.
  const rivalClient = await createPersonClient(rival.id, { name: 'Rival Client' });
  const rivalMatter = await seedMatter(rival.id, 'Rival Matter', [rivalClient.id]);
  await seedInvoice(rival.id, { matterId: rivalMatter, clientId: rivalClient.id, totalCents: 999_900 });
  await seedInvoice(rival.id, { clientContextId: rivalClient.id, clientId: rivalClient.id, totalCents: 888_800 });

  return { member, pat, quinn, acme, rivalClient };
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  rival = await createFirm();
  rivalOwner = await ownerOf(rival.id);
});

describe('another firm', () => {
  it('refuses a caller from another firm', async () => {
    const { pat } = await seedWorld();

    const res = await summary(rivalOwner, pat.id);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('100000');
  });

  it('refuses a signed-in caller who belongs to no firm', async () => {
    const { pat } = await seedWorld();

    expect((await summary(stranger(), pat.id)).status).toBe(403);
  });

  it('answers not-found for another firm\'s client named under this firm', async () => {
    const { rivalClient } = await seedWorld();

    const res = await summary(owner, rivalClient.id);

    expect(res.status).toBe(404);
  });

  it('answers not-found for a malformed client id', async () => {
    expect((await summary(owner, 'not-a-uuid')).status).toBe(404);
  });
});

describe('the figures', () => {
  it('matches what the client page derived, for the owner', async () => {
    const { pat } = await seedWorld();

    const res = await summary(owner, pat.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientId: pat.id, ...(await oldDerivation(owner, pat.id)) });
    expect(res.body).toEqual({
      clientId: pat.id,
      // Own, Shared, Walled, plus Acme's matter through the company link.
      matters: { count: 4 },
      billing: {
        invoiceCount: 7,
        totalBilledCents: 190_000,
        totalPaidCents: 25_000,
        outstandingCents: 165_000,
      },
    });
  });

  it('matches what the client page derived, for a member behind the matter wall', async () => {
    const { pat, member } = await seedWorld();

    const res = await summary(member, pat.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientId: pat.id, ...(await oldDerivation(member, pat.id)) });
    expect(res.body).toEqual({
      clientId: pat.id,
      matters: { count: 2 },
      billing: {
        invoiceCount: 4,
        totalBilledCents: 150_000,
        totalPaidCents: 25_000,
        outstandingCents: 125_000,
      },
    });
  });

  it('matches what the client page derived, for a company client and for the other client', async () => {
    const { acme, quinn } = await seedWorld();

    for (const client of [acme, quinn]) {
      const res = await summary(owner, client.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ clientId: client.id, ...(await oldDerivation(owner, client.id)) });
    }
    expect((await summary(owner, acme.id)).body.billing.totalBilledCents).toBe(90_000);
    expect((await summary(owner, quinn.id)).body).toEqual({
      clientId: quinn.id,
      matters: { count: 2 },
      billing: { invoiceCount: 3, totalBilledCents: 125_000, totalPaidCents: 70_000, outstandingCents: 55_000 },
    });
  });

  it('answers zeros for a client with nothing on the books', async () => {
    const empty = await createPersonClient(firm.id);

    const res = await summary(owner, empty.id);

    expect(res.body).toEqual({
      clientId: empty.id,
      matters: { count: 0 },
      billing: { invoiceCount: 0, totalBilledCents: 0, totalPaidCents: 0, outstandingCents: 0 },
    });
  });
});

/**
 * The same world read through the client-detail Billing tab:
 * `GET /billing/invoices/firm?clientScope=<client>`. That list stamps each row
 * with `billingRelation` (clientInvoiceRelation.ts) and sums only the `owned`
 * rows into its `summary`, so the relation decides whose money the tab shows.
 * An invoice billed to a co-client counted as owned overstates what Pat owes; an
 * owned invoice classed as unassigned drops out of Pat's balance entirely.
 */
describe('the firm invoice list in one client\'s scope', () => {
  const scoped = (actor: Actor, clientId: string, extra = '') =>
    actor.api.get(`/api/lawfirms/${firm.id}/billing/invoices/firm?clientScope=${clientId}${extra}`);

  /** Each row reduced to what the relation decides, in a stable order. */
  const relations = (invoices: any[]) => invoices
    .map((inv) => ({
      matter: inv.matterName,
      totalAmount: inv.totalAmount,
      billingRelation: inv.billingRelation,
      billingRecipientClientId: inv.billingRecipientClientId,
    }))
    .sort((a, b) => String(a.matter).localeCompare(String(b.matter)) || a.totalAmount - b.totalAmount);

  it('classes each invoice by who pays it, and sums only the ones this client owns', async () => {
    const { pat, quinn } = await seedWorld();
    // An odd-cent owned invoice, so a summary that added dollars as floats
    // rather than whole cents shows up as a figure off by a cent.
    const own = (await testPool.query(
      `select id from matters where law_firm_id = $1 and name = 'Pat Own Matter'`, [firm.id],
    )).rows[0].id;
    await seedInvoice(firm.id, { matterId: own, clientId: pat.id, totalCents: 33_333, paidCents: 11_111, status: 'partially_paid' });

    const res = await scoped(owner, pat.id);

    expect(res.status).toBe(200);
    expect(relations(res.body.invoices)).toEqual([
      // Direct invoices are Pat's by construction: the context IS Pat.
      { matter: null, totalAmount: 0, billingRelation: 'owned', billingRecipientClientId: pat.id },
      { matter: null, totalAmount: 100, billingRelation: 'owned', billingRecipientClientId: pat.id },
      // Billed to Pat by client_id (twice) and by matter_client_id alone.
      { matter: 'Pat Own Matter', totalAmount: 333.33, billingRelation: 'owned', billingRecipientClientId: pat.id },
      { matter: 'Pat Own Matter', totalAmount: 500, billingRelation: 'owned', billingRecipientClientId: pat.id },
      { matter: 'Pat Own Matter', totalAmount: 1000, billingRelation: 'owned', billingRecipientClientId: pat.id },
      // On Pat's shared matter: Quinn's bill is context, never Pat's debt, and
      // a bill naming nobody stays unassigned rather than defaulting to Pat.
      { matter: 'Shared Matter', totalAmount: 300, billingRelation: 'shared_unassigned', billingRecipientClientId: null },
      { matter: 'Shared Matter', totalAmount: 700, billingRelation: 'other_client', billingRecipientClientId: quinn.id },
      { matter: 'Walled Matter', totalAmount: 400, billingRelation: 'owned', billingRecipientClientId: pat.id },
    ]);
    // Owned: 1,000.00 + 500.00 + 333.33 + 400.00 + 0.00 (a zero total, its
    // flat fees notwithstanding). The voided 100.00 is cancelled and counts
    // nowhere. Paid: 250.00 + 111.11. Quinn's fully paid 700.00 and the
    // unassigned 300.00 are excluded from both.
    expect(res.body.summary).toEqual({
      ownedCount: 5,
      totalBilled: 2233.33,
      totalPaid: 361.11,
      totalOutstanding: 1872.22,
    });
  });

  it('narrows to one relation when asked, without changing the owned summary', async () => {
    const { pat, quinn } = await seedWorld();

    const others = await scoped(owner, pat.id, '&billingRelation=other_client');

    expect(others.status).toBe(200);
    expect(others.body.invoices.map((inv: any) => [inv.billingRelation, inv.billingRecipientClientId, inv.totalAmount]))
      .toEqual([['other_client', quinn.id, 700]]);
    // The summary is computed over the scope, not the relation filter, so the
    // tab's balance does not drop to zero when the reader picks "other client".
    expect(others.body.summary).toMatchObject({ ownedCount: 4, totalBilled: 1900, totalPaid: 250 });
  });

  it('shows a linked organization\'s own invoice as another client\'s, outside this person\'s balance', async () => {
    // A link that grants billing widens the scope to the organization's direct
    // invoices. They are the organization's debt, not the person's, so the
    // direct branch must not call them owned just because they are direct.
    const pat = await createPersonClient(firm.id, { name: 'Pat Person' });
    const org = await createOrgClient(firm.id, { name: 'Billing Org LLC' });
    await linkPersonToOrg(firm.id, pat.id, org.id, { canViewBilling: true });
    await seedInvoice(firm.id, { clientContextId: pat.id, clientId: pat.id, totalCents: 4_321 });
    await seedInvoice(firm.id, { clientContextId: org.id, clientId: org.id, totalCents: 12_345 });

    const res = await scoped(owner, pat.id);

    expect(res.status).toBe(200);
    const byTotal = Object.fromEntries(res.body.invoices.map((inv: any) => [inv.totalAmount, inv]));
    expect(byTotal[123.45]).toMatchObject({
      billingRelation: 'other_client',
      billingRecipientClientId: org.id,
      billingRecipientName: 'Billing Org LLC',
    });
    expect(byTotal[43.21]).toMatchObject({
      billingRelation: 'owned',
      billingRecipientClientId: pat.id,
      billingRecipientName: 'Pat Person',
    });
    expect(res.body.summary).toEqual({
      ownedCount: 1, totalBilled: 43.21, totalPaid: 0, totalOutstanding: 43.21,
    });
  });

  it('agrees with the client summary endpoint on what this client owes', async () => {
    const { pat } = await seedWorld();

    const list = await scoped(owner, pat.id);
    const header = await summary(owner, pat.id);

    // Two independent computations of the same three figures: the tab's list
    // summary in dollars and the header's SQL in cents.
    expect(Math.round(list.body.summary.totalBilled * 100)).toBe(header.body.billing.totalBilledCents);
    expect(Math.round(list.body.summary.totalPaid * 100)).toBe(header.body.billing.totalPaidCents);
    expect(Math.round(list.body.summary.totalOutstanding * 100)).toBe(header.body.billing.outstandingCents);
    expect(header.body.billing.totalBilledCents).toBe(190_000);
  });

  it('refuses a member of another firm asking for this client\'s scope', async () => {
    const { pat } = await seedWorld();

    const res = await scoped(rivalOwner, pat.id);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Pat Own Matter');
  });
});

describe('permissions', () => {
  async function withoutBaseline(code: string, fn: () => Promise<void>) {
    const index = DEFAULT_PERMISSIONS.indexOf(code);
    expect(index).toBeGreaterThanOrEqual(0);
    DEFAULT_PERMISSIONS.splice(index, 1);
    try {
      await fn();
    } finally {
      DEFAULT_PERMISSIONS.splice(index, 0, code);
    }
  }

  it('withholds the matter count from a member who cannot read matters', async () => {
    const { pat, member } = await seedWorld();

    await withoutBaseline('matters.view', async () => {
      expect((await member.api.get(`/api/lawfirms/${firm.id}/matters?clientId=${pat.id}&limit=5`)).status).toBe(403);
      const res = await summary(member, pat.id);

      expect(res.status).toBe(200);
      expect(res.body.matters).toBeNull();
      expect(res.body.billing.invoiceCount).toBe(4);
    });
  });

  it('withholds every billing figure from a member whose role grants nothing', async () => {
    const { pat, member } = await seedWorld([]);

    expect((await member.api.get(
      `/api/lawfirms/${firm.id}/billing/invoices/firm?relatedClientId=${pat.id}&limit=5`,
    )).status).toBe(403);
    const res = await summary(member, pat.id);

    expect(res.status).toBe(200);
    expect(res.body.billing).toBeNull();
    expect(res.body.matters).toEqual({ count: 2 });
  });

  it('refuses a member who cannot read clients, as the client read does', async () => {
    const { pat, member } = await seedWorld();

    await withoutBaseline('clients.view', async () => {
      expect((await member.api.get(`/api/lawfirms/${firm.id}/clients/${pat.id}`)).status).toBe(403);
      expect((await summary(member, pat.id)).status).toBe(403);
    });
  });
});
