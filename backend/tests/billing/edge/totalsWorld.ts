/**
 * One billing world for the counts-and-totals surface specs.
 *
 * Every invoice is created through the real routes, and each one is recorded
 * in `ledger` with the cents the test seeded. Expectations are computed from
 * that ledger, never read back from another surface.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  createOrgClient,
  as,
  tokenFor,
  linkPersonToOrg,
  createTrustDeposit,
  drainEvents,
  ownerOf,
  type Actor,
  type Firm,
} from '../../support/setupInProcess';
import { seedMatter } from '../../support/matters';

export interface Entry {
  key: string;
  id: string;
  clientId: string | null;
  matterId: string | null;
  totalCents: number;
  paidCents: number;
  writtenOffCents: number;
  voided: boolean;
  /** The day a payment is next expected, as 'YYYY-MM-DD', or null. */
  dueDay: string | null;
  /** Whether a payment plan governs the next payment day. */
  planned?: boolean;
}

export interface World {
  firm: Firm;
  owner: Actor;
  tz: string;
  today: string;
  ledger: Entry[];
  clients: Record<string, string>;
  matters: Record<string, string>;
  day: (offset: number) => string;
  /** The portal login that owns the `main` client. */
  portal: Actor;
}

export const cents = (dollars: number) => Math.round(dollars * 100);
export const dollars = (c: number) => c / 100;

/** The calendar day in `tz` at `now`, shifted by `offset` days. */
export function dayIn(tz: string, offset: number, now = new Date()): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

export const remainingOf = (e: Entry) =>
  e.voided ? 0 : Math.max(0, e.totalCents - e.paidCents - e.writtenOffCents);

export const sum = (xs: Entry[], f: (e: Entry) => number) => xs.reduce((s, e) => s + f(e), 0);

/** Invoice-side API roots for a world. */
export const apiRoot = (w: World) => `/api/lawfirms/${w.firm.id}`;
export const invBase = (w: World) => `${apiRoot(w)}/billing/invoices`;
export const urlFor = (w: World, e: Entry, suffix = '') =>
  e.matterId
    ? `${invBase(w)}/matter/${e.matterId}/${e.id}${suffix}`
    : `${invBase(w)}/client/${e.clientId}/${e.id}${suffix}`;

/** The earliest unpaid instalment's due day, read from the stored schedule. */
async function firstPendingInstallmentDay(invoiceId: string): Promise<string> {
  const { rows } = await testPool.query(
    `select min(due_date)::text as day from invoice_expected_payments
      where invoice_id = $1 and status in ('pending', 'overdue')`, [invoiceId]);
  return rows[0].day;
}

export function entry(w: World, key: string): Entry {
  const e = w.ledger.find((x) => x.key === key);
  if (!e) throw new Error(`no ledger entry ${key}`);
  return e;
}

async function issueClient(w: World, key: string, clientKey: string, totalCents: number, dueDay: string | null, extra: Record<string, unknown> = {}) {
  const amount = dollars(totalCents);
  const res = await w.owner.api.post(`${invBase(w)}/client/${w.clients[clientKey]}`).send({
    invoiceName: key,
    invoiceDate: w.day(-2),
    ...(dueDay ? { dueDate: dueDay } : {}),
    totalAmount: amount,
    flatFeesAmount: amount,
    flatFees: [{ description: key, amount }],
    ...extra,
  });
  expect(res.status).toBe(201);
  const e: Entry = {
    key, id: res.body.invoice.id, clientId: w.clients[clientKey], matterId: null,
    totalCents, paidCents: 0, writtenOffCents: 0, voided: false, dueDay,
  };
  w.ledger.push(e);
  return e;
}

export async function pay(w: World, e: Entry, payCents: number, extra: Record<string, unknown> = {}) {
  const res = await w.owner.api.put(urlFor(w, e, '/payment')).send({ paymentAmount: dollars(payCents), ...extra });
  expect(res.status).toBe(200);
  e.paidCents += payCents;
}

export async function writeOff(w: World, e: Entry, amountCents: number, type: 'write_off' | 'discount' = 'write_off') {
  const res = await w.owner.api.post(urlFor(w, e, '/credit-note')).send({ amount: dollars(amountCents), type, description: 'adjustment' });
  expect([200, 201]).toContain(res.status);
  e.writtenOffCents += amountCents;
}

export async function voidIt(w: World, e: Entry) {
  const res = await w.owner.api.post(urlFor(w, e, '/void'));
  expect(res.status).toBe(200);
  e.voided = true;
}

/**
 * Build the whole world. `tz` is the viewer's zone; every due day is relative
 * to that zone's calendar day.
 */
