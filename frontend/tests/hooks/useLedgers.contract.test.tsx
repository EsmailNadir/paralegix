/**
 * Offline contract coverage for client and matter paged trust ledgers
 * (`useClientLedger`, `useMatterLedger`).
 *
 * Both hooks delegate to `usePagedTrustLedger` with their respective scopes.
 * This shared suite verifies scope gating, paging window advances, observable
 * pending page state, empty success, failure/recovery, scope isolation,
 * page-size changes, and firm-switch resets.
 */
jest.unmock('@/services/trust.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientLedger from '@/hooks/trustHooks/useClientLedger';
import useMatterLedger from '@/hooks/trustHooks/useMatterLedger';
import type { PagedTrustLedger, UsePagedTrustLedgerOptions } from '@/hooks/trustHooks/usePagedTrustLedger';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

interface LedgerAdapter {
  name: string;
  parent: 'client' | 'matter';
  useHook: (lawFirmId?: string, parentId?: string, options?: UsePagedTrustLedgerOptions) => PagedTrustLedger;
  errorFallbackPattern: RegExp;
}

const LEDGERS: LedgerAdapter[] = [
  {
    name: 'useClientLedger',
    parent: 'client',
    useHook: (lawFirmId, parentId, options) => useClientLedger(lawFirmId, parentId, options),
    errorFallbackPattern: /Ledger temporarily unavailable|Failed to load client ledger/i,
  },
  {
    name: 'useMatterLedger',
    parent: 'matter',
    useHook: (lawFirmId, parentId, options) => useMatterLedger(lawFirmId, parentId, options),
    errorFallbackPattern: /Ledger temporarily unavailable|Failed to load matter ledger/i,
  },
];

describe.each(LEDGERS)('$name offline contract', ({ parent, useHook, errorFallbackPattern }) => {
  const url = (parentId: string, offset = 0) =>
    `/api/lawfirms/firm-a/trust/${parent}s/${parentId}/ledger?limit=25&offset=${offset}&order=desc`;

  it(`waits for both firm and ${parent} scope before requesting a ledger`, async () => {
    const { result, rerender } = renderHook(
      ({ lawFirmId, parentId }: { lawFirmId?: string; parentId?: string }) => useHook(lawFirmId, parentId),
      {
        wrapper: createQueryWrapper(),
        initialProps: { lawFirmId: undefined, parentId: undefined } as { lawFirmId?: string; parentId?: string },
      },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
    expect(api.calls()).toHaveLength(0);

    rerender({ lawFirmId: 'firm-a', parentId: undefined });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('requests the exact first page window, newest first', async () => {
    api.getExact(url(`${parent}-a`), { transactions: [{ id: 'txn-1' }], totalItems: 1 });

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['txn-1']));
    expect(result.current.totalItems).toBe(1);
    expect(result.current.page).toBe(1);
    expect(result.current.totalPages).toBe(1);
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: `/api/lawfirms/firm-a/trust/${parent}s/${parent}-a/ledger`,
      query: { limit: ['25'], offset: ['0'], order: ['desc'] },
    })]);
  });

  it('treats an actual empty ledger as success, not as a loading or error state', async () => {
    api.getExact(url(`${parent}-a`), { transactions: [], totalItems: 0 });

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('reports a failed ledger load rather than presenting zero transactions as success', async () => {
    api.getExact(url(`${parent}-a`), { status: 503, body: { error: 'Ledger temporarily unavailable' } });

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(errorFallbackPattern));
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
  });

  it('recovers a failed first page on refresh', async () => {
    api.getExact(url(`${parent}-a`), { status: 503, body: { error: 'Ledger temporarily unavailable' } });

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy());

    api.getExact(url(`${parent}-a`), { transactions: [{ id: 'recovered' }], totalItems: 1 });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['recovered']));
    expect(result.current.error).toBeNull();
  });

  it('advances to the exact next page window and keeps rows visible while it loads', async () => {
    api.getExact(url(`${parent}-a`, 0), { transactions: [{ id: 'page-one' }], totalItems: 30 });
    const pageTwo = holdResponse();
    api.getExact(url(`${parent}-a`, 25), pageTwo.handler);

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['page-one']));

    act(() => result.current.setPage(2));

    await pageTwo.untilRequested();
    expect(result.current.transactions.map((t) => t.id)).toEqual(['page-one']);
    expect(result.current.totalItems).toBe(30);

    await act(async () => {
      pageTwo.release({ transactions: [{ id: 'page-two' }], totalItems: 30 });
    });

    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['page-two']));
    expect(result.current.page).toBe(2);
  });

  it('uses the requested page size and rewinds before requesting a resized page', async () => {
    const path = `/api/lawfirms/firm-a/trust/${parent}s/${parent}-a/ledger`;
    api.getExact(`${path}?limit=10&offset=0&order=desc`, {
      transactions: [{ id: 'small-first' }], totalItems: 31,
    });
    api.getExact(`${path}?limit=10&offset=20&order=desc`, {
      transactions: [{ id: 'small-third' }], totalItems: 31,
    });
    const resized = holdResponse();
    api.getExact(`${path}?limit=20&offset=0&order=desc`, resized.handler);

    const { result } = renderHook(() => useHook('firm-a', `${parent}-a`, { pageSize: 10 }), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['small-first']));
    expect(result.current.rowsPerPage).toBe(10);
    expect(result.current.totalPages).toBe(4);

    act(() => result.current.setPage(3));
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['small-third']));

    act(() => result.current.setRowsPerPage(20));
    await resized.untilRequested();
    expect(result.current.page).toBe(1);
    expect(result.current.rowsPerPage).toBe(20);
    expect(result.current.totalPages).toBe(2);
    expect(result.current.fetching).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.transactions.map((t) => t.id)).toEqual(['small-third']);

    await act(async () => resized.release({ transactions: [{ id: 'large-first' }], totalItems: 31 }));
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['large-first']));
    expect(result.current.fetching).toBe(false);
    expect(api.calls().map((call) => call.query)).toEqual([
      { limit: ['10'], offset: ['0'], order: ['desc'] },
      { limit: ['10'], offset: ['20'], order: ['desc'] },
      { limit: ['20'], offset: ['0'], order: ['desc'] },
    ]);
  });

  it('clears the previous firm rows and total while rewinding a paged ledger on a firm switch', async () => {
    api.getExact(url(`${parent}-a`), { transactions: [{ id: 'firm-a-first' }], totalItems: 60 });
    api.getExact(url(`${parent}-a`, 25), { transactions: [{ id: 'firm-a-second' }], totalItems: 60 });
    const newFirm = holdResponse();
    const newPath = `/api/lawfirms/firm-b/trust/${parent}s/${parent}-a/ledger`;
    api.getExact(`${newPath}?limit=25&offset=0&order=desc`, newFirm.handler);

    const { result, rerender } = renderHook(
      ({ firm }) => useHook(firm, `${parent}-a`),
      { initialProps: { firm: 'firm-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['firm-a-first']));
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['firm-a-second']));

    rerender({ firm: 'firm-b' });
    await newFirm.untilRequested();
    expect(result.current.page).toBe(1);
    expect(result.current.transactions).toEqual([]);
    expect(result.current.totalItems).toBe(0);
    expect(result.current.loading).toBe(true);
    expect(api.calls().filter((call) => call.pathname === newPath)).toEqual([
      expect.objectContaining({ query: { limit: ['25'], offset: ['0'], order: ['desc'] } }),
    ]);

    await act(async () => newFirm.release({ transactions: [{ id: 'firm-b-first' }], totalItems: 1 }));
    await waitFor(() => expect(result.current.transactions.map((t) => t.id)).toEqual(['firm-b-first']));
    expect(result.current.totalItems).toBe(1);
    expect(result.current.totalPages).toBe(1);
  });

  itKeepsScopeIsolated({
    title: `does not show one ${parent} ledger the other ${parent} rows after a scope change`,
    mode: 'pending',
    api: () => api,
    useHook: ({ parentId }: { parentId: string }) => useHook('firm-a', parentId),
    ids: (r) => r.transactions.map((t) => t.id),
    a: {
      props: { parentId: `${parent}-a` },
      url: url(`${parent}-a`),
      body: { transactions: [{ id: `${parent}-a-txn` }], totalItems: 1 },
      ids: [`${parent}-a-txn`],
    },
    b: {
      props: { parentId: `${parent}-b` },
      url: url(`${parent}-b`),
      body: { transactions: [{ id: `${parent}-b-txn` }], totalItems: 1 },
      ids: [`${parent}-b-txn`],
    },
    finally: (result) => {
      expect(result.totalItems).toBe(1);
    },
  });
});
