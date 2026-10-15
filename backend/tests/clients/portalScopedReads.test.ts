/**
 * What one portal client is served, proved against a second client of the SAME
 * firm whose data is seeded and must never appear.
 *
 * The client portal is the only place a person outside the firm reads firm
 * data, so every route in `portal.service.ts` is an access-control surface. The
 * existing organization specs cover the association layer: who may act as which
 * client record, and how `can_view_billing` gates an organization's money. They
 * do not cover the READ paths themselves, and several of the largest ones had no
 * test at all: the aggregate dashboard (`/firm-summaries`), one invoice by id
 * (`/invoices/:invoiceId`), a matter's shared notes, a single matter's agenda,
 * and the notification bell's write endpoints.
 *
 * Those are the routes where a scoping mistake is invisible. A list that scoped
 * by FIRM instead of by the calling client returns a perfectly ordinary 200, and
 * the screen looks right. So nothing here asserts an absence on its own: every
 * negative is paired with the neighbour's own request returning the same record,
 * which proves the fixture is real and reachable rather than missing.
 *
 * THE CAST, built fresh per test:
 *
 *   `me`        a person client of Hale & Co, one association, so no
 *               `clientRecordId` is ever needed.
 *   `neighbour` a second person client of the SAME firm. Every leak assertion
 *               in this file is "must not see the neighbour's row", and every
 *               one of those rows is fetched successfully BY the neighbour in
 *               the same test.
 *   `myMatter` / `neighbourMatter`  one matter each.
 *   `sharedMatter`  a matter BOTH are clients of. This is the sharpest case in
 *               the file: matter access is not invoice access, and a co-client
 *               on a joint matter must not open an invoice addressed to the
 *               other one.
 *
 * Fixtures are plain SQL through `testPool`, never the app's own routes. A
 * fixture built by the code under test cannot fail when that code is wrong.
 *
 * Money in the database is integer cents; the portal serializes invoice amounts
 * as DOLLARS (`invoices.repository` maps `total_cents` through `dollars()`), so
 * the two units both appear below and are named at each use.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
const filesRepo = require('../../src/modules/files/files.repository');

interface PortalPerson extends Actor {
  /** The `clients` row this portal user owns in the firm under test. */
  clientId: string;
  email: string;
}

let firm: Firm;
let me: PortalPerson;
let neighbour: PortalPerson;
let myMatter: string;
let neighbourMatter: string;
let sharedMatter: string;

const P = () => `/api/client-portal/lawfirm/${firm.id}`;

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * A portal user plus their own person `clients` row in one firm.
 *
 * The email is unique per person and is set on BOTH the `users` row (by the
 * factory) and the `clients` row, because two of the ownership rules under test
 * match on email: `findMatterClientDocIds` matches a placeholder matter-client
 * by email, and `invoiceBelongsToClient` matches `billing_email`. Giving the two
 * people the same email would make every leak case here pass for the wrong
 * reason.
 */
async function portalPerson(lawFirmId: string, name: string): Promise<PortalPerson> {
  const { uid } = await createPortalUser({ name });
  const email = `${uid}@example.test`;
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email });
  return { uid, clientId: client.id, email, api: as(tokenFor({ uid })) };
}

/** A matter, plus a `matter_clients` row per client on it. */
async function seedMatter(lawFirmId: string, name: string, clientIds: string[]) {
  const id = randomUUID();
  const inserted = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(inserted.rowCount).toBe(1);

  for (const clientId of clientIds) {
    const link = await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [id, clientId, lawFirmId],
    );
    // The junction IS the portal's definition of matter access
    // (`clientsRepo.listMatterIds`). A silently missing row would turn every
    // positive case below into a 403 and every negative one into a vacuous pass.
    expect(link.rowCount).toBe(1);
  }
  return id;
}

/**
 * A client-context invoice: billed to a client directly, with no matter.
 *
 * The schema's CHECK requires exactly one of `matter_id` / `client_context_id`,
 * which is what distinguishes the two billing contexts the portal resolves
 * through.
 */
