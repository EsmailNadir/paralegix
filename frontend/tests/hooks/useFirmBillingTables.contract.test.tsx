/**
 * Offline contract coverage for the firm invoices and firm time-entries table
 * hooks.
 *
 * The two are separate implementations with the same contract, so one case list
 * runs against both. Each shares the `[..., lawFirmId, {...}]` query-key shape
 * and bare `placeholderData: keepPreviousData` already found and fixed as a
 * cross-tenant leak in `useTasks`/`useClients`/`useClientLedger`/
 * `useMatterLedger`/`useTrustTransactions`.
 */
jest.unmock('@/services/billing.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useFirmInvoicesTable from '@/hooks/billingHooks/useFirmInvoicesTable';
import useFirmTimeEntriesTable from '@/hooks/billingHooks/useFirmTimeEntriesTable';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { holdResponse } from '../support/deferred';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

type TableResult = { rows: Array<{ id: string }>; setPage: (page: number) => void };

const TABLES = [
  {
    name: 'useFirmInvoicesTable',
    useTable: (lawFirmId: string): TableResult => useFirmInvoicesTable(lawFirmId, { defaultSort: [] }),
    url: (firm: string) => `/api/lawfirms/${firm}/billing/invoices/firm?page=1&limit=10`,
    key: 'invoices',
    entity: 'invoice',
  },
  {
    name: 'useFirmTimeEntriesTable',
    useTable: (lawFirmId: string): TableResult => useFirmTimeEntriesTable(lawFirmId),
    url: (firm: string) => `/api/lawfirms/${firm}/billing/time-entries/firm?page=1&limit=10&sort=date:desc`,
    key: 'timeEntries',
    entity: 'entry',
  },
];

describe.each(TABLES)('$name offline contract', ({ useTable, url, key, entity }) => {
  const page = (id: string) => ({ [key]: [{ id }], totalItems: 1 });
  const ids = (r: TableResult) => r.rows.map((row) => row.id);

  it('fetches the exact firm/page endpoint', async () => {
    api.getExact(url('firm-a'), page(`${entity}-a`));

    const { result } = renderHook(() => useTable('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(ids(result.current)).toEqual([`${entity}-a`]));
  });

  it('keeps the previous page on screen while the next page of the same firm loads', async () => {
    const twoPages = (id: string) => ({ [key]: [{ id }], totalItems: 20 });
    api.getExact(url('firm-a'), twoPages(`${entity}-p1`));
    const nextPage = holdResponse();
    api.getExact(url('firm-a').replace('page=1', 'page=2'), nextPage.handler);

    const { result } = renderHook(() => useTable('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(ids(result.current)).toEqual([`${entity}-p1`]));

    act(() => result.current.setPage(2));
    await nextPage.untilRequested();

    // Page 2 is in flight: page 1's rows stay rendered rather than blanking.
    expect(ids(result.current)).toEqual([`${entity}-p1`]);

    await act(async () => nextPage.release(twoPages(`${entity}-p2`)));
    await waitFor(() => expect(ids(result.current)).toEqual([`${entity}-p2`]));
  });

  itKeepsScopeIsolated({
    title: `does not show firm A rows as firm B rows after firm A already resolved`,
    mode: 'pending',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useTable(lawFirmId),
    ids,
    a: { props: { lawFirmId: 'firm-a' }, url: url('firm-a'), body: page(`firm-a-${entity}`), ids: [`firm-a-${entity}`] },
    b: { props: { lawFirmId: 'firm-b' }, url: url('firm-b'), body: page(`firm-b-${entity}`), ids: [`firm-b-${entity}`] },
  });
});
