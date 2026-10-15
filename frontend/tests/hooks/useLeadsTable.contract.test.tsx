/**
 * Offline contract for `leadHooks/useLeadsTable.ts`.
 *
 * This hook owns no query of its own - it pairs `useServerTable` (page/sort/
 * filter/search state) with `usePagedLeads` (already covered end-to-end,
 * including the cross-tenant `placeholderData` regression, by
 * `useLeads.contract.test.tsx`). What is specific to THIS hook, and untested
 * anywhere before this file, is the wiring between the two: a filter change
 * resets to page 1 and reaches the request, and `recoverOutOfRangePage` snaps
 * the table back to page 1 when the current page's rows and the server total
 * both go to zero (e.g. the last row on the last page was deleted). Getting
 * that wiring wrong stranded the view on an empty "page N of 0" with no way
 * back short of a manual filter change.
 */
jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';

import useLeadsTable from '@/hooks/leadHooks/useLeadsTable';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const LEADS_A = '/api/lawfirms/firm-a/leads';

const api = setupApiMock();
let queryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  queryClient = makeTestQueryClient();
  return createQueryWrapper(queryClient);
}

describe('useLeadsTable: disabled without prerequisites', () => {
  it('sends nothing without a law firm id', async () => {
    const { result } = renderHook(() => useLeadsTable(undefined), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(api.calls()).toEqual([]);
  });

  it('sends nothing while the caller gates the table off', async () => {
    const { result } = renderHook(() => useLeadsTable('firm-a', undefined, false), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);
  });
});

describe('useLeadsTable: valid and empty responses', () => {
  it('opens on the default sort (createdAt desc) and the default page size', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, {
      leads: [{ id: 'lead-1' }, { id: 'lead-2' }],
      totalItems: 2,
    });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.total).toBe(2);
  });

  it('reports a real empty result set, not a failure', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, { leads: [], totalItems: 0 });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBeNull();
  });
});

describe('useLeadsTable: failure and recovery', () => {
  it('reports a failed load instead of presenting zero rows as success', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, { status: 500, body: { error: 'Lead service unavailable' } });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/Lead service unavailable/i));
    expect(result.current.rows).toEqual([]);
  });

  it('clears the error and shows fresh rows once a manual refetch succeeds', async () => {
    let attempt = 0;
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'Lead service unavailable' } };
      return { leads: [{ id: 'lead-1' }], totalItems: 1 };
    });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.error).toMatch(/Lead service unavailable/i));

    await result.current.refetch();

    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['lead-1']));
    expect(result.current.error).toBeNull();
  });
});

describe('useLeadsTable: paging - out-of-range recovery', () => {
  it('snaps back to page 1 once the current page comes back empty with a zero total', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=2&sort=createdAt%3Adesc`, { leads: [{ id: 'last-row' }], totalItems: 11 });
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, { leads: [], totalItems: 0 });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await act(async () => { result.current.setPage(2); });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['last-row']));

    // The last row on page 2 gets deleted elsewhere; the next page-2 fetch
    // (triggered here by a manual refetch, standing in for the invalidation a
    // delete mutation would fire) comes back empty with a zero total.
    api.getExact(`${LEADS_A}?limit=10&page=2&sort=createdAt%3Adesc`, { leads: [], totalItems: 0 });
    await act(async () => { await result.current.refetch(); });

    await waitFor(() => expect(result.current.page).toBe(1));
    await waitFor(() => expect(result.current.rows).toEqual([]));
  });

  it('does not recover while a page is genuinely, persistently empty at page 1', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, { leads: [], totalItems: 0 });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.page).toBe(1);
    expect(result.current.rows).toEqual([]);
  });
});

describe('useLeadsTable: parameters - filters reset to page 1', () => {
  it('applying a stage filter from a non-first page resets to page 1 and forwards the filter', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, { leads: [{ id: 'p1' }], totalItems: 30 });
    api.getExact(`${LEADS_A}?limit=10&page=3&sort=createdAt%3Adesc`, { leads: [{ id: 'p3' }], totalItems: 30 });
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc&stageId=stage-9`, { leads: [{ id: 'filtered' }], totalItems: 1 });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['p1']));
    await act(async () => { result.current.setPage(3); });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['p3']));

    await act(async () => { result.current.setFilter('stageId', 'stage-9'); });

    await waitFor(() => expect(result.current.page).toBe(1));
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['filtered']));
  });
});

describe('useLeadsTable: mutation invalidation', () => {
  it('refetches the current page when a mutation invalidates the shared ["leads", lawFirmId] prefix', async () => {
    let calls = 0;
    api.getExact(`${LEADS_A}?limit=10&page=1&sort=createdAt%3Adesc`, () => {
      calls += 1;
      return { leads: [{ id: `lead-v${calls}` }], totalItems: 1 };
    });

    const { result } = renderHook(() => useLeadsTable('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['lead-v1']));

    // The exact prefix LeadDetailModal and LeadsGrid invalidate after
    // creating, converting, or deleting a lead - reaches this hook through
    // usePagedLeads, but only proven end-to-end through the table wrapper here.
    await queryClient.invalidateQueries({ queryKey: ['leads', 'firm-a'] });

    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['lead-v2']));
  });
});