async function seedClientInvoice(
  lawFirmId: string,
  clientId: string,
  options: { totalCents: number; paidCents?: number; isPaid?: boolean; dueInDays?: number } = { totalCents: 100_00 },
) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, amount_paid_cents, is_paid,
                           invoice_date, due_date)
     values ($1, $2, $3, $3, 'client', $4, 'outstanding', $5, $6, $7,
             current_date, current_date + $8::int)`,
    [
      id, lawFirmId, clientId, `INV-${id.slice(0, 8)}`,
      options.totalCents, options.paidCents ?? 0, options.isPaid ?? false,
      options.dueInDays ?? 30,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, totalCents: options.totalCents };
}

/**
 * A matter-context invoice, addressed to ONE of the matter's clients.
 *
 * `matterClientId`, `client_id` and `billing_email` are the three fields
 * `invoiceBelongsToClient` consults, so they are set together and all point at
 * the same person. An invoice that named the matter but nobody on it would be
 * unowned, and would not exercise the ownership rule at all.
 */
async function seedMatterInvoice(
  lawFirmId: string,
  matterId: string,
  billedTo: PortalPerson,
  options: { totalCents: number } = { totalCents: 100_00 },
) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, matter_client_id,
                           context_type, billing_email, invoice_number, status,
                           total_cents, invoice_date, due_date)
     values ($1, $2, $3, $4, $4, 'matter', $5, $6, 'outstanding', $7,
             current_date, current_date + 30)`,
    [id, lawFirmId, matterId, billedTo.clientId, billedTo.email, `INV-${id.slice(0, 8)}`, options.totalCents],
  );
  expect(res.rowCount).toBe(1);
  return { id, totalCents: options.totalCents };
}

