/**
 * The portal's card-or-bank chooser. The client must see what each method
 * costs, fee included, before Stripe opens, because a fee the firm passes on
 * is only added at checkout.
 *
 * Red if a fee or a total is missing or wrong, if choosing a method reports the
 * other one, or if a choice can be made twice while the first is starting.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentMethodDialog from '@/components/portalComp/PaymentMethodDialog';
import type { PaymentOptions } from '@/services/client-portal.service';
import { scanAccessibility } from '../../support/accessibility';

jest.mock('@stripe/react-stripe-js', () => {
  const ReactLib = require('react');
  return {
    Elements: ({ children }: { children: React.ReactNode }) => ReactLib.createElement(ReactLib.Fragment, null, children),
    PaymentElement: () => ReactLib.createElement('div', { 'data-testid': 'payment-element' }),
    useStripe: () => ({ createConfirmationToken: jest.fn(), handleNextAction: jest.fn() }),
    useElements: () => ({ submit: jest.fn() }),
  };
});
jest.mock('@/lib/payments/stripeClient', () => ({ stripeForAccount: () => Promise.resolve({ fake: 'stripe' }) }));

const OPTIONS: PaymentOptions = {
  invoiceCents: 38_000,
  methods: [
    { method: 'card', feeCents: 1_532, totalCents: 39_532 },
    { method: 'bank', feeCents: 0, totalCents: 38_000 },
  ],
  card: { flow: 'checkout' },
};

function renderDialog(props: Partial<React.ComponentProps<typeof PaymentMethodDialog>> = {}) {
  const onChoose = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <PaymentMethodDialog open options={OPTIONS} choosing={null} onChoose={onChoose} onClose={onClose} {...props} />,
  );
  return { ...utils, onChoose, onClose };
}

it('shows each method with its fee and what the client pays', () => {
  renderDialog();

  const card = screen.getByRole('button', { name: /Card/ });
  expect(card).toHaveTextContent('+ $15.32 processing fee');
  expect(card).toHaveTextContent('You pay $395.32');
  const bank = screen.getByRole('button', { name: /Bank transfer/ });
  expect(bank).toHaveTextContent('No fee');
  expect(bank).toHaveTextContent('You pay $380.00');
});

it('reports the method the client chose', async () => {
  const { onChoose } = renderDialog();

  await userEvent.click(screen.getByRole('button', { name: /Bank transfer/ }));

  expect(onChoose).toHaveBeenCalledWith('bank');
});

it('locks both choices while one is starting', async () => {
  const { onChoose } = renderDialog({ choosing: 'card' });

  await userEvent.click(screen.getByRole('button', { name: /Bank transfer/ }));

  expect(onChoose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Card/ })).toBeDisabled();
});

it('has no accessibility violations', async () => {
  const { baseElement } = renderDialog();
  expect((await scanAccessibility(baseElement)).violations).toEqual([]);
});

describe('an invoice whose card fee the client pays', () => {
  const CARD_FORM_OPTIONS: PaymentOptions = {
    invoiceCents: 38_000,
    methods: [
      { method: 'card', feeCents: 0, totalCents: 38_000 },
      { method: 'bank', feeCents: 0, totalCents: 38_000 },
    ],
    card: { flow: 'card_form', stripeAccountId: 'acct_card', creditFeeCents: 11_40, debitCards: 'decline', internationalCards: 'decline' },
  };
  const cardForm = (onBack = jest.fn()) => ({
    open: false,
    api: { quote: jest.fn(), confirm: jest.fn(), complete: jest.fn() },
    onPaid: jest.fn(),
    onBack,
  });

  it('says what a credit card adds instead of a card total', () => {
    renderDialog({ options: CARD_FORM_OPTIONS, cardForm: cardForm() });

    const card = screen.getByRole('button', { name: /Card/ });
    expect(card).toHaveTextContent('Credit cards only, plus a $11.40 fee. US cards only.');
    expect(card).not.toHaveTextContent('You pay');
  });

  it('shows the card form in place of the choice once card is chosen', async () => {
    const onBack = jest.fn();
    const { onChoose } = renderDialog({ options: CARD_FORM_OPTIONS, cardForm: { ...cardForm(onBack), open: true } });

    expect(await screen.findByRole('button', { name: 'Check card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bank transfer/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('has no accessibility violations with the card form open', async () => {
    const { baseElement } = renderDialog({ options: CARD_FORM_OPTIONS, cardForm: { ...cardForm(), open: true } });
    await screen.findByRole('button', { name: 'Check card' });
    expect((await scanAccessibility(baseElement)).violations).toEqual([]);
  });
});
