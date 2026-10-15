/**
 * Offline contracts for client- and matter-scoped trust ledgers.
 *
 * Parent IDs, tenant scope, server order, and page window are all part of the
 * money record's identity. These tests deliberately keep the real hooks and
 * trust service so a missing path segment or changed paging contract is loud.
 */
jest.unmock('@/services/trust.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientLedger from '@/hooks/trustHooks/useClientLedger';
import useMatterLedger from '@/hooks/trustHooks/useMatterLedger';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const api = setupApiMock();

describe('useClientLedger offline contract', () => {
  it('waits until both firm and client scope are known', async () => {
    const withoutFirm = renderHook(() => useClientLedger(undefined, 'client-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(withoutFirm.result.current.loading).toBe(false));
    expect(withoutFirm.result.current.transactions).toEqual([]);

    const withoutClient = renderHook(() => useClientLedger('firm-a', undefined), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(withoutClient.result.current.loading).toBe(false));
    expect(withoutClient.result.current.transactions).toEqual([]);
    expect(api.calls()).toHaveLength(0);
  });

  it('requests the exact client ledger with newest-first server ordering', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'client-ledger-a' }], totalItems: 26,
    });

    const { result } = renderHook(() => useClientLedger('firm-a', 'client-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-ledger-a']));
    expect(result.current.totalItems).toBe(26);
    expect(result.current.totalPages).toBe(2);
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: '/api/lawfirms/firm-a/trust/clients/client-a/ledger',
      query: { limit: ['25'], offset: ['0'], order: ['desc'] },
    })]);
  });

  it('does not show a late previous-client ledger after a client switch', async () => {
    const heldClientA = holdResponse();
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=25&offset=0&order=desc', heldClientA.handler);
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-b/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'client-ledger-b' }], totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ clientId }) => useClientLedger('firm-a', clientId),
      { initialProps: { clientId: 'client-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.callsTo('/clients/client-a/ledger')).toHaveLength(1));

    rerender({ clientId: 'client-b' });
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-ledger-b']));

    await act(async () => {
      heldClientA.release({ transactions: [{ id: 'client-ledger-a' }], totalItems: 1 });
    });

    expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-ledger-b']);
  });

  it('resets to the first page when the selected client changes', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'client-a-page-one' }], totalItems: 50,
    });
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=25&offset=25&order=desc', {
      transactions: [{ id: 'client-a-page-two' }], totalItems: 50,
    });
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-b/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'client-b-page-one' }], totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ clientId }) => useClientLedger('firm-a', clientId),
      { initialProps: { clientId: 'client-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-a-page-one']));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-a-page-two']));
    expect(result.current.page).toBe(2);

    rerender({ clientId: 'client-b' });

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['client-b-page-one']));
    expect(result.current.page).toBe(1);
    expect(api.calls().filter((call) => call.pathname.includes('/clients/client-b/ledger'))).toEqual([
      expect.objectContaining({ query: { limit: ['25'], offset: ['0'], order: ['desc'] } }),
    ]);
  });
});

describe('useMatterLedger offline contract', () => {
  it('requests the exact matter ledger with newest-first server ordering', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-a/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'matter-ledger-a' }], totalItems: 1,
    });

    const { result } = renderHook(() => useMatterLedger('firm-a', 'matter-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-ledger-a']));
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: '/api/lawfirms/firm-a/trust/matters/matter-a/ledger',
      query: { limit: ['25'], offset: ['0'], order: ['desc'] },
    })]);
  });

  it('does not show a late previous-matter ledger after a matter switch', async () => {
    const heldMatterA = holdResponse();
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-a/ledger?limit=25&offset=0&order=desc', heldMatterA.handler);
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-b/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'matter-ledger-b' }], totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ matterId }) => useMatterLedger('firm-a', matterId),
      { initialProps: { matterId: 'matter-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.callsTo('/matters/matter-a/ledger')).toHaveLength(1));

    rerender({ matterId: 'matter-b' });
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-ledger-b']));

    await act(async () => {
      heldMatterA.release({ transactions: [{ id: 'matter-ledger-a' }], totalItems: 1 });
    });

    expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-ledger-b']);
  });

  it('resets to the first page when the selected matter changes', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-a/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'matter-a-page-one' }], totalItems: 50,
    });
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-a/ledger?limit=25&offset=25&order=desc', {
      transactions: [{ id: 'matter-a-page-two' }], totalItems: 50,
    });
    api.getExact('/api/lawfirms/firm-a/trust/matters/matter-b/ledger?limit=25&offset=0&order=desc', {
      transactions: [{ id: 'matter-b-page-one' }], totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ matterId }) => useMatterLedger('firm-a', matterId),
      { initialProps: { matterId: 'matter-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-a-page-one']));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-a-page-two']));
    expect(result.current.page).toBe(2);

    rerender({ matterId: 'matter-b' });

    await waitFor(() => expect(result.current.transactions.map((transaction) => transaction.id)).toEqual(['matter-b-page-one']));
    expect(result.current.page).toBe(1);
    expect(api.calls().filter((call) => call.pathname.includes('/matters/matter-b/ledger'))).toEqual([
      expect.objectContaining({ query: { limit: ['25'], offset: ['0'], order: ['desc'] } }),
    ]);
  });
});
