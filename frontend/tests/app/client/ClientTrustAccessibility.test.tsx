jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen, within } from '@testing-library/react';
import Trust from '@/app/client/lawfirm/[lawFirmId]/trust/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
const api = setupApiMock();
it('groups real trust entries while preserving cents, transaction types, voids, and record scope', async () => {
  api.get('/trust/balance', { clientId: 'record-a', totalBalanceCents: 125000, accountBalances: [] });
  api.get('/trust/ledger', { transactions: [
    { id: 'txn-a', type: 'deposit', amountCents: 150000, date: '2026-10-03', description: 'Retainer deposit', status: 'posted', clientBalanceAfter: 150000 },
    { id: 'txn-b', type: 'withdrawal', amountCents: 25000, date: '2026-10-04', description: 'Invoice payment', status: 'posted', clientBalanceAfter: 125000 },
    { id: 'txn-c', type: 'withdrawal', amountCents: 9900, date: '2026-10-04', description: 'Reversed payment', status: 'void', clientBalanceAfter: 115100 },
  ], totalItems: 3 });
  renderWithProviders(<Trust />);
  const entries = await screen.findByRole('list', { name: 'Trust transactions' });
  const rows = within(entries).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('DepositRetainer deposit');
  expect(rows[0]).toHaveTextContent('+$1,500.00');
  expect(rows[1]).toHaveTextContent('WithdrawalInvoice payment');
  expect(rows[1]).toHaveTextContent('-$250.00');
  expect(rows[1]).toHaveTextContent('Balance: $1,250.00');
  expect(rows[2]).toHaveTextContent('Voided');
  expect(rows[2]).not.toHaveTextContent('Balance:');
  expect(api.callsTo('/trust/balance')[0].url).toContain('clientRecordId=record-a');
  expect(api.callsTo('/trust/ledger')[0].url).toContain('clientRecordId=record-a');
});
