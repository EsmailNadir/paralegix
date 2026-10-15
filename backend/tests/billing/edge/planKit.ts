/**
 * Shared scaffolding for the payment-plan edge specs.
 *
 * `usePlanKit()` registers a `beforeEach` that creates a firm, an owner and a
 * person client, and returns helpers that talk to the real invoice routes and
 * read the stored rows back. `expectScheduleMatchesBalance` is the invariant
 * every spec asserts after every mutation: the instalments still owed add up to
 * the balance the invoice reports, because a schedule that disagrees with the
 * balance collects the wrong amount without any screen looking wrong.
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
} from '../../support/setupInProcess';

export interface InstallmentRow {
  amount_cents: string;
  due_date: string;
  status: string;
  matched_payment_index: number | null;
  is_down_payment: boolean;
  sort_order: number;
  stripe_invoice_id: string | null;
  stripe_payment_status: string | null;
}

export interface Kit {
  firm: Firm;
  owner: Actor;
  client: ClientRecord;
  /** The invoice created for the current test. */
  invoiceId: string;
  base: () => string;
  on: (suffix?: string, id?: string) => string;
  createInvoice: (total: number, extra?: Record<string, unknown>) => Promise<string>;
  setPlan: (body?: Record<string, unknown>, id?: string) => ReturnType<Actor['api']['post']>;
  pay: (body: Record<string, unknown>, id?: string) => ReturnType<Actor['api']['put']>;
  rows: (id?: string) => Promise<InstallmentRow[]>;
  invoice: (id?: string) => Promise<any>;
  payments: (id?: string) => Promise<Array<{ amount_cents: string; payment_date: string }>>;
  pendingCents: (id?: string) => Promise<number>;
  /** [amount in cents, status] per row, in schedule order. */
  shape: (id?: string) => Promise<Array<[number, string]>>;
  /** Asserts pending rows == balance and the schedule bookkeeping is coherent. */
  expectScheduleMatchesBalance: (id?: string, label?: string) => Promise<void>;
}

export function usePlanKit(defaultTotal = 1000): Kit {
  const kit = {} as Kit;

  kit.base = () => `/api/lawfirms/${kit.firm.id}/billing/invoices/client/${kit.client.id}`;
  kit.on = (suffix = '', id?: string) => `${kit.base()}/${id ?? kit.invoiceId}${suffix}`;

  let invoiceSeq = 0;
  kit.createInvoice = async (total, extra = {}) => {
    invoiceSeq += 1;
    const res = await kit.owner.api.post(kit.base()).send({
      invoiceName: `Plan Invoice ${invoiceSeq}`,
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      totalAmount: total,
      flatFeesAmount: total,
      flatFees: [{ description: 'Fixed fee', amount: total }],
      ...extra,
    });
    if (res.status !== 201) throw new Error(`invoice create failed ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.invoice.id as string;
  };

  kit.setPlan = (body = {}, id) => kit.owner.api.post(kit.on('/payment-plan', id)).send({
    installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01', ...body,
  });

  kit.pay = (body, id) => kit.owner.api.put(kit.on('/payment', id)).send(body);

  kit.rows = async (id) => (await testPool.query(
    `select amount_cents, due_date, status, matched_payment_index, is_down_payment, sort_order,
            stripe_invoice_id, stripe_payment_status
       from invoice_expected_payments where invoice_id = $1 order by sort_order`,
    [id ?? kit.invoiceId],
  )).rows;

  kit.invoice = async (id) => (await testPool.query(
    `select total_cents, amount_paid_cents, total_written_off_cents, balance_due_cents,
            is_paid, status, next_payment_date, due_date, payment_plan_enabled
       from invoices where id = $1`,
    [id ?? kit.invoiceId],
  )).rows[0];

  kit.payments = async (id) => (await testPool.query(
    'select amount_cents, payment_date from invoice_payments where invoice_id = $1 order by sort_order',
    [id ?? kit.invoiceId],
  )).rows;

  kit.pendingCents = async (id) => (await kit.rows(id))
    .filter((r) => r.status !== 'paid')
    .reduce((sum, r) => sum + Number(r.amount_cents), 0);

  kit.shape = async (id) => (await kit.rows(id)).map((r) => [Number(r.amount_cents), r.status]);

  kit.expectScheduleMatchesBalance = async (id, label = '') => {
    const inv = await kit.invoice(id);
    const rows = await kit.rows(id);
    const pending = rows.filter((r) => r.status !== 'paid');
    const pendingSum = pending.reduce((sum, r) => sum + Number(r.amount_cents), 0);
    const tag = label ? ` [${label}]` : '';
    if (!inv.payment_plan_enabled) {
      expect({ tag, rows: rows.length }).toEqual({ tag, rows: 0 });
      return;
    }
    expect({ tag, pendingSum }).toEqual({ tag, pendingSum: Number(inv.balance_due_cents) });
    expect({ tag, zeroRows: pending.filter((r) => Number(r.amount_cents) <= 0).length })
      .toEqual({ tag, zeroRows: 0 });
    expect(rows.length).toBeLessThanOrEqual(120);
  };

  beforeEach(async () => {
    kit.firm = await createFirm();
    kit.owner = await ownerOf(kit.firm.id);
    kit.client = await createPersonClient(kit.firm.id, { name: 'Edge Client' });
    kit.invoiceId = await kit.createInvoice(defaultTotal);
    await drainEvents();
  });

  return kit;
}

/** Deterministic PRNG (mulberry32) so a failing case reproduces from its seed. */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
