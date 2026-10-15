/**
 * The processing-fee choice in the Request Payment via Stripe dialog. One box
 * decides whether the client pays the processing fee: on credit cards and bank
 * transfers for a firm that may pass the card fee on, and on bank transfers
 * alone for a firm that may not. Its description says what that means for debit
 * cards, or why the card fee stays with the firm and where to fix that. Below
 * it, one short line per method says who pays and what reaches the firm.
 *
 * Driven through the real billing service with only the transport faked, so a
 * wrong url, a dropped query flag or a dropped field fails here. Red if the box
 * starts wrong, if ticking it prices or sends a card fee an ineligible firm may
 * not charge, if a reason that sends the firm elsewhere loses its link, or if a
 * breakdown line drifts from the agreed wording.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentRequestFees from '@/components/billingComp/PaymentRequestFees';
import usePaymentRequestFees from '@/hooks/billingHooks/usePaymentRequestFees';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
const CONTEXT = { type: 'client' as const, lawFirmId: 'firm-a', entityId: 'client-a' };
const QUOTE_URL = '/api/stripe/payment/firm-a/client/client-a/invoice-a/fee-quote';
const BOX = /^Client pays the processing fee/;

function Harness({ onNavigate = () => {} }: { onNavigate?: () => void }) {
  const fees = usePaymentRequestFees(CONTEXT, 'invoice-a', true);
  return (
    <>
      <PaymentRequestFees fees={fees} lawFirmId="firm-a" onNavigate={onNavigate} />
      {/* What the dialog would send with the request. */}
      <output aria-label="choice">{JSON.stringify(fees.choice)}</output>
    </>
  );
}

const eligible = { eligible: true, reasons: [] };

const firmPaysBoth = {
  invoiceCents: 12_500_000,
  firmDefault: { card: false, bank: false },
  cardFeeEligibility: eligible,
  methods: [
    { method: 'card', paidBy: 'firm', feeCents: 475_030, clientPaysCents: 12_500_000, firmReceivesCents: 12_024_970 },
    { method: 'bank', paidBy: 'firm', feeCents: 113_000, clientPaysCents: 12_500_000, firmReceivesCents: 12_387_000 },
  ],
};

const clientBank = { method: 'bank', paidBy: 'client', feeCents: 114_300, clientPaysCents: 12_614_300, firmReceivesCents: 12_500_000 };

function clientPaysBoth(debit: Record<string, unknown>) {
  return {
    ...firmPaysBoth,
    methods: [
      {
        method: 'card',
        paidBy: 'client',
        cardRows: [
          { kind: 'us_credit', paidBy: 'client', feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_973 },
          debit,
          { kind: 'non_us_credit', accepted: false },
        ],
      },
      clientBank,
    ],
  };
}

const lines = () => screen.getAllByRole('listitem').map((li) => li.textContent);
const box = () => screen.getByRole('checkbox', { name: BOX });

it('starts unticked from the firm setting and gives one line per method', async () => {
  api.getExact(QUOTE_URL, firmPaysBoth);

  renderWithProviders(<Harness />);

  await waitFor(() => expect(lines()).toEqual([
    'Card: You pay the $4,750.30 fee. You get $120,249.70.',
    'Bank transfer: You pay the $1,130.00 fee. You get $123,870.00.',
  ]));
  expect(screen.getByText('Processing fees')).toBeInTheDocument();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(box()).not.toBeChecked();
  expect(screen.getByLabelText('choice')).toHaveTextContent('{"card":false,"bank":false}');
});

it('passes both fees on for an eligible firm and says debit cards carry none', async () => {
  api.getExact(QUOTE_URL, firmPaysBoth);
  api.getExact(`${QUOTE_URL}?card=true&bank=true`, clientPaysBoth({ kind: 'debit', paidBy: 'firm', feeCents: 1_000, clientPaysCents: 25_000, firmReceivesCents: 24_000 }));
  const user = userEvent.setup();
  renderWithProviders(<Harness />);
  await screen.findByRole('listitem', { name: 'Card' });

  await user.click(box());

  await waitFor(() => expect(lines()).toEqual([
    'Credit card: Client pays the $7.50 fee. You get $249.73.',
    'Debit card: No fee. You pay about $10.00.',
    'Bank transfer: Client pays the $1,143.00 fee. You get $125,000.00.',
  ]));
  expect(box()).toBeChecked();
  expect(screen.getByText('Applies to credit cards and bank transfers. Debit cards never have a fee.')).toBeInTheDocument();
  expect(screen.getByLabelText('choice')).toHaveTextContent('{"card":true,"bank":true}');
});

it('starts ticked for a firm that passes both fees on, and says declined debit cards are refused', async () => {
  api.getExact(QUOTE_URL, {
    ...clientPaysBoth({ kind: 'debit', accepted: false }),
    firmDefault: { card: true, bank: true },
  });

  renderWithProviders(<Harness />);

  await waitFor(() => expect(lines()).toEqual([
    'Credit card: Client pays the $7.50 fee. You get $249.73.',
    'Bank transfer: Client pays the $1,143.00 fee. You get $125,000.00.',
  ]));
  expect(box()).toBeChecked();
  expect(screen.getByText("Applies to credit cards and bank transfers. Debit cards aren't accepted.")).toBeInTheDocument();
  // The firm default already matches the box, so it is priced once.
  expect(api.callsTo('/fee-quote')).toHaveLength(1);
});

