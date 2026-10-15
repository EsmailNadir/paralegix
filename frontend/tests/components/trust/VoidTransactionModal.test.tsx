/**
 * TransactionList renders ONE VoidTransactionModal and points it at whichever
 * row's Void was clicked. The reason is the only thing a void records about why
 * money moved back, so it must never carry from one transaction to the next.
 *
 * Red if the reason is left out of the after-close reset: the second void would
 * open with the first transaction's reason typed in and the confirm already
 * enabled, so one click records the wrong explanation on the ledger.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import VoidTransactionModal from '@/components/trustComp/VoidTransactionModal';
import type { TrustTransaction } from '@/types/trust';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

const FIRM = 'firm-1';

function txn(id: string, overrides: Partial<TrustTransaction> = {}): TrustTransaction {
  return {
    id,
    trustAccountId: 'acct-1',
    type: 'deposit',
    amountCents: 125050,
    clientId: 'cl-1',
    clientName: 'Dana Client',
    date: '2026-03-14',
    description: 'Retainer',
    referenceNumber: '',
    status: 'completed',
    clientBalanceAfter: 125050,
    accountBalanceAfter: 125050,
    createdBy: 'user-1',
    createdAt: '2026-03-14T10:00:00.000Z',
    updatedAt: '2026-03-14T10:00:00.000Z',
    ...overrides,
  } as TrustTransaction;
}

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
});
afterEach(() => api.restore());

/** Let the close animation and the deferred reset run. */
async function waitOutClose() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

describe('VoidTransactionModal', () => {
  it('sends the typed reason, then opens empty for the next transaction', async () => {
    api.patch(`/trust/transactions/t-1/void`, { transaction: { id: 't-1' } });
    const onClose = jest.fn();
    const onVoided = jest.fn();
    const { rerender } = renderWithProviders(
      <VoidTransactionModal open lawFirmId={FIRM} transaction={txn('t-1')} onClose={onClose} onVoided={onVoided} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Void Transaction' });
    expect(within(dialog).getByText('Reason for Voiding *')).toHaveAttribute('class', 'mb-1 block text-xs font-medium text-on-surface-secondary');
    expect(within(dialog).getByText('Deposit: $1,250.50')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Reason for Voiding/), 'Duplicate entry');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void Transaction' }));

    await waitFor(() => expect(onVoided).toHaveBeenCalledTimes(1));
    const posts = api.calls('PATCH').filter((c) => c.pathname.endsWith('/transactions/t-1/void'));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ voidReason: 'Duplicate entry' });

    rerender(
      <VoidTransactionModal open={false} lawFirmId={FIRM} transaction={txn('t-1')} onClose={onClose} onVoided={onVoided} />,
    );
    await waitOutClose();
    rerender(
      <VoidTransactionModal open lawFirmId={FIRM} transaction={txn('t-2', { amountCents: 5000 })} onClose={onClose} onVoided={onVoided} />,
    );

    const next = screen.getByRole('dialog', { name: 'Void Transaction' });
    expect(within(next).getByText('Deposit: $50.00')).toBeInTheDocument();
    expect(within(next).getByLabelText(/Reason for Voiding/)).toHaveValue('');
    expect(within(next).getByRole('button', { name: 'Void Transaction' })).toBeDisabled();
  });

  it("keeps the dialog and the server's reason when the void is refused", async () => {
    api.patch(`/trust/transactions/t-1/void`, {
      status: 409,
      body: { error: 'Funds from this deposit were already disbursed' },
    });
    const onVoided = jest.fn();
    renderWithProviders(
      <VoidTransactionModal open lawFirmId={FIRM} transaction={txn('t-1')} onClose={jest.fn()} onVoided={onVoided} />,
    );

    fireEvent.change(screen.getByLabelText(/Reason for Voiding/), { target: { value: 'Bounced' } });
    await userEvent.click(screen.getByRole('button', { name: 'Void Transaction' }));

    expect(await screen.findByText('Funds from this deposit were already disbursed')).toBeInTheDocument();
    expect(onVoided).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Reason for Voiding/)).toHaveValue('Bounced');
  });
});
