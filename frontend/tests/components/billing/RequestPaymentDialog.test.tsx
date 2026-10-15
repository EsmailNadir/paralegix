/**
 * The Request Payment via Stripe dialog: one secure link, emailed or copied.
 *
 * Driven through the real billing service with only the transport faked.
 * Red if the dialog emails when the firm chose to copy (or the reverse), if a
 * copied link is not shown and put on the clipboard, if email is offered for
 * an invoice with nobody to email, or if the fee choice does not travel.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RequestPaymentDialog from '@/components/billingComp/RequestPaymentDialog';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';

const api = setupApiMock();
const CONTEXT = { type: 'client' as const, lawFirmId: 'firm-a', entityId: 'client-a' };
const QUOTE_URL = '/api/stripe/payment/firm-a/client/client-a/invoice-a/fee-quote';
const REQUEST_URL = '/api/stripe/payment/firm-a/client/client-a/invoice-a/request';
const LINK = 'https://app.test/pay/tok_copy';

const quote = (emailTo: string[]) => ({
  invoiceCents: 25_000,
  firmDefault: { card: false, bank: false },
  emailTo,
  methods: [
    { method: 'card', paidBy: 'firm', feeCents: 980, clientPaysCents: 25_000, firmReceivesCents: 24_020 },
    { method: 'bank', paidBy: 'firm', feeCents: 425, clientPaysCents: 25_000, firmReceivesCents: 24_575 },
  ],
});

// userEvent.setup() installs its own clipboard, so the spy goes on after it.
let writeText: jest.SpyInstance;
function setupUser() {
  const user = userEvent.setup();
  writeText = jest.spyOn(navigator.clipboard, 'writeText');
  return user;
}

function renderDialog() {
  const onRequested = jest.fn();
  const onClose = jest.fn();
  renderWithProviders(
    <RequestPaymentDialog open onClose={onClose} onRequested={onRequested} billingContext={CONTEXT} invoiceId="invoice-a" />,
  );
  return { onRequested, onClose };
}

it('emails the link by default, to the addresses the server reports', async () => {
  api.getExact(QUOTE_URL, quote(['ap@client.example.test']));
  api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
  const user = setupUser();
  const { onRequested, onClose } = renderDialog();

  expect(await screen.findByText("We'll email it to ap@client.example.test.")).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.calls('POST')[0].body).toEqual({ isCardFeePassedOn: false, isBankFeePassedOn: false, sendEmail: true });
  expect(onRequested).toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
});

it('creates the link without emailing, copies it and shows it, when the firm picks Copy link', async () => {
  api.getExact(QUOTE_URL, quote(['ap@client.example.test']));
  api.postExact(REQUEST_URL, { message: 'Payment link created', paymentUrl: LINK });
  const user = setupUser();
  const { onRequested, onClose } = renderDialog();

  await screen.findByText("We'll email it to ap@client.example.test.");
  await user.click(screen.getByRole('button', { name: 'Copy link' }));
  await user.click(screen.getByRole('button', { name: 'Create & Copy Link' }));

  const ready = await screen.findByRole('dialog', { name: 'Payment link ready' });
  // Breaks if a copy request still emails the client.
  expect(api.calls('POST')[0].body).toEqual({ isCardFeePassedOn: false, isBankFeePassedOn: false, sendEmail: false });
  expect(writeText).toHaveBeenCalledWith(LINK);
  expect(within(ready).getByRole('textbox', { name: 'Payment link' })).toHaveValue(LINK);
  expect(within(ready).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  // The invoice page reloads behind a full-page spinner, which would unmount
  // this dialog and lose the link. So it refreshes only once the firm is done.
  expect(onRequested).not.toHaveBeenCalled();

  await user.click(within(ready).getByRole('button', { name: 'Done' }));

  expect(onClose).toHaveBeenCalled();
  expect(onRequested).toHaveBeenCalledTimes(1);
});

it('offers only Copy link when the invoice has nobody to email', async () => {
  api.getExact(QUOTE_URL, quote([]));
  renderDialog();

  expect(await screen.findByText(/no billing email, so copy the link/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Email it' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create & Copy Link' })).toBeInTheDocument();
});

it('keeps the link on screen to copy by hand when the browser blocks the clipboard', async () => {
  api.getExact(QUOTE_URL, quote([]));
  api.postExact(REQUEST_URL, { message: 'Payment link created', paymentUrl: LINK });
  const user = setupUser();
  writeText.mockRejectedValue(new Error('denied'));
  renderDialog();

  await user.click(await screen.findByRole('button', { name: 'Create & Copy Link' }));

  const ready = await screen.findByRole('dialog', { name: 'Payment link ready' });
  expect(within(ready).getByRole('textbox', { name: 'Payment link' })).toHaveValue(LINK);
  expect(within(ready).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
});

describe('choosing what the link is for, on an invoice with a payment plan', () => {
  const plan = {
    enabled: true,
    installmentAmount: 100,
    frequencyDays: 30,
    planStartDate: '2026-10-01',
    expectedPayments: [
      { id: 'ep-1', dueDate: '2026-10-01', amount: 100, status: 'paid' as const },
      { id: 'ep-2', dueDate: '2026-11-03', amount: 150, status: 'pending' as const },
      { id: 'ep-3', dueDate: '2026-12-03', amount: 175.5, status: 'overdue' as const },
    ],
  };

  function renderPlanDialog(extra: Partial<React.ComponentProps<typeof RequestPaymentDialog>> = {}) {
    const onRequested = jest.fn();
    const onClose = jest.fn();
    renderWithProviders(
      <RequestPaymentDialog
        open
        onClose={onClose}
        onRequested={onRequested}
        billingContext={CONTEXT}
        invoiceId="invoice-a"
        paymentPlan={plan}
        {...extra}
      />,
    );
    return { onRequested, onClose };
  }

  const targetPicker = () => screen.getByRole('button', { name: /What is this link for\?/ });

  it('offers the full balance and each unpaid installment, and sends the chosen one to the quote and the request', async () => {
    api.getExact(QUOTE_URL, quote(['ap@client.example.test']));
    api.getExact(`${QUOTE_URL}?installmentId=ep-3`, { ...quote(['ap@client.example.test']), invoiceCents: 17_550 });
    api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
    const user = setupUser();
    const { onClose } = renderPlanDialog();

    await screen.findByText("We'll email it to ap@client.example.test.");
    expect(targetPicker()).toHaveTextContent('Full remaining balance');
    await user.click(targetPicker());
    // A paid installment cannot be asked for again.
    expect(screen.queryByRole('option', { name: /Installment 1 ·/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Installment 2 · $150.00 · due Nov 3, 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Installment 3 · $175.50 · due Dec 3, 2026' }));

    // Breaks if the quote still prices the whole balance for an installment link.
    await waitFor(() => expect(api.calls('GET').some((call) => call.query.installmentId?.[0] === 'ep-3')).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.calls('POST')[0].body).toEqual({
      isCardFeePassedOn: false, isBankFeePassedOn: false, sendEmail: true, installmentId: 'ep-3',
    });
  });

  it('starts on the installment the caller preselects', async () => {
    api.getExact(`${QUOTE_URL}?installmentId=ep-2`, quote(['ap@client.example.test']));
    api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
    const user = setupUser();
    const { onClose } = renderPlanDialog({ initialInstallmentId: 'ep-2' });

    await screen.findByText("We'll email it to ap@client.example.test.");
    expect(targetPicker()).toHaveTextContent('Installment 2 · $150.00 · due Nov 3, 2026');
    await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.calls('POST')[0].body).toMatchObject({ installmentId: 'ep-2' });
  });

  it('sends no installment when the firm keeps the full balance', async () => {
    api.getExact(QUOTE_URL, quote(['ap@client.example.test']));
    api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
    const user = setupUser();
    const { onClose } = renderPlanDialog();

    await screen.findByText("We'll email it to ap@client.example.test.");
    await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.calls('POST')[0].body).not.toHaveProperty('installmentId');
  });

  it('says a new link replaces the open one', async () => {
    api.getExact(`${QUOTE_URL}?installmentId=ep-3`, quote(['ap@client.example.test']));
    renderPlanDialog({ initialInstallmentId: 'ep-3', hasOpenLink: true });

    expect(await screen.findByText(/replaces the current payment link/)).toBeInTheDocument();
  });

  it('shows no target choice when every installment is paid', async () => {
    api.getExact(QUOTE_URL, quote(['ap@client.example.test']));
    renderPlanDialog({
      paymentPlan: { ...plan, expectedPayments: plan.expectedPayments.map((ep) => ({ ...ep, status: 'paid' as const })) },
    });

    await screen.findByText("We'll email it to ap@client.example.test.");
    expect(screen.queryByRole('button', { name: /What is this link for\?/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/replaces the current payment link/)).not.toBeInTheDocument();
  });
});

it('passes both fees on with the one box for a firm that may pass the card fee on', async () => {
  api.getExact(QUOTE_URL, { ...quote(['ap@client.example.test']), cardFeeEligibility: { eligible: true, reasons: [] } });
  api.getExact(`${QUOTE_URL}?card=true&bank=true`, {
    ...quote(['ap@client.example.test']),
    cardFeeEligibility: { eligible: true, reasons: [] },
    methods: [
      { method: 'card', paidBy: 'client', cardRows: [{ kind: 'us_credit', paidBy: 'client', feeCents: 755, clientPaysCents: 25_755, firmReceivesCents: 25_000 }] },
      { method: 'bank', paidBy: 'client', feeCents: 430, clientPaysCents: 25_430, firmReceivesCents: 25_000 },
    ],
  });
  api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
  const user = setupUser();
  renderDialog();

  await screen.findByText("We'll email it to ap@client.example.test.");
  await user.click(screen.getByRole('checkbox', { name: /^Client pays the processing fee/ }));
  await waitFor(() => expect(screen.getByRole('listitem', { name: 'Credit card' })).toHaveTextContent('Credit card: Client pays the $7.55 fee. You get $250.00.'));
  await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  expect(api.calls('POST')[0].body).toEqual({ isCardFeePassedOn: true, isBankFeePassedOn: true, sendEmail: true });
});

it('passes only the bank fee on for a firm that may not pass the card fee on', async () => {
  const ineligible = { eligible: false, reasons: ['stripe_not_connected'], state: 'TX' };
  api.getExact(QUOTE_URL, { ...quote(['ap@client.example.test']), cardFeeEligibility: ineligible });
  api.getExact(`${QUOTE_URL}?card=false&bank=true`, {
    ...quote(['ap@client.example.test']),
    cardFeeEligibility: ineligible,
    methods: [
      { method: 'card', paidBy: 'firm', feeCents: 980, clientPaysCents: 25_000, firmReceivesCents: 24_020 },
      { method: 'bank', paidBy: 'client', feeCents: 430, clientPaysCents: 25_430, firmReceivesCents: 25_000 },
    ],
  });
  api.postExact(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: LINK });
  const user = setupUser();
  renderDialog();

  await screen.findByText("We'll email it to ap@client.example.test.");
  await user.click(screen.getByRole('checkbox', { name: /^Client pays the processing fee/ }));
  await waitFor(() => expect(screen.getByRole('listitem', { name: 'Bank transfer' })).toHaveTextContent('Bank transfer: Client pays the $4.30 fee. You get $250.00.'));
  await user.click(screen.getByRole('button', { name: 'Email Payment Link' }));

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  // The backend refuses a card fee an ineligible firm asks for.
  expect(api.calls('POST')[0].body).toEqual({ isCardFeePassedOn: false, isBankFeePassedOn: true, sendEmail: true });
});

it('closes itself when the firm follows a link to fix card fees', async () => {
  api.getExact(QUOTE_URL, {
    ...quote(['ap@client.example.test']),
    cardFeeEligibility: { eligible: false, reasons: ['state_missing'], state: null },
  });
  const user = setupUser();
  const { onClose } = renderDialog();

  const link = await screen.findByRole('link', { name: 'Set up card fees' });
  expect(link).toHaveAttribute('href', '/lawfirm/firm-a/settings/payments');
  expect(link.parentElement).toHaveTextContent(/^Applies to bank transfers only\. Set up card fees to include cards\.$/);
  await user.click(link);

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(api.calls('POST')).toHaveLength(0);
});