it('starts ticked when the firm passes only the bank fee on, and prices both fees', async () => {
  api.getExact(QUOTE_URL, { ...firmPaysBoth, firmDefault: { card: false, bank: true } });
  api.getExact(`${QUOTE_URL}?card=true&bank=true`, clientPaysBoth({ kind: 'debit', accepted: false }));

  renderWithProviders(<Harness />);

  await waitFor(() => expect(screen.getByLabelText('choice')).toHaveTextContent('{"card":true,"bank":true}'));
  expect(box()).toBeChecked();
  await waitFor(() => expect(api.callsTo('/fee-quote')).toHaveLength(2));
  expect(api.callsTo('/fee-quote')[1].query).toEqual({ card: ['true'], bank: ['true'] });
});

describe('a firm that may not pass the card fee on', () => {
  const missingState = { eligible: false, reasons: ['state_missing', 'not_confirmed'], state: null };

  it('passes only the bank fee on, and links to card fee setup', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, cardFeeEligibility: missingState });
    api.getExact(`${QUOTE_URL}?card=false&bank=true`, {
      ...firmPaysBoth,
      cardFeeEligibility: missingState,
      methods: [firmPaysBoth.methods[0], clientBank],
    });
    const onNavigate = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onNavigate={onNavigate} />);
    await screen.findByRole('listitem', { name: 'Card' });

    const link = screen.getByRole('link', { name: 'Set up card fees' });
    expect(link).toHaveAttribute('href', '/lawfirm/firm-a/settings/payments');
    expect(link.parentElement).toHaveTextContent(/^Applies to bank transfers only\. Set up card fees to include cards\.$/);
    expect(box()).toBeEnabled();

    await user.click(box());

    await waitFor(() => expect(lines()).toEqual([
      'Card: You pay the $4,750.30 fee. You get $120,249.70.',
      'Bank transfer: Client pays the $1,143.00 fee. You get $125,000.00.',
    ]));
    expect(screen.getByLabelText('choice')).toHaveTextContent('{"card":false,"bank":true}');

    await user.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('starts unticked when only the card fee was the firm default', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, firmDefault: { card: true, bank: false }, cardFeeEligibility: missingState });
    api.getExact(`${QUOTE_URL}?card=false&bank=false`, { ...firmPaysBoth, cardFeeEligibility: missingState });

    renderWithProviders(<Harness />);

    await waitFor(() => expect(api.callsTo('/fee-quote')).toHaveLength(2));
    expect(box()).not.toBeChecked();
    expect(screen.getByLabelText('choice')).toHaveTextContent('{"card":false,"bank":false}');
  });

  it('links to card fee setup when Stripe is not connected', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, cardFeeEligibility: { eligible: false, reasons: ['stripe_not_connected'], state: 'TX' } });

    renderWithProviders(<Harness />);

    const link = await screen.findByRole('link', { name: 'Set up card fees' });
    expect(link).toHaveAttribute('href', '/lawfirm/firm-a/settings/payments');
    expect(link.parentElement).toHaveTextContent(/^Applies to bank transfers only\. Set up card fees to include cards\.$/);
  });

  it('links to card fee setup when the firm has not confirmed its notice', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, cardFeeEligibility: { eligible: false, reasons: ['not_confirmed'], state: 'TX' } });

    renderWithProviders(<Harness />);

    const link = await screen.findByRole('link', { name: 'Set up card fees' });
    expect(link).toHaveAttribute('href', '/lawfirm/firm-a/settings/payments');
    expect(link.parentElement).toHaveTextContent(/^Applies to bank transfers only\. Set up card fees to include cards\.$/);
  });

  it('links to card fee setup during the notice period', async () => {
    api.getExact(QUOTE_URL, {
      ...firmPaysBoth,
      cardFeeEligibility: { eligible: false, reasons: ['notice_period'], state: 'TX', availableFrom: '2026-10-31' },
    });

    renderWithProviders(<Harness />);

    const link = await screen.findByRole('link', { name: 'Set up card fees' });
    expect(link).toHaveAttribute('href', '/lawfirm/firm-a/settings/payments');
    expect(link.parentElement).toHaveTextContent(/^Applies to bank transfers only\. Set up card fees to include cards\.$/);
  });

  it('says the firm pays the card fee, with no link, in a state that bans it', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, cardFeeEligibility: { eligible: false, reasons: ['state_banned', 'not_confirmed'], state: 'CT' } });

    renderWithProviders(<Harness />);
    await screen.findByRole('listitem', { name: 'Card' });

    expect(screen.getByText("Applies to bank transfers only. Card fees aren't allowed in Connecticut.")).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(box()).toBeEnabled();
  });

  it('has no accessibility violations with the linked reason showing', async () => {
    api.getExact(QUOTE_URL, { ...firmPaysBoth, cardFeeEligibility: missingState });
    const { container } = renderWithProviders(<Harness />);
    await screen.findByRole('link', { name: 'Set up card fees' });

    expect((await scanAccessibility(container)).violations).toEqual([]);
  });
});

it('says the fees could not be loaded instead of showing none', async () => {
  api.getExact(QUOTE_URL, { status: 500, body: { error: 'boom' } });
  api.allowUnhandled();

  renderWithProviders(<Harness />);

  expect(await screen.findByText(/Processing fees could not be loaded/)).toBeInTheDocument();
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  expect(within(document.body).getByRole('checkbox', { name: BOX })).toBeDisabled();
});
