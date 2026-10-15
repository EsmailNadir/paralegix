/**
 * The day a payment is recorded on when no date is given.
 *
 * A payment recorded at 8pm Pacific on September 27 is 03:00 UTC on the 28th.
 * The default used to be the UTC day, so the invoice's payment history and the
 * trust ledger both said the 28th. The default is now today in the recorder's
 * zone: the one their request carries, else their saved zone.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  createTrustDeposit,
  ownerOf,
  drainEvents,
  sentEmails,
  resetEmails,
} from '../support/setupInProcess';
import { freezeClockAt } from '../support/clock';

const EVENING_PACIFIC = '2026-09-27T20:00:00-07:00';

async function seedWorld() {
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Marsh Holdings', email: 'marsh@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 50_000 });
  return { firm, owner, client, invoice };
}

const paymentUrl = (firmId: string, clientId: string, invoiceId: string) =>
  `/api/lawfirms/${firmId}/billing/invoices/client/${clientId}/${invoiceId}/payment`;

const paymentDays = async (invoiceId: string) => (await testPool.query(
  `select payment_date::text as day from invoice_payments where invoice_id = $1 order by sort_order`, [invoiceId],
)).rows.map((r) => r.day);

afterEach(async () => {
  await drainEvents();
});

describe('a payment recorded with no date', () => {
  /** Goes red if the default is the UTC day. */
  it('is dated today in the recorder\'s zone', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    freezeClockAt(EVENING_PACIFIC);

    const res = await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ paymentAmount: 100 });

    expect(res.status).toBe(200);
    expect(await paymentDays(invoice.id)).toEqual(['2026-09-27']);
  });

  it('marking the invoice paid dates the balancing payment the same way', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    freezeClockAt(EVENING_PACIFIC);

    const res = await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ isPaid: true });

    expect(res.status).toBe(200);
    expect(await paymentDays(invoice.id)).toEqual(['2026-09-27']);
  });

  /** Goes red if the trust withdrawal takes the UTC day: the ledger would say the 28th. */
  it('paid from trust, puts the withdrawal on the ledger for that day', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    const { accountId } = await createTrustDeposit(firm.id, client.id, { amountCents: 500_000 });
    freezeClockAt(EVENING_PACIFIC);

    const res = await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: accountId });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      `select txn_date::text as day from trust_transactions
        where law_firm_id = $1 and type = 'withdrawal'`, [firm.id],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-27']);
    expect(await paymentDays(invoice.id)).toEqual(['2026-09-27']);
  });

  /** Goes red if a request with no zone falls straight to UTC instead of the recorder's saved zone. */
  it('with no zone on the request, uses the recorder\'s saved zone', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    await testPool.query(`update users set timezone = 'America/Los_Angeles' where id = $1`, [owner.uid]);
    freezeClockAt(EVENING_PACIFIC);

    const res = await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .unset('x-timezone')
      .send({ paymentAmount: 100 });

    expect(res.status).toBe(200);
    expect(await paymentDays(invoice.id)).toEqual(['2026-09-27']);
  });

  it('keeps a date the recorder entered', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    freezeClockAt(EVENING_PACIFIC);

    await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ paymentAmount: 100, paidDate: '2026-09-20' });

    expect(await paymentDays(invoice.id)).toEqual(['2026-09-20']);
  });
});

describe('a payment date sent with a time and offset', () => {
  /**
   * The day is the one the caller wrote. Goes red if it is read through a UTC
   * instant: 11:30pm Pacific on the 27th is the 28th in UTC.
   */
  it('is stored as the day written', async () => {
    const { firm, owner, client, invoice } = await seedWorld();

    await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ paymentAmount: 100, paidDate: '2026-09-27T23:30:00-07:00' });

    expect(await paymentDays(invoice.id)).toEqual(['2026-09-27']);
  });
});

describe('the receipt for a payment', () => {
  /**
   * Goes red if the receipt shows the day the email went out (in UTC) rather
   * than the day the payment is recorded on.
   */
  it('shows the payment\'s own date', async () => {
    const { firm, owner, client, invoice } = await seedWorld();
    resetEmails();

    await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ paymentAmount: 100, paidDate: '2026-09-20' });
    await drainEvents();

    const receipt = sentEmails().find((e) => /received your payment/i.test(e.text || ''));
    expect(receipt).toBeDefined();
    expect(receipt!.text).toContain('on 2026-09-20');
  });
});
