/**
 * A firm's "request payment" and who pays the processing fee.
 *
 * The fee depends on whether the client pays by card or bank transfer, and a
 * hosted Stripe invoice would fix its amount before the client picks. So every
 * whole-invoice request makes a secure pay link instead, whether or not the
 * firm passes a fee on: the client chooses a method on the no-login pay page,
 * and the fee is set on the checkout that choice starts. The request records
 * who pays each fee on the invoice and touches no Stripe object.
 *
 * Stripe is replaced wholesale; any surface a case does not stub throws.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    customers: { create: fn(), retrieve: fn(), update: fn(), list: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), list: fn() },
  };
});

import {
  testPool,
  request,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  emailsMatching,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { portalPerson } from '../clients/portalWorld';

const FIRM_ACCOUNT = 'acct_fee_requests';
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

function stripeSurfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...stripeSurfaces(value, name));
  }
  return out;
}

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  for (const [name, mock] of stripeSurfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  resetEmails();
  firm = await createFirm({ name: 'Fee Requests LLP' });
  owner = await ownerOf(firm.id);
  const connected = await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [firm.id, FIRM_ACCOUNT],
  );
  expect(connected.rowCount).toBe(1);
  await makeEligible(firm.id);
});

/**
 * Make the firm one the card rules allow to pass the credit card fee on: a
 * Texas firm that told Stripe 30 days back and confirmed its engagement
 * letters, optionally with its debit and non-US card choices.
 */
async function makeEligible(lawFirmId: string, cardFees: Record<string, unknown> = {}) {
  const res = await testPool.query(
    `update law_firms
        set state = 'TX',
            settings = jsonb_set(
              jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', coalesce(settings->'billing', '{}'::jsonb), true),
              '{billing,cardFees}', $2::jsonb, true)
      where id = $1`,
    [lawFirmId, JSON.stringify({
      debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
      confirmation: {
        stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
      },
      ...cardFees,
    })],
  );
  expect(res.rowCount).toBe(1);
}

async function setFees(fees: { card?: 'firm' | 'client'; bank?: 'firm' | 'client' }) {
  const res = await testPool.query(
    `update law_firms
        set settings = jsonb_set(
          jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', coalesce(settings->'billing', '{}'::jsonb), true),
          '{billing,processingFees}', $2::jsonb, true)
      where id = $1`,
    [firm.id, JSON.stringify({ card: 'firm', bank: 'firm', ...fees })],
  );
  expect(res.rowCount).toBe(1);
}

/** Names of every Stripe surface that was called. Empty means Stripe was never reached. */
const stripeCalls = () => stripeSurfaces().filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);