/** A firm-internal matter note. */
async function seedMatterNote(lawFirmId: string, matterId: string, options: { subject: string; content: string }) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into notes (id, law_firm_id, matter_id, subject, content, content_html, note_type)
     values ($1, $2, $3, $4, $5, $5, 'general')`,
    [id, lawFirmId, matterId, options.subject, options.content],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

/** A matter event. Only client-visible, non-cancelled, future events reach the portal. */
async function seedEvent(
  lawFirmId: string,
  matterId: string,
  options: { title: string; clientVisible?: boolean; status?: string; daysAhead?: number },
) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, title, type, status,
                                date, client_visible)
     values ($1, $2, $3, $4, 'hearing', $5, now() + ($6::int * interval '1 day'), $7)`,
    [
      id, lawFirmId, matterId, options.title,
      options.status ?? 'upcoming', options.daysAhead ?? 7, options.clientVisible ?? true,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

/** One row in the notification bell's feed. */
async function seedNotification(lawFirmId: string, userId: string, title: string) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into notifications (id, law_firm_id, user_id, type, title, body, read)
     values ($1, $2, $3, 'message', $4, 'Body text', false)`,
    [id, lawFirmId, userId, title],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

const notificationRead = async (id: string) => {
  const { rows } = await testPool.query('select read from notifications where id = $1', [id]);
  return rows[0]?.read;
};

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  await ownerOf(firm.id);

  me = await portalPerson(firm.id, 'Mia Client');
  neighbour = await portalPerson(firm.id, 'Otto Other');

  myMatter = await seedMatter(firm.id, 'Mia Only', [me.clientId]);
  neighbourMatter = await seedMatter(firm.id, 'Otto Only', [neighbour.clientId]);
  sharedMatter = await seedMatter(firm.id, 'Joint Venture', [me.clientId, neighbour.clientId]);
});

/* ------------------------------------------------------------------ */
/*  /firm-summaries                                                    */
/* ------------------------------------------------------------------ */

describe('the aggregate firm dashboard', () => {
  /** The one summary card for the firm under test. */
  const summaryFor = async (person: PortalPerson, lawFirmId: string) => {
    const res = await person.api.get('/api/client-portal/firm-summaries');
    expect(res.status).toBe(200);
    return res.body.lawFirms.find((f: any) => f.id === lawFirmId);
  };

  it('counts the matters this client is actually on', async () => {
    const card = await summaryFor(me, firm.id);

    // Two of the firm's three matters: their own, plus the joint one.
    expect(card.matterCount).toBe(2);
  });

  it('does NOT count a matter belonging only to another client of the same firm', async () => {
    const { rows } = await testPool.query(
      'select count(*)::int as total from matters where law_firm_id = $1', [firm.id],
    );
    // The neighbour's matter exists, so the count above is a real exclusion
    // rather than an assertion against an empty firm.
    expect(rows[0].total).toBe(3);

    const mine = await summaryFor(me, firm.id);
    const theirs = await summaryFor(neighbour, firm.id);

    // Both see two, and they are not the same two: `neighbourMatter` is
    // reachable, just not by me.
    expect(mine.matterCount).toBe(2);
    expect(theirs.matterCount).toBe(2);
    expect((await me.api.get(`${P()}/matters/${neighbourMatter}`)).status).toBe(403);
    expect((await neighbour.api.get(`${P()}/matters/${neighbourMatter}`)).status).toBe(200);
  });

  it('sums the client-context invoices billed to this client', async () => {
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 250_000 });

    const card = await summaryFor(me, firm.id);

    // Cents on this endpoint, unlike the dollar amounts the invoice reads
    // serialize. The distinct figure is what makes its presence meaningful.
    expect(card.outstandingBalanceCents).toBe(250_000);
  });

  it('leaves another client invoices out of the balance', async () => {
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 250_000 });
    await seedClientInvoice(firm.id, neighbour.clientId, { totalCents: 999_900 });

    const mine = await summaryFor(me, firm.id);
    const theirs = await summaryFor(neighbour, firm.id);

    // The neighbour's figure is asserted too, so this cannot pass because the
    // invoice was never created or is outstanding-zero. If the summary lost its
    // per-client predicate both cards would read 1,249,900.
    expect(mine.outstandingBalanceCents).toBe(250_000);
    expect(theirs.outstandingBalanceCents).toBe(999_900);
  });

  it('leaves a co-client invoice on a SHARED matter out of the balance', async () => {
    await seedMatterInvoice(firm.id, sharedMatter, me, { totalCents: 111_100 });
    await seedMatterInvoice(firm.id, sharedMatter, neighbour, { totalCents: 777_700 });

    const mine = await summaryFor(me, firm.id);
    const theirs = await summaryFor(neighbour, firm.id);

    // Matter access is not invoice access. Both people can open the joint
    // matter, so a summary that summed every invoice on every ACCESSIBLE matter
    // would report 888,800 to each of them.
    expect(mine.outstandingBalanceCents).toBe(111_100);
    expect(theirs.outstandingBalanceCents).toBe(777_700);
  });

  it('does not list a firm this client has no association with', async () => {
    const elsewhere = await createFirm({ name: 'Unrelated LLP' });
    await ownerOf(elsewhere.id);
    const theirClient = await portalPerson(elsewhere.id, 'Xena Elsewhere');
    await seedMatter(elsewhere.id, 'Someone Else Matter', [theirClient.clientId]);

    const res = await me.api.get('/api/client-portal/firm-summaries');
    const theirs = await theirClient.api.get('/api/client-portal/firm-summaries');

    // The firm is real and produces a card for its OWN client. A cross-tenant
    // leak here would put another firm's name on this client's dashboard.
    expect(res.body.lawFirms.map((f: any) => f.id)).toEqual([firm.id]);
    expect(theirs.body.lawFirms.map((f: any) => f.id)).toEqual([elsewhere.id]);
  });

  it('gives one person a separate card per firm they are a client of', async () => {
    const second = await createFirm({ name: 'Aardvark Legal' });
    await ownerOf(second.id);
    // The SAME uid, a second `clients` row. A person can be a client of several
    // firms, and each firm's card must count only its own work.
    const secondRecord = await createPersonClient(second.id, {
      name: 'Mia Client', userId: me.uid, email: me.email,
    });
    await seedMatter(second.id, 'Second Firm Matter', [secondRecord.id]);
    await seedClientInvoice(second.id, secondRecord.id, { totalCents: 40_500 });

    const res = await me.api.get('/api/client-portal/firm-summaries');
    const here = res.body.lawFirms.find((f: any) => f.id === firm.id);
    const there = res.body.lawFirms.find((f: any) => f.id === second.id);

    expect(here.matterCount).toBe(2);
    expect(here.outstandingBalanceCents).toBe(0);
    expect(there.matterCount).toBe(1);
    expect(there.outstandingBalanceCents).toBe(40_500);
  });

  it('reports ZERO balance for an organization the caller may not bill on', async () => {
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    await seedMatter(firm.id, 'Acme Matter', [org.id]);
    await seedClientInvoice(firm.id, org.id, { totalCents: 543_200 });

    const permitted = await portalPerson(firm.id, 'Bea Billing');
    const denied = await portalPerson(firm.id, 'Ned NoBilling');
    await linkPersonToOrg(firm.id, permitted.clientId, org.id, { canViewBilling: true });
    await linkPersonToOrg(firm.id, denied.clientId, org.id, { canViewBilling: false });

    const permittedCard = await summaryFor(permitted, firm.id);
    const deniedCard = await summaryFor(denied, firm.id);

    // The organization's money is real and reaches the roster member who may
    // see it, which is what makes the zero below an enforcement rather than an
    // empty ledger. Both still get the organization's MATTER, because the
    // dashboard degrades to matters-only rather than refusing outright.
    expect(permittedCard.outstandingBalanceCents).toBe(543_200);
    expect(deniedCard.outstandingBalanceCents).toBe(0);
    expect(deniedCard.matterCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  /invoices/:invoiceId                                               */
/* ------------------------------------------------------------------ */

describe('one invoice, by id', () => {
  it('serves the client an invoice billed to their own record', async () => {
    const invoice = await seedClientInvoice(firm.id, me.clientId, { totalCents: 250_000 });

    const res = await me.api.get(`${P()}/invoices/${invoice.id}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(invoice.id);
    // Serialized in DOLLARS, from `total_cents` through the repository's
    // `dollars()`. A unit slip here would show a client a bill 100x too large.
    expect(res.body.invoice.totalAmount).toBe(2500);
    expect(res.body.invoice.contextType).toBe('client');
  });

  it('answers NOT FOUND for another client invoice in the same firm', async () => {
    const theirs = await seedClientInvoice(firm.id, neighbour.clientId, { totalCents: 999_900 });

    const mine = await me.api.get(`${P()}/invoices/${theirs.id}`);
    const owner = await neighbour.api.get(`${P()}/invoices/${theirs.id}`);

    // 404 rather than 403, so probing ids cannot distinguish "not yours" from
    // "does not exist". The neighbour's 200 proves the id is live.
    expect(mine.status).toBe(404);
    expect(owner.status).toBe(200);
    expect(owner.body.invoice.totalAmount).toBe(9999);
  });

  it('serves a matter invoice on a shared matter that is billed to this client', async () => {
    const invoice = await seedMatterInvoice(firm.id, sharedMatter, me, { totalCents: 111_100 });

    const res = await me.api.get(`${P()}/invoices/${invoice.id}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.contextType).toBe('matter');
    expect(res.body.invoice.matterId).toBe(sharedMatter);
  });

  it('refuses a matter invoice on the SAME shared matter billed to the co-client', async () => {
    const theirs = await seedMatterInvoice(firm.id, sharedMatter, neighbour, { totalCents: 777_700 });

    const mine = await me.api.get(`${P()}/invoices/${theirs.id}`);
    const owner = await neighbour.api.get(`${P()}/invoices/${theirs.id}`);

    // The sharpest case in the file. I have full access to `sharedMatter`, so
    // the matter check passes and ONLY the ownership rule stands between me and
    // a bill addressed to somebody else. Drop that rule and this returns 200
    // with the co-client's figures, on a route that looks entirely healthy.
    expect(mine.status).toBe(404);
    expect(owner.status).toBe(200);
    expect(owner.body.invoice.totalAmount).toBe(7777);
  });

  it('refuses a matter invoice addressed to this client on a matter they are not on', async () => {
    // Billed to `me` by email, but hung off the matter only the neighbour is a
    // client of. The ownership rule alone would ADMIT this (the billing email
    // matches), so it is the matter check and nothing else standing in the way.
    const id = randomUUID();
    const inserted = await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, context_type, billing_email,
                             invoice_number, status, total_cents, invoice_date, due_date)
       values ($1, $2, $3, 'matter', $4, $5, 'outstanding', 62_300, current_date, current_date + 30)`,
      [id, firm.id, neighbourMatter, me.email, `INV-${id.slice(0, 8)}`],
    );
    expect(inserted.rowCount).toBe(1);

    const res = await me.api.get(`${P()}/invoices/${id}`);

    // 403, not the 404 the ownership rule produces. The two refusals mean
    // different things and this one is checked first: reading it would
    // otherwise disclose a matter this client has no part in.
    expect(res.status).toBe(403);
  });

  it('refuses an invoice belonging to another firm', async () => {
    const elsewhere = await createFirm({ name: 'Unrelated LLP' });
    await ownerOf(elsewhere.id);
    const theirClient = await portalPerson(elsewhere.id, 'Xena Elsewhere');
    const theirs = await seedClientInvoice(elsewhere.id, theirClient.clientId, { totalCents: 555_500 });

    const mine = await me.api.get(`${P()}/invoices/${theirs.id}`);
    const owner = await theirClient.api.get(
      `/api/client-portal/lawfirm/${elsewhere.id}/invoices/${theirs.id}`,
    );

    // Addressed under MY firm's id, so this is the tenancy predicate rather
    // than the ownership one. The second call proves the invoice exists.
    expect(mine.status).toBe(404);
    expect(owner.status).toBe(200);
  });

  it('answers NOT FOUND for an id that is not a uuid', async () => {
    // The uuid guard, not a database cast error. Without `isUuid` this reaches
    // Postgres and comes back a 500, which tells a prober that the shape of
    // their input mattered.
    expect((await me.api.get(`${P()}/invoices/not-a-uuid`)).status).toBe(404);
  });

  it('refuses an organization invoice to a roster member who cannot view billing', async () => {
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    const invoice = await seedClientInvoice(firm.id, org.id, { totalCents: 543_200 });

    const permitted = await portalPerson(firm.id, 'Bea Billing');
    const denied = await portalPerson(firm.id, 'Ned NoBilling');
    await linkPersonToOrg(firm.id, permitted.clientId, org.id, { canViewBilling: true });
    await linkPersonToOrg(firm.id, denied.clientId, org.id, { canViewBilling: false });

    const acting = `?clientRecordId=${org.id}`;
    const allowed = await permitted.api.get(`${P()}/invoices/${invoice.id}${acting}`);
    const refused = await denied.api.get(`${P()}/invoices/${invoice.id}${acting}`);

    // 403 here, not the 404 the ownership rule produces: the caller IS
    // associated with the record the invoice belongs to, and is being refused a
    // permission rather than told the invoice is out of scope.
    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
    // Nothing about the amount leaks through the refusal body.
    expect(JSON.stringify(refused.body)).not.toContain('5432');
  });
});