export async function buildWorld(tz = 'America/New_York'): Promise<World> {
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const day = (offset: number) => dayIn(tz, offset);
  const portalLogin = await createPortalUser();
  const w: World = {
    firm, owner, tz, today: day(0), ledger: [], clients: {}, matters: {}, day,
    portal: { uid: portalLogin.uid, api: as(tokenFor({ uid: portalLogin.uid }), tz) },
  };

  const mk = async (key: string, name: string, email: string, userId?: string) => {
    w.clients[key] = (await createPersonClient(firm.id, { name, email, userId })).id;
  };
  await mk('main', 'Main Client', 'main@example.test', portalLogin.uid);
  await mk('split1', 'Split One', 'split1@example.test');
  await mk('split2', 'Split Two', 'split2@example.test');
  await mk('split3', 'Split Three', 'split3@example.test');
  await mk('person', 'Linked Person', 'person@example.test');
  await mk('idle', 'Idle Client', 'idle@example.test');
  w.clients.org = (await createOrgClient(firm.id, { name: 'Org Holdings', email: 'org@example.test' })).id;
  await linkPersonToOrg(firm.id, w.clients.person, w.clients.org, { canViewBilling: true });

  w.matters.split = await seedMatter(firm.id, {
    name: 'Split Matter', memberUids: [owner.uid],
    clientIds: [w.clients.split1, w.clients.split2, w.clients.split3],
  });
  w.matters.main = await seedMatter(firm.id, { name: 'Main Matter', memberUids: [owner.uid], clientIds: [w.clients.main] });
  w.matters.empty = await seedMatter(firm.id, { name: 'Empty Matter', memberUids: [owner.uid], clientIds: [w.clients.idle] });

  // Live, unpaid, due in ten days.
  await issueClient(w, 'live', 'main', cents(400), day(10));
  // Partially paid, non-round.
  const partial = await issueClient(w, 'partial', 'main', cents(1000), day(10));
  await pay(w, partial, cents(250.55));
  // Fully paid.
  const paid = await issueClient(w, 'paid', 'main', cents(500), day(-5));
  await pay(w, paid, cents(500));
  // Credit note equal to the total: credited.
  const credited = await issueClient(w, 'credited', 'main', cents(300), day(2));
  await writeOff(w, credited, cents(300), 'discount');
  // Paid in part, remainder written off.
  const remainderOff = await issueClient(w, 'remainderOff', 'main', cents(800), day(-3));
  await pay(w, remainderOff, cents(300));
  await writeOff(w, remainderOff, cents(500));
  // Zero-total invoice.
  await issueClient(w, 'zero', 'main', 0, day(1), { flatFeesAmount: 0, flatFees: [] });
  // Voided after a partial credit (the route refuses to void an invoice holding a payment).
  const voided = await issueClient(w, 'voided', 'main', cents(1000), day(-30));
  await writeOff(w, voided, cents(100), 'discount');
  await voidIt(w, voided);
  // Due-day ladder.
  await issueClient(w, 'dueToday', 'idle', cents(110.11), day(0));
  await issueClient(w, 'dueYesterday', 'idle', cents(220.22), day(-1));
  await issueClient(w, 'dueTomorrow', 'idle', cents(330.33), day(1));
  await issueClient(w, 'due7', 'idle', cents(440.44), day(7));
  await issueClient(w, 'due8', 'idle', cents(550.55), day(8));
  await issueClient(w, 'noDue', 'idle', cents(660.66), null);
  // Tax: subtotal 1000.01 at 8.875 percent.
  {
    const res = await owner.api.post(`${invBase(w)}/client/${w.clients.person}`).send({
      invoiceName: 'taxed', invoiceDate: day(-2), dueDate: day(15),
      totalAmount: 1000.01, flatFeesAmount: 1000.01, taxRate: 8.875,
      flatFees: [{ description: 'taxed', amount: 1000.01 }],
    });
    expect(res.status).toBe(201);
    w.ledger.push({ key: 'taxed', id: res.body.invoice.id, clientId: w.clients.person, matterId: null,
      totalCents: 108_876, paidCents: 0, writtenOffCents: 0, voided: false, dueDay: day(15) });
  }
  // Organization direct invoice, overdue.
  await issueClient(w, 'orgOverdue', 'org', cents(888.88), day(-3));

  // Matter invoice billed to the matter's client, and one naming nobody.
  {
    const res = await owner.api.post(invBase(w)).send({
      matterId: w.matters.main, clientId: w.clients.main, invoiceName: 'matterBilled',
      invoiceDate: day(-2), dueDate: day(20), totalAmount: 777.77, flatFeesAmount: 777.77,
      flatFees: [{ description: 'matterBilled', amount: 777.77 }],
    });
    expect(res.status).toBe(201);
    w.ledger.push({ key: 'matterBilled', id: res.body.invoice.id, clientId: w.clients.main, matterId: w.matters.main,
      totalCents: 77_777, paidCents: 0, writtenOffCents: 0, voided: false, dueDay: day(20) });
  }

  // Zero-total invoice that is also past its due day.
  await issueClient(w, 'zeroLate', 'main', 0, day(-4), { flatFeesAmount: 0, flatFees: [] });

  // Late fee: a $25 flat fee lands on an invoice that is a month past due.
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing', jsonb_build_object('lateFee',
               jsonb_build_object('enabled', true, 'flatAmount', 25, 'percent', 0, 'graceDays', 5)))
      where id = $1`,
    [firm.id],
  );
  const late = await issueClient(w, 'lateFee', 'person', cents(200), day(-30));
  {
    const res = await owner.api.post(urlFor(w, late, '/late-fee')).send({});
    expect(res.status).toBe(200);
    late.totalCents += cents(25);
  }

  // One hour at $100.00 split three ways: 33.34 / 33.33 / 33.33.
  {
    const te = await owner.api.post(`${apiRoot(w)}/billing/time-entries`).send({
      matterId: w.matters.split, userId: owner.uid, hours: 1, date: day(-3), hourlyRate: 100, description: 'Shared work',
    });
    expect(te.status).toBe(201);
    const teId = te.body.timeEntry.id;
    const shares: Array<[string, string, number]> = [['split1', 'splitA', 3334], ['split2', 'splitB', 3333], ['split3', 'splitC', 3333]];
    const hoursOf = (c: number) => (c === 3334 ? 0.34 : 0.33);
    const res = await owner.api.post(`${invBase(w)}/matter/${w.matters.split}/split`).send({
      invoiceDate: day(-2), dueDate: day(12), splitMode: 'equal',
      sourceSelection: { timeEntries: [teId], flatFees: [] },
      invoices: shares.map(([ck, name, c]) => ({
        matterClientId: w.clients[ck], invoiceName: name, totalAmount: dollars(c),
        totalHours: hoursOf(c), allocationPercent: c / 100,
        timeEntries: [{ id: teId, amount: dollars(c), hours: hoursOf(c), allocationPercent: c / 100 }],
      })),
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    const created = await testPool.query(
      `select id, invoice_name, total_cents, matter_client_id, client_id from invoices
        where law_firm_id = $1 and split_group_id is not null`, [firm.id]);
    for (const [ck, name, c] of shares) {
      const row = created.rows.find((r: any) => r.invoice_name === name);
      expect(Number(row.total_cents)).toBe(c);
      w.ledger.push({ key: name, id: row.id, clientId: w.clients[ck], matterId: w.matters.split,
        totalCents: c, paidCents: 0, writtenOffCents: 0, voided: false, dueDay: day(12) });
    }
  }

  // Payment plan: $1,200.00 in $300.00 instalments; instalment one paid in full,
  // instalment two paid in part.
  {
    const plan = await issueClient(w, 'plan', 'main', cents(1200), day(-20));
    const res = await owner.api.post(urlFor(w, plan, '/payment-plan')).send({
      installmentAmount: 300, frequencyDays: 30, planStartDate: day(5),
    });
    expect(res.status).toBe(200);
    await pay(w, plan, cents(300), { installmentIndex: 0 });
    await pay(w, plan, cents(120.5), { installmentIndex: 1 });
    plan.dueDay = await firstPendingInstallmentDay(plan.id);
    plan.planned = true;
  }

  // Payment plan whose first instalment is already late and unpaid.
  {
    const late = await issueClient(w, 'planLate', 'person', cents(600), day(-30));
    const res = await owner.api.post(urlFor(w, late, '/payment-plan')).send({
      installmentAmount: 200, frequencyDays: 30, planStartDate: day(-10),
    });
    expect(res.status).toBe(200);
    late.dueDay = await firstPendingInstallmentDay(late.id);
    late.planned = true;
  }

  // Paid from the client's trust account, in part.
  {
    const trust = await createTrustDeposit(firm.id, w.clients.main, { amountCents: 500_000 });
    const t = await issueClient(w, 'trustPaid', 'main', cents(400), day(9));
    await pay(w, t, cents(150), { paymentSource: 'trust', trustAccountId: trust.accountId });
  }

  // Paid in full by Stripe (the webhook's own writes, seeded directly).
  {
    const s = await issueClient(w, 'stripePaid', 'main', cents(600), day(6));
    await testPool.query(
      `insert into invoice_payments (invoice_id, law_firm_id, amount_cents, payment_date, payment_source, stripe_payment_intent_id)
       values ($1, $2, $3, current_date, 'stripe', 'pi_edge_1')`, [s.id, firm.id, s.totalCents]);
    const upd = await testPool.query(
      `update invoices set amount_paid_cents = $2, is_paid = true, status = 'paid', paid_date = now() where id = $1`,
      [s.id, s.totalCents]);
    expect(upd.rowCount).toBe(1);
    s.paidCents = s.totalCents;
  }

  await drainEvents();
  return w;
}