async function invoiceStripeState(invoiceId: string) {
  const { rows } = await testPool.query(
    `select stripe_invoice_id, stripe_checkout_session_id, stripe_payment_status, stripe_payment_requested
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The request email is sent without being awaited, so wait for it to land. */
async function requestEmail(subject: RegExp) {
  for (let i = 0; i < 50; i += 1) {
    const [email] = emailsMatching(subject);
    if (email) return email;
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error(`no email matching ${subject}`);
}

/** The invoice's secure payment link token, as the request stored it. */
async function payLinkToken(invoiceId: string): Promise<string | null> {
  const { rows } = await testPool.query('select pay_link_token from invoices where id = $1', [invoiceId]);
  return rows[0].pay_link_token;
}

const requestUrl = (clientId: string, invoiceId: string) =>
  `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`;
const voidUrl = (clientId: string, invoiceId: string) =>
  `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/void`;

describe('requesting payment while the client pays a processing fee', () => {
  it('emails a secure payment link, with no hosted invoice', async () => {
    await setFees({ card: 'client' });
    const payer = await portalPerson(firm.id, 'Pia Portal');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00, invoiceNumber: 'INV-FEE-1' });
    await testPool.query(`update invoices set invoice_name = 'INV-FEE-1' where id = $1`, [invoice.id]);

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(200);
    const token = await payLinkToken(invoice.id);
    // Long and random: the token is the link's only credential.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const paymentUrl = `${FRONTEND_URL}/pay/${token}`;
    expect(res.body).toEqual({ message: 'Payment link emailed', paymentUrl });
    // Breaks if the hosted invoice is still minted: its amount is fixed before
    // the client chooses a method, so the fee could not be charged.
    expect(stripeCalls()).toEqual([]);
    expect(await invoiceStripeState(invoice.id)).toEqual({
      stripe_invoice_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_status: 'pending',
      stripe_payment_requested: true,
    });
    const email = await requestEmail(/Payment Requested: Invoice #INV-FEE-1/);
    expect(email.to).toEqual([payer.email]);
    expect(email.html).toContain(`href="${paymentUrl}"`);
    // The pay link does not expire, so the hosted invoice's 10-day line is wrong here.
    expect(email.text).not.toContain('valid for 10 days');
  });

  it('applies when only the bank fee is passed on', async () => {
    await setFees({ bank: 'client' });
    const payer = await portalPerson(firm.id, 'Bo Bank');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(200);
    expect(res.body.paymentUrl).toBe(`${FRONTEND_URL}/pay/${await payLinkToken(invoice.id)}`);
    expect(stripeCalls()).toEqual([]);
    expect(await feeFlags(invoice.id)).toEqual({ card: false, bank: true });
  });

  it('sends the same secure link to a client nobody can sign in for', async () => {
    await setFees({ card: 'client', bank: 'client' });
    const client = await createPersonClient(firm.id, { email: 'nologin@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(client.id, invoice.id));

    // Breaks if a portal login is required again: this client could never
    // choose a method, and the fee the firm passed on would be dropped.
    expect(res.status).toBe(200);
    expect(res.body.paymentUrl).toBe(`${FRONTEND_URL}/pay/${await payLinkToken(invoice.id)}`);
    expect(fakeStripe().invoices.create).not.toHaveBeenCalled();
    expect(await feeFlags(invoice.id)).toEqual({ card: true, bank: true });
  });

  it('replaces the link on a new request, so an old one stops working', async () => {
    await setFees({ card: 'client' });
    const client = await createPersonClient(firm.id, { email: 'again@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);
    const first = await payLinkToken(invoice.id);

    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);

    const second = await payLinkToken(invoice.id);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('refuses a new request while the client is paying the old link by bank transfer', async () => {
    const client = await createPersonClient(firm.id, { email: 'busy@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);
    const first = await payLinkToken(invoice.id);
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_ach', stripe_checkout_session_account_id = 'platform' where id = $1`,
      [invoice.id],
    );
    // A completed checkout that is not yet paid is an ACH debit still settling.
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_ach', status: 'complete', payment_status: 'unpaid' });

    const res = await owner.api.post(requestUrl(client.id, invoice.id));

    // Breaks if the firm can issue a second link the client could also pay,
    // collecting the balance twice once the first transfer settles.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already paid this request, or a payment is processing/);
    expect(await payLinkToken(invoice.id)).toBe(first);
    expect((await invoiceStripeState(invoice.id)).stripe_checkout_session_id).toBe('cs_ach');
  });

  it('expires the checkout the client opened from the old link before replacing it', async () => {
    const client = await createPersonClient(firm.id, { email: 'open@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);
    const first = await payLinkToken(invoice.id);
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_old', stripe_checkout_session_account_id = 'platform' where id = $1`,
      [invoice.id],
    );
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_old', status: 'open' });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_old', status: 'expired' });

    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);

    // Breaks if the old checkout page stays payable beside the new link.
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_old');
    expect(await payLinkToken(invoice.id)).not.toBe(first);
    expect((await invoiceStripeState(invoice.id)).stripe_checkout_session_id).toBeNull();
  });

  it('sends a pay link, not a hosted Stripe invoice, while the firm pays both fees', async () => {
    const payer = await portalPerson(firm.id, 'Fran Firm');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(200);
    // Breaks if a firm-paid request goes back to a hosted invoice: that path
    // charged the card-rate fee even when the client paid by bank transfer.
    expect(res.body).toEqual({
      message: 'Payment link emailed', paymentUrl: `${FRONTEND_URL}/pay/${await payLinkToken(invoice.id)}`,
    });
    expect(stripeCalls()).toEqual([]);
    expect(await feeFlags(invoice.id)).toEqual({ card: false, bank: false });
  });

  it('creates the link without emailing it when sendEmail is false', async () => {
    const client = await createPersonClient(firm.id, { email: 'copy@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00, invoiceNumber: 'INV-COPY-1' });
    await testPool.query(`update invoices set invoice_name = 'INV-COPY-1' where id = $1`, [invoice.id]);

    const res = await owner.api.post(requestUrl(client.id, invoice.id)).send({ sendEmail: false });

    expect(res.status).toBe(200);
    const paymentUrl = `${FRONTEND_URL}/pay/${await payLinkToken(invoice.id)}`;
    expect(res.body).toEqual({ message: 'Payment link created', paymentUrl });
    expect(stripeCalls()).toEqual([]);
    expect((await invoiceStripeState(invoice.id)).stripe_payment_requested).toBe(true);

    // An emailed request afterwards lands exactly one email, so the copied
    // request sent none. Breaks if sendEmail: false still emails the client.
    await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);
    const emailed = await requestEmail(/Payment Requested: Invoice #INV-COPY-1/);
    expect(emailed.to).toEqual(['copy@example.test']);
    expect(emailsMatching(/Payment Requested: Invoice #INV-COPY-1/)).toHaveLength(1);
  });

  it('creates an unemailed link for a client with no billing email', async () => {
    const client = await createPersonClient(firm.id, { email: null });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    // Emailing needs someone to email, so the default request refuses.
    const emailed = await owner.api.post(requestUrl(client.id, invoice.id));
    expect(emailed.status).toBe(400);
    expect(emailed.body.code).toBe('NO_BILLING_RECIPIENT');
    expect(await payLinkToken(invoice.id)).toBeNull();

    const res = await owner.api.post(requestUrl(client.id, invoice.id)).send({ sendEmail: false });

    // Breaks if recipients are required even when nothing is emailed: the firm
    // could never copy a link for a client it reaches by text.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Payment link created', paymentUrl: `${FRONTEND_URL}/pay/${await payLinkToken(invoice.id)}`,
    });
    expect(stripeCalls()).toEqual([]);
  });

  it('refuses the owner of another firm and records no request', async () => {
    await setFees({ card: 'client' });
    const payer = await portalPerson(firm.id, 'Pia Portal');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.post(requestUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(403);
    expect((await invoiceStripeState(invoice.id)).stripe_payment_requested).toBe(false);
    expect(emailsMatching(/Payment Requested/)).toHaveLength(0);
  });
});

/** Who pays each fee on the invoice, as the request recorded it. */
async function feeFlags(invoiceId: string) {
  const { rows } = await testPool.query(
    'select is_card_fee_passed_on as card, is_bank_fee_passed_on as bank from invoices where id = $1', [invoiceId],
  );
  return rows[0];
}

describe('the choice made in the request dialog', () => {
  it('saves the firm default on the invoice when the dialog sends no choice', async () => {
    await setFees({ card: 'client' });
    const payer = await portalPerson(firm.id, 'Dee Default');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    await owner.api.post(requestUrl(payer.clientId, invoice.id)).expect(200);

    expect(await feeFlags(invoice.id)).toEqual({ card: true, bank: false });
  });

  it('overrides the firm setting for this invoice and saves it', async () => {
    const payer = await portalPerson(firm.id, 'Owen Override');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id))
      .send({ isCardFeePassedOn: false, isBankFeePassedOn: true });

    // The firm setting says the firm pays both; the dialog passed the bank fee on.
    expect(res.status).toBe(200);
    expect(stripeCalls()).toEqual([]);
    expect(await feeFlags(invoice.id)).toEqual({ card: false, bank: true });
  });

  it('lets the firm absorb both fees on one invoice despite the firm setting', async () => {
    await setFees({ card: 'client', bank: 'client' });
    const payer = await portalPerson(firm.id, 'Abby Absorb');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id))
      .send({ isCardFeePassedOn: false, isBankFeePassedOn: false });

    expect(res.status).toBe(200);
    expect(stripeCalls()).toEqual([]);
    expect(await feeFlags(invoice.id)).toEqual({ card: false, bank: false });
  });

  it('passes the fee on for a client nobody can sign in for', async () => {
    const client = await createPersonClient(firm.id, { email: 'nologin@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    await owner.api.post(requestUrl(client.id, invoice.id))
      .send({ isCardFeePassedOn: true, isBankFeePassedOn: true })
      .expect(200);

    expect(await feeFlags(invoice.id)).toEqual({ card: true, bank: true });
  });

  it('rejects a choice that is not true or false', async () => {
    const payer = await portalPerson(firm.id, 'Val Invalid');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(payer.clientId, invoice.id)).send({ isCardFeePassedOn: 'yes' });

    expect(res.status).toBe(400);
    expect((await invoiceStripeState(invoice.id)).stripe_payment_requested).toBe(false);
  });
});