/* ------------------------------------------------------------------ */
/*  /billing                                                           */
/* ------------------------------------------------------------------ */

describe('the billing list', () => {
  it('omits a co-client invoice on a shared matter', async () => {
    const mineOnMatter = await seedMatterInvoice(firm.id, sharedMatter, me, { totalCents: 111_100 });
    const theirsOnMatter = await seedMatterInvoice(firm.id, sharedMatter, neighbour, { totalCents: 777_700 });

    const res = await me.api.get(`${P()}/billing`);
    const ids = res.body.invoices.map((i: any) => i.id);

    // Both invoices hang off a matter I can open. The list must be filtered by
    // who the invoice is ADDRESSED to, not by which matters I can reach.
    expect(ids).toContain(mineOnMatter.id);
    expect(ids).not.toContain(theirsOnMatter.id);
    expect(res.body.summary.totalBilled).toBe(1111);
  });

  it('narrows the list to one status while keeping the totals whole', async () => {
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 300_000 });
    await seedClientInvoice(firm.id, me.clientId, {
      totalCents: 100_000, paidCents: 100_000, isPaid: true,
    });

    const res = await me.api.get(`${P()}/billing?status=paid`);

    // The chips and the summary describe the whole book on purpose: a client
    // filtering to "paid" must still be told what they owe overall, and the
    // other chip must still carry its count or the filter cannot be undone.
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.totalItems).toBe(1);
    expect(res.body.statusCounts).toEqual({ paid: 1, outstanding: 1 });
    expect(res.body.summary.totalBilled).toBe(4000);
    expect(res.body.summary.totalOutstanding).toBe(3000);
  });

  it('windows the list while reporting the full count', async () => {
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 100_00, dueInDays: 10 });
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 200_00, dueInDays: 20 });
    await seedClientInvoice(firm.id, me.clientId, { totalCents: 300_00, dueInDays: 30 });

    const res = await me.api.get(`${P()}/billing?limit=2`);

    // `totalItems` is what the pager renders. A page that reported its own
    // length would show "2 of 2" on a three-invoice history and hide the third
    // behind a control the client is never given.
    expect(res.body.invoices).toHaveLength(2);
    expect(res.body.totalItems).toBe(3);
  });

  it('orders the page soonest-payment-first', async () => {
    const latest = await seedClientInvoice(firm.id, me.clientId, { totalCents: 300_00, dueInDays: 90 });
    const soonest = await seedClientInvoice(firm.id, me.clientId, { totalCents: 100_00, dueInDays: 2 });

    const res = await me.api.get(`${P()}/billing?limit=1`);

    // The order decides WHICH invoice a one-row page contains, so this is not
    // cosmetic: sorted the other way, the client's first page shows the bill
    // that is not due for three months and hides the one due this week.
    expect(res.body.invoices.map((i: any) => i.id)).toEqual([soonest.id]);
    expect(res.body.totalItems).toBe(2);
    expect(latest.id).not.toBe(soonest.id);
  });
});

