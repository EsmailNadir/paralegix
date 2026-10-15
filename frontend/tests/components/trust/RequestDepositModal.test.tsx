/**
 * Requesting an electronic trust deposit, through the real billing service
 * against a fake transport.
 *
 * A typed dollar amount goes out as exact integer cents.
 *
 * The dialog also cannot be dismissed while the link is being created. Red if
 * it can: the link would then land in a closed dialog after its reset had run,
 * and the next "Request deposit" would open on the previous client's link.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RequestDepositModal from '@/components/trustComp/RequestDepositModal';
import type { TrustAccount } from '@/types/trust';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  default: function MockEntityPicker(props: any) {
    return (
      <select
        aria-label={props.label || `${props.entity} picker`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">Select</option>
        <option value="cl-1">Dana Client</option>
      </select>
    );
  },
}));

const FIRM = 'firm-1';
const ACCOUNT = {
  id: 'acct-1',
  name: 'IOLTA',
  status: 'active',
  stripeChargesEnabled: true,
} as TrustAccount;

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
});
afterEach(() => api.restore());

function depositPosts() {
  return api.calls('POST').filter((c) => c.pathname.endsWith(`/stripe/trust/${FIRM}/request-deposit`));
}

async function fillForm(amount: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Client *' }), { target: { value: 'cl-1' } });
  fireEvent.change(screen.getByLabelText('Amount ($) *'), { target: { value: amount } });
}

describe('RequestDepositModal amount', () => {
  it('sends a cents amount as exact integer cents', async () => {
    api.post(`/stripe/trust/${FIRM}/request-deposit`, { checkoutUrl: 'https://pay.example/abc', sessionId: 's-1' });
    renderWithProviders(<RequestDepositModal open lawFirmId={FIRM} accounts={[ACCOUNT]} onClose={jest.fn()} />);

    await fillForm('1250.29');
    await userEvent.click(screen.getByRole('button', { name: 'Email Deposit Link' }));

    expect(await screen.findByDisplayValue('https://pay.example/abc')).toBeInTheDocument();
    expect(depositPosts()).toHaveLength(1);
    expect(depositPosts()[0].body).toEqual({ trustAccountId: 'acct-1', clientId: 'cl-1', amountCents: 125029, sendEmail: true });
  });
});

describe('RequestDepositModal refuses an amount that is not plain money', () => {
  // Red if the amount goes back to parseFloat: "1e3" would become a $1,000
  // payment link and a third decimal would be rounded away instead of refused.
  // Submitted directly so the handler, not the input's step attribute, is
  // what refuses it.
  it.each([
    ['10.006', 'Amounts can have at most two decimal places.'],
    ['1e3', 'Enter the amount as a plain number, for example 1000.50.'],
    ['0', 'Enter an amount greater than zero.'],
    ['1000000000.01', 'Enter an amount of $1,000,000,000 or less.'],
  ])('refuses %s with its reason and requests no link', async (amount, message) => {
    api.post(`/stripe/trust/${FIRM}/request-deposit`, { checkoutUrl: 'https://pay.example/abc', sessionId: 's-1' });
    renderWithProviders(<RequestDepositModal open lawFirmId={FIRM} accounts={[ACCOUNT]} onClose={jest.fn()} />);

    await fillForm(amount);
    fireEvent.submit(screen.getByRole('button', { name: 'Email Deposit Link' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(depositPosts()).toHaveLength(0);
  });
});

describe('RequestDepositModal while the link is being created', () => {
  it('cannot be cancelled or escaped', async () => {
    api.post(`/stripe/trust/${FIRM}/request-deposit`, {
      delayMs: 5000,
      body: { checkoutUrl: 'https://pay.example/late', sessionId: 's-2' },
    });
    api.allowUnhandled();
    const onClose = jest.fn();
    renderWithProviders(<RequestDepositModal open lawFirmId={FIRM} accounts={[ACCOUNT]} onClose={onClose} />);

    await fillForm('100');
    await userEvent.click(screen.getByRole('button', { name: 'Email Deposit Link' }));
    await waitFor(() => expect(depositPosts()).toHaveLength(1));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('RequestDepositModal delivery', () => {
  it('says where an emailed link went', async () => {
    api.post(`/stripe/trust/${FIRM}/request-deposit`, {
      checkoutUrl: 'https://pay.example/emailed', sessionId: 's-3', emailedTo: 'dana@example.test',
    });
    renderWithProviders(<RequestDepositModal open lawFirmId={FIRM} accounts={[ACCOUNT]} onClose={jest.fn()} />);

    await fillForm('100');
    await userEvent.click(screen.getByRole('button', { name: 'Email Deposit Link' }));

    expect(await screen.findByText('Deposit link emailed to dana@example.test.')).toBeInTheDocument();
  });

  it('creates and copies the link without emailing when the firm picks Copy link', async () => {
    api.post(`/stripe/trust/${FIRM}/request-deposit`, {
      checkoutUrl: 'https://pay.example/copied', sessionId: 's-4', emailedTo: null,
    });
    // userEvent.setup() installs its own clipboard, so the spy goes on after it.
    const user = userEvent.setup();
    const writeText = jest.spyOn(navigator.clipboard, 'writeText');
    renderWithProviders(<RequestDepositModal open lawFirmId={FIRM} accounts={[ACCOUNT]} onClose={jest.fn()} />);

    await fillForm('100');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await user.click(screen.getByRole('button', { name: 'Create & Copy Link' }));

    expect(await screen.findByText('Deposit link created and copied.')).toBeInTheDocument();
    // Breaks if a copy request still emails the client.
    expect(depositPosts()[0].body).toEqual({ trustAccountId: 'acct-1', clientId: 'cl-1', amountCents: 10000, sendEmail: false });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://pay.example/copied'));
  });
});