describe('voiding a pay-link payment request', () => {
  async function payLinkRequest() {
    await setFees({ card: 'client' });
    const payer = await portalPerson(firm.id, 'Vic Void');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });
    await owner.api.post(requestUrl(payer.clientId, invoice.id)).expect(200);
    return { clientId: payer.clientId, invoiceId: invoice.id };
  }

  it('clears the request without looking for a hosted invoice', async () => {
    const { clientId, invoiceId } = await payLinkRequest();

    const res = await owner.api.post(voidUrl(clientId, invoiceId));

    // Breaks if void still demands a hosted invoice id: the firm could never
    // withdraw a pay-link request.
    expect(res.status).toBe(200);
    expect(fakeStripe().invoices.retrieve).not.toHaveBeenCalled();
    expect(await invoiceStripeState(invoiceId)).toMatchObject({
      stripe_payment_requested: false,
      stripe_payment_status: 'voided',
    });
    // The link stops working once the firm withdraws the request.
    expect(await payLinkToken(invoiceId)).toBeNull();
  });

  it('expires the checkout session the client already opened', async () => {
    const { clientId, invoiceId } = await payLinkRequest();
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_open', stripe_checkout_session_account_id = 'platform' where id = $1`,
      [invoiceId],
    );
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_open', status: 'open' });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_open', status: 'expired' });

    const res = await owner.api.post(voidUrl(clientId, invoiceId));

    expect(res.status).toBe(200);
    // Breaks if the session survives: the client could finish paying a request
    // the firm withdrew.
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_open');
    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBeNull();
  });

  it.each(['complete', 'expire_failure'])('keeps a request live when checkout is %s', async (scenario) => {
    const { clientId, invoiceId } = await payLinkRequest();
    const token = await payLinkToken(invoiceId);
    await testPool.query("update invoices set stripe_checkout_session_id = 'cs_busy', stripe_checkout_session_account_id = 'platform' where id = $1", [invoiceId]);
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_busy', status: scenario === 'complete' ? 'complete' : 'open', payment_status: 'unpaid' });
    fakeStripe().checkout.sessions.expire.mockRejectedValue(new Error('cannot expire'));
    const res = await owner.api.post(voidUrl(clientId, invoiceId));
    expect(res.status).toBe(scenario === 'complete' ? 400 : 502);
    expect(await invoiceStripeState(invoiceId)).toMatchObject({ stripe_payment_requested: true, stripe_checkout_session_id: 'cs_busy' });
    expect(await payLinkToken(invoiceId)).toBe(token);
  });

});