/* ------------------------------------------------------------------ */
/*  /matters/:matterId/notes                                           */
/* ------------------------------------------------------------------ */

describe('firm-internal matter notes', () => {
  it('does not expose an authenticated portal notes endpoint even for a linked client', async () => {
    await seedMatterNote(firm.id, myMatter, { subject: 'Internal strategy', content: 'Private work product' });
    const stored = await testPool.query('select subject from notes where matter_id = $1', [myMatter]);
    expect(stored.rows.map((row) => row.subject)).toContain('Internal strategy');

    const res = await me.api.get(`${P()}/matters/${myMatter}/notes`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Internal strategy');
    expect(JSON.stringify(res.body)).not.toContain('Private work product');
  });
});

/* ------------------------------------------------------------------ */
/*  /events                                                            */
/* ------------------------------------------------------------------ */

describe('the portal agenda', () => {
  it('narrows to one matter when asked for one', async () => {
    await seedEvent(firm.id, myMatter, { title: 'My hearing' });
    await seedEvent(firm.id, sharedMatter, { title: 'Joint mediation' });

    const all = await me.api.get(`${P()}/events`);
    const narrowed = await me.api.get(`${P()}/events?matterId=${myMatter}`);

    // The unnarrowed read is asserted first so the narrowed one is provably a
    // filter: both events are visible to this client, and only the query
    // parameter removes one.
    expect(all.body.events.map((e: any) => e.title).sort()).toEqual(['Joint mediation', 'My hearing']);
    expect(narrowed.body.events.map((e: any) => e.title)).toEqual(['My hearing']);
    expect(narrowed.body.totalEvents).toBe(1);
  });

  it('refuses a matterId this client is not on', async () => {
    await seedEvent(firm.id, neighbourMatter, { title: 'Not my hearing' });

    const mine = await me.api.get(`${P()}/events?matterId=${neighbourMatter}`);
    const theirs = await neighbour.api.get(`${P()}/events?matterId=${neighbourMatter}`);

    // Named directly, so the firm-wide scoping never gets a chance to hide it.
    // Without the access check this returns the neighbour's court dates.
    expect(mine.status).toBe(403);
    expect(theirs.body.events.map((e: any) => e.title)).toEqual(['Not my hearing']);
  });

  it('withholds an event the firm did not mark client-visible', async () => {
    await seedEvent(firm.id, myMatter, { title: 'Shown', clientVisible: true });
    await seedEvent(firm.id, myMatter, { title: 'Internal deadline', clientVisible: false });

    const { rows } = await testPool.query(
      'select count(*)::int as total from events where matter_id = $1', [myMatter],
    );
    expect(rows[0].total).toBe(2);

    const res = await me.api.get(`${P()}/events?matterId=${myMatter}`);

    expect(res.body.events.map((e: any) => e.title)).toEqual(['Shown']);
  });

  it('withholds a cancelled event and one already in the past', async () => {
    await seedEvent(firm.id, myMatter, { title: 'Shown' });
    await seedEvent(firm.id, myMatter, { title: 'Called off', status: 'cancelled' });
    await seedEvent(firm.id, myMatter, { title: 'Last month', daysAhead: -30 });

    const res = await me.api.get(`${P()}/events?matterId=${myMatter}`);

    // The agenda answers "what is coming up", so a cancelled hearing and a past
    // one are both wrong to show, and each would have a client turning up or
    // chasing the firm about a date that no longer means anything.
    expect(res.body.events.map((e: any) => e.title)).toEqual(['Shown']);
  });
});

/* ------------------------------------------------------------------ */
/*  the notification bell's writes                                     */
/* ------------------------------------------------------------------ */

describe('marking notifications read', () => {
  it('cannot mark another portal user notification read', async () => {
    const theirs = await seedNotification(firm.id, neighbour.uid, 'Otto invoice is ready');

    const res = await me.api.post(`${P()}/notifications/${theirs.id}/read`);
    const stillUnread = await notificationRead(theirs.id);
    // The owner clearing it themselves proves the id, the route and the write
    // all work, so the false above is the user predicate refusing me rather
    // than the update failing for everyone.
    await neighbour.api.post(`${P()}/notifications/${theirs.id}/read`);

    expect(res.status).toBe(200);
    expect(stillUnread).toBe(false);
    expect(await notificationRead(theirs.id)).toBe(true);
  });

  it('leaves another user rows and another firm rows alone on mark-all-read', async () => {
    const second = await createFirm({ name: 'Aardvark Legal' });
    await ownerOf(second.id);
    await createPersonClient(second.id, { name: 'Mia Client', userId: me.uid, email: me.email });

    const here = await seedNotification(firm.id, me.uid, 'Mine, this firm');
    const elsewhere = await seedNotification(second.id, me.uid, 'Mine, other firm');
    const theirs = await seedNotification(firm.id, neighbour.uid, 'Otto row');

    const res = await me.api.post(`${P()}/notifications/mark-all-read`);

    // Exactly one row moves. The other two are the two ways this write can go
    // wrong: dropping the firm predicate silently reads a client's other firm's
    // bell, and dropping the user predicate clears every client of the firm.
    expect(res.body.updated).toBe(1);
    expect(await notificationRead(here.id)).toBe(true);
    expect(await notificationRead(elsewhere.id)).toBe(false);
    expect(await notificationRead(theirs.id)).toBe(false);
  });
});
