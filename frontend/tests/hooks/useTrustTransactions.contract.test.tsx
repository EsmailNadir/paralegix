/**
 * Offline contracts for the paged trust ledger.
 *
 * The existing live spec is intentionally retained, but is excluded from the
 * ordinary unit command. This suite exercises the real hook and trust service
 * against the transport fake, so scope, filter, page-window, error, and firm
 * transition behavior run without a backend or Firebase token.
 */
jest.unmock('@/services/trust.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useTrustTransactions from '@/hooks/trustHooks/useTrustTransactions';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useTrustTransactions offline contract', () => {
  it('does not request a ledger before a firm scope exists', async () => {
    const { result } = renderHook(() => useTrustTransactions(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toHaveLength(0);
  });

  it('sends the selected account/type filters and first page window to the exact firm endpoint', async () => {
    api.getExact(
      '/api/lawfirms/firm-a/trust/transactions?trustAccountId=account-a&type=deposit&limit=10&offset=0',
      { transactions: [{ id: 'deposit-a' }], totalItems: 1 },
    );

    const { result } = renderHook(
      () => useTrustTransactions('firm-a', { trustAccountId: 'account-a', type: 'deposit' }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['deposit-a']));
    expect(result.current.totalItems).toBe(1);
    expect(result.current.page).toBe(1);
    expect(result.current.listParams).toEqual({ trustAccountId: 'account-a', type: 'deposit' });
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: '/api/lawfirms/firm-a/trust/transactions',
      query: {
        trustAccountId: ['account-a'],
        type: ['deposit'],
        limit: ['10'],
        offset: ['0'],
      },
    })]);
  });

  it('reports a failed ledger load rather than presenting zero transactions as success', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', {
      status: 503,
      body: { error: 'Ledger temporarily unavailable' },
    });

    const { result } = renderHook(() => useTrustTransactions('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/Ledger temporarily unavailable/i));
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
  });

  it('recovers a failed first ledger page on refresh', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', {
      status: 503,
      body: { error: 'Ledger temporarily unavailable' },
    });

    const { result } = renderHook(() => useTrustTransactions('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toMatch(/Ledger temporarily unavailable/i));

    api.getExact('/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', {
      transactions: [{ id: 'recovered-transaction' }], totalItems: 1,
    });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id))
      .toEqual(['recovered-transaction']));
    expect(result.current.totalItems).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('resets to the first page and rebuilds the exact request when filters change', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', {
      transactions: [{ id: 'page-one' }], totalItems: 20,
    });
    api.getExact('/api/lawfirms/firm-a/trust/transactions?limit=10&offset=10', {
      transactions: [{ id: 'page-two' }], totalItems: 20,
    });
    api.getExact('/api/lawfirms/firm-a/trust/transactions?type=withdrawal&limit=10&offset=0', {
      transactions: [{ id: 'withdrawal-one' }], totalItems: 1,
    });

    const { result } = renderHook(() => useTrustTransactions('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['page-one']));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['page-two']));
    expect(result.current.page).toBe(2);

    act(() => result.current.setFilters({ type: 'withdrawal' }));
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['withdrawal-one']));

    expect(result.current.page).toBe(1);
    expect(result.current.filters).toEqual({ type: 'withdrawal' });
    expect(api.calls().at(-1)).toEqual(expect.objectContaining({
      pathname: '/api/lawfirms/firm-a/trust/transactions',
      query: { type: ['withdrawal'], limit: ['10'], offset: ['0'] },
    }));
  });

  itKeepsScopeIsolated({
    title: 'keeps firm B transactions visible when firm A resolves after the switch',
    mode: 'late',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useTrustTransactions(lawFirmId),
    ids: (r) => r.transactions.map((transaction) => transaction.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', body: { transactions: [{ id: 'transaction-a' }], totalItems: 1 }, ids: ['transaction-a'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/api/lawfirms/firm-b/trust/transactions?limit=10&offset=0', body: { transactions: [{ id: 'transaction-b' }], totalItems: 1 }, ids: ['transaction-b'] },
    finally: (result) => {
      expect(result.totalItems).toBe(1);
      expect(result.error).toBeNull();
    },
  });

  // Unlike the previous case (firm A still PENDING at the moment of the switch,
  // so `keepPreviousData` has nothing successful to hand over yet), this puts
  // firm A's request through to a real success BEFORE switching to firm B.
  // That is the shape of the cross-tenant leak already found and fixed in
  // `useTasks`/`useClients`/`useClientLedger`/`useMatterLedger`: bare
  // `placeholderData: keepPreviousData` hands the observer firm A's last
  // successful result under firm B's identity for as long as firm B's request
  // is in flight.
  itKeepsScopeIsolated({
    title: 'does not show firm A transactions as firm B rows after firm A already resolved',
    mode: 'pending',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useTrustTransactions(lawFirmId),
    ids: (r) => r.transactions.map((transaction) => transaction.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/api/lawfirms/firm-a/trust/transactions?limit=10&offset=0', body: { transactions: [{ id: 'firm-a-txn' }], totalItems: 1 }, ids: ['firm-a-txn'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/api/lawfirms/firm-b/trust/transactions?limit=10&offset=0', body: { transactions: [{ id: 'firm-b-txn' }], totalItems: 1 }, ids: ['firm-b-txn'] },
    finally: (result) => {
      expect(result.totalItems).toBe(1);
    },
  });
});