describe('the fee quote the request dialog shows', () => {
  const quoteUrl = (clientId: string, invoiceId: string) =>
    `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/fee-quote`;

  it('refuses the owner of another firm', async () => {
    const payer = await portalPerson(firm.id, 'Quinn Quote');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.get(quoteUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(403);
    expect(res.body.methods).toBeUndefined();
  });

  it('prices each method by who pays it, and touches no Stripe object', async () => {
    await setFees({ card: 'client', bank: 'firm' });
    const payer = await portalPerson(firm.id, 'Quinn Quote');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.get(quoteUrl(payer.clientId, invoice.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invoiceCents: 25_000,
      firmDefault: { card: true, bank: false },
      cardFeeEligibility: { eligible: true, reasons: [], state: 'TX', capPercent: 3, availableFrom: '2026-08-31' },
      // Who an emailed link would go to, so the dialog can show it.
      emailTo: [payer.email],
      methods: [
        // Per kind of card: the fee depends on the card the client uses.
        {
          method: 'card',
          paidBy: 'client',
          cardRows: [
            { kind: 'us_credit', paidBy: 'client', feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_973 },
            { kind: 'debit', paidBy: 'firm', feeCents: 980, clientPaysCents: 25_000, firmReceivesCents: 24_020 },
            { kind: 'non_us_credit', paidBy: 'client', feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_587 },
          ],
        },
        // min(200, 500) + 225: the firm pays it out of the balance.
        { method: 'bank', paidBy: 'firm', feeCents: 425, clientPaysCents: 25_000, firmReceivesCents: 24_575 },
      ],
    });
    expect(stripeCalls()).toEqual([]);
  });

  it('prices a passed-on fee for a client nobody can sign in for', async () => {
    await setFees({ card: 'client', bank: 'client' });
    const client = await createPersonClient(firm.id, { email: 'nologin@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(quoteUrl(client.id, invoice.id));

    expect(res.status).toBe(200);
    expect(res.body.emailTo).toEqual(['nologin@example.test']);
    expect(res.body.methods.map((m: any) => m.paidBy)).toEqual(['client', 'client']);
  });

  it('prices the firm paying both at each method\'s own cost when nothing is passed on', async () => {
    const client = await createPersonClient(firm.id, { email: 'firmpays@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(quoteUrl(client.id, invoice.id));

    expect(res.status).toBe(200);
    // Breaks if a firm-paid bank transfer is still quoted at the card rate
    // (980), as it was when the request minted a hosted invoice.
    expect(res.body.methods).toEqual([
      { method: 'card', paidBy: 'firm', feeCents: 980, clientPaysCents: 25_000, firmReceivesCents: 24_020 },
      { method: 'bank', paidBy: 'firm', feeCents: 425, clientPaysCents: 25_000, firmReceivesCents: 24_575 },
    ]);
  });

  it('names no recipient for a client with no email on file', async () => {
    const client = await createPersonClient(firm.id, { email: null });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(quoteUrl(client.id, invoice.id));

    // The dialog offers copying the link instead of emailing it. Breaks if the
    // quote refuses, as the emailed request does, or invents an address.
    expect(res.status).toBe(200);
    expect(res.body.emailTo).toEqual([]);
    expect(res.body.invoiceCents).toBe(25_000);
  });

  it('previews the choice ticked in the dialog over the firm setting', async () => {
    const payer = await portalPerson(firm.id, 'Quinn Quote');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });

    const res = await owner.api.get(`${quoteUrl(payer.clientId, invoice.id)}?card=true&bank=false`);

    expect(res.status).toBe(200);
    expect(res.body.methods.map((m: any) => m.paidBy)).toEqual(['client', 'firm']);
    expect(res.body.methods[0].cardRows[0].clientPaysCents).toBe(25_750);
    // The firm default, so the dialog can tick its boxes before the firm changes them.
    expect(res.body.firmDefault).toEqual({ card: false, bank: false });
  });

  it('quotes the balance still owed, not the invoice total', async () => {
    const payer = await portalPerson(firm.id, 'Quinn Quote');
    const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 250_00 });
    await testPool.query('update invoices set amount_paid_cents = 100_00 where id = $1', [invoice.id]);

    const res = await owner.api.get(quoteUrl(payer.clientId, invoice.id));

    expect(res.body.invoiceCents).toBe(15_000);
  });
});


it.each([
  // round(100000 * 0.038) + 30.
  ['card', 3830],
  // min(800, 500) + 900: Stripe's capped ACH fee plus the margin.
  ['bank', 1400],
] as const)('quotes the %s fee the pay-link checkout actually charges a destination-charge firm', async (method, expectedFee) => {
  const client = await createPersonClient(firm.id, { email: 'quoted@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_000 });
  const quote = await owner.api.get(`/api/stripe/payment/${firm.id}/client/${client.id}/${invoice.id}/fee-quote`).expect(200);
  await owner.api.post(requestUrl(client.id, invoice.id)).expect(200);

  fakeStripe().customers.create.mockResolvedValue({ id: 'cus_quoted' });
  fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_quoted', url: 'https://checkout.stripe.test/cs_quoted' });
  const token = await payLinkToken(invoice.id);
  await request().post(`/api/pay/${token}/checkout`).send({ method }).expect(200);

  // Breaks if the quote and the checkout price the same method differently:
  // the firm would be shown one net amount and receive another.
  const chargedFee = fakeStripe().checkout.sessions.create.mock.calls[0][0].payment_intent_data.application_fee_amount;
  expect(chargedFee).toBe(expectedFee);
  expect(quote.body.methods.find((m: any) => m.method === method)).toEqual({
    method, paidBy: 'firm', feeCents: chargedFee, clientPaysCents: 100000, firmReceivesCents: 100000 - chargedFee,
  });
});


it.each(['complete', 'expire_failure'])('does not replace a payment request whose checkout is %s', async (scenario) => {
  const client = await createPersonClient(firm.id, { email: 'replace-busy@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 25000 });
  await owner.api.post(requestUrl(client.id, invoice.id)).send({ isCardFeePassedOn: true }).expect(200);
  const token = await payLinkToken(invoice.id);
  await testPool.query("update invoices set stripe_checkout_session_id = 'cs_busy', stripe_checkout_session_account_id = 'platform' where id = $1", [invoice.id]);
  fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_busy', status: scenario === 'complete' ? 'complete' : 'open', payment_status: 'unpaid' });
  fakeStripe().checkout.sessions.expire.mockRejectedValue(new Error('temporary Stripe failure'));
  const res = await owner.api.post(requestUrl(client.id, invoice.id)).send({ isCardFeePassedOn: true });
  expect(res.status).toBe(scenario === 'complete' ? 400 : 502);
  expect(await payLinkToken(invoice.id)).toBe(token);
  expect((await invoiceStripeState(invoice.id)).stripe_checkout_session_id).toBe('cs_busy');
});


it.each(['checkout', 'hosted'])('allows requesting the unpaid balance after a recorded %s payment is refunded', async (surface) => {
  const client = await createPersonClient(firm.id, { email: 'refunded@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 25000 });
  await testPool.query(`insert into invoice_payments (invoice_id, law_firm_id, amount_cents, stripe_refunded_cents, stripe_session_id, stripe_invoice_id, stripe_payment_intent_id)
    values ($1, $2, 15000, 10000, $3, $4, 'pi_refunded')`, [invoice.id, firm.id, surface === 'checkout' ? 'cs_refunded' : null, surface === 'hosted' ? 'in_refunded' : null]);
  await testPool.query(`update invoices set amount_paid_cents = 15000, is_paid = false, stripe_payment_requested = true,
    stripe_checkout_session_id = $2, stripe_invoice_id = $3, stripe_payment_status = 'completed' where id = $1`,
    [invoice.id, surface === 'checkout' ? 'cs_refunded' : null, surface === 'hosted' ? 'in_refunded' : null]);
  if (surface === 'checkout') fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_refunded', status: 'complete', payment_status: 'paid', payment_intent: 'pi_refunded' });
  else fakeStripe().invoices.retrieve.mockResolvedValue({ id: 'in_refunded', status: 'paid' });
  const res = await owner.api.post(requestUrl(client.id, invoice.id)).send({ isCardFeePassedOn: true });
  expect(res.status).toBe(200);
  expect(await payLinkToken(invoice.id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The invoice-level stripe_invoice_id is no longer read or written by a
  // whole-invoice request, so only the checkout pointer is cleared here.
  expect(await invoiceStripeState(invoice.id)).toMatchObject({ stripe_checkout_session_id: null, stripe_payment_requested: true });
});


describe('a firm the card rules do not allow to pass the card fee on', () => {
  const quoteUrl = (clientId: string, invoiceId: string) =>
    `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/fee-quote`;

  it('refuses a request that passes the card fee on and records nothing', async () => {
    await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
    const client = await createPersonClient(firm.id, { email: 'ct@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(client.id, invoice.id)).send({ isCardFeePassedOn: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Card fees aren't allowed in Connecticut.");
    expect(await payLinkToken(invoice.id)).toBeNull();
    expect((await invoiceStripeState(invoice.id)).stripe_payment_requested).toBe(false);
  });

  it('drops the card fee default for a firm that may not use it, instead of failing the request', async () => {
    await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
    await setFees({ card: 'client', bank: 'client' });
    const client = await createPersonClient(firm.id, { email: 'ct-default@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.post(requestUrl(client.id, invoice.id));

    expect(res.status).toBe(200);
    expect(await feeFlags(invoice.id)).toEqual({ card: false, bank: true });
  });

  it('quotes the firm paying the card fee and reports why, without failing the preview', async () => {
    await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
    await setFees({ card: 'client' });
    const client = await createPersonClient(firm.id, { email: 'ct-quote@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(`${quoteUrl(client.id, invoice.id)}?card=true`);

    expect(res.status).toBe(200);
    expect(res.body.firmDefault).toEqual({ card: false, bank: false });
    expect(res.body.cardFeeEligibility).toEqual({
      eligible: false, reasons: ['state_banned'], state: 'CT', capPercent: 0, availableFrom: '2026-08-31',
    });
    expect(res.body.methods[0]).toEqual(
      { method: 'card', paidBy: 'firm', feeCents: 980, clientPaysCents: 25_000, firmReceivesCents: 24_020 },
    );
  });
});

describe('the card rows the request dialog shows for a passed-on card fee', () => {
  const quoteUrl = (clientId: string, invoiceId: string) =>
    `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/fee-quote`;

  it('quotes credit, debit and non-US card rows for an eligible firm', async () => {
    await makeEligible(firm.id, { debitCards: 'decline', internationalCards: 'absorb' });
    await setFees({ card: 'client' });
    const client = await createPersonClient(firm.id, { email: 'rows@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(quoteUrl(client.id, invoice.id));

    expect(res.status).toBe(200);
    expect(res.body.cardFeeEligibility).toEqual({
      eligible: true, reasons: [], state: 'TX', capPercent: 3, availableFrom: '2026-08-31',
    });
    const card = res.body.methods.find((m: any) => m.method === 'card');
    expect(card).toEqual({
      method: 'card',
      paidBy: 'client',
      cardRows: [
        // 3% cap: 750. Stripe 2.9% of 25,750 is 746.75, so 747 + 30 = 777 comes off.
        { kind: 'us_credit', paidBy: 'client', feeCents: 7_50, clientPaysCents: 257_50, firmReceivesCents: 249_73 },
        { kind: 'debit', accepted: false },
        // Stripe 4.4% of 25,750 is 1,133 + 30 = 1,163.
        { kind: 'non_us_credit', paidBy: 'client', feeCents: 7_50, clientPaysCents: 257_50, firmReceivesCents: 245_87 },
      ],
    });
    expect(stripeCalls()).toEqual([]);
  });

  it('prices an absorbed debit card at Stripe plus the Paralegix margin', async () => {
    await makeEligible(firm.id, { debitCards: 'absorb', internationalCards: 'decline' });
    const client = await createPersonClient(firm.id, { email: 'rows-debit@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(`${quoteUrl(client.id, invoice.id)}?card=true`);

    const card = res.body.methods.find((m: any) => m.method === 'card');
    expect(card.cardRows.slice(1)).toEqual([
      // 725 + 30 to Stripe, 225 (0.9%) to Paralegix.
      { kind: 'debit', paidBy: 'firm', feeCents: 9_80, clientPaysCents: 250_00, firmReceivesCents: 240_20 },
      { kind: 'non_us_credit', accepted: false },
    ]);
  });

  it('caps the credit card fee at 2% for a Colorado firm', async () => {
    await testPool.query(`update law_firms set state = 'Colorado' where id = $1`, [firm.id]);
    const client = await createPersonClient(firm.id, { email: 'rows-co@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const res = await owner.api.get(`${quoteUrl(client.id, invoice.id)}?card=true`);

    const card = res.body.methods.find((m: any) => m.method === 'card');
    expect(card.cardRows[0]).toMatchObject({ kind: 'us_credit', feeCents: 5_00, clientPaysCents: 255_00 });
  });
});
