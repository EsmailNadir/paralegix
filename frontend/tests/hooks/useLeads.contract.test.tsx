/**
 * Offline contract for the lead list hooks (`leadHooks/useLeads.ts`).
 *
 * `usePagedLeads` shares its exact shape with `usePagedMatters` and
 * `useLawfirmTasks`: a paged query rooted at `[domain, lawFirmId, "paged",
 * params]`, backing the leads grid's server-side table. Those two siblings
 * both learned the hard way that a bare `placeholderData: (prev) => prev`
 * hands the LAST successful result to the NEXT query regardless of whether
 * it belongs to the same law firm, and were fixed with a guard on the
 * previous query's own key (see `useMatters.ts` and `useTasks.ts`).
 * `usePagedLeads` still had the bare form with no guard - never audited as
 * part of B04.2's P2 "lead/intake hooks" row - so switching firms while the
 * leads grid is on screen rendered one firm's leads labelled as another's for
 * as long as the new request was in flight.
 */
jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import { useLeadById, usePagedLeads } from '@/hooks/leadHooks/useLeads';
import type { ServerTableQueryParams } from '@/hooks/useServerTable';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const LEADS_A = '/api/lawfirms/firm-a/leads';
const LEADS_B = '/api/lawfirms/firm-b/leads';

function baseParams(overrides: Partial<ServerTableQueryParams> = {}): ServerTableQueryParams {
  return { page: 1, limit: 25, sort: [], search: '', filters: {}, ...overrides };
}

const api = setupApiMock();
let queryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  queryClient = makeTestQueryClient();
  return createQueryWrapper(queryClient);
}

describe('usePagedLeads: disabled without prerequisites', () => {
  it('sends nothing before a law firm id exists', async () => {
    const { result } = renderHook(
      () => usePagedLeads(undefined, baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.leads).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(api.calls()).toEqual([]);
  });

  it('sends nothing while the caller has the query gated off', async () => {
    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams(), false),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);
  });
});

describe('usePagedLeads: valid and empty responses', () => {
  it('reports rows and the server total on a normal page', async () => {
    api.getExact(`${LEADS_A}?limit=25&page=1`, {
      leads: [{ id: 'lead-1', name: 'Alice' }, { id: 'lead-2', name: 'Bob' }],
      totalItems: 2,
    });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.leads).toHaveLength(2));
    expect(result.current.total).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it('reports zero leads as a real empty page, not a failure', async () => {
    api.getExact(`${LEADS_A}?limit=25&page=1`, { leads: [], totalItems: 0 });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.leads).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBeNull();
  });
});

describe('usePagedLeads: failure and recovery', () => {
  it('reports a failed load instead of presenting zero leads as success', async () => {
    api.getExact(`${LEADS_A}?limit=25&page=1`, { status: 500, body: { error: 'Lead service unavailable' } });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.error).toMatch(/Lead service unavailable/i));
    expect(result.current.leads).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('clears the error and shows fresh rows once a manual refresh succeeds', async () => {
    let attempt = 0;
    api.getExact(`${LEADS_A}?limit=25&page=1`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'Lead service unavailable' } };
      return { leads: [{ id: 'lead-1', name: 'Alice' }], totalItems: 1 };
    });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.error).toMatch(/Lead service unavailable/i));

    await result.current.refresh();

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['lead-1']));
    expect(result.current.error).toBeNull();
  });
});

describe('usePagedLeads: parameters', () => {
  it('forwards the stage filter and the encoded sort model', async () => {
    api.getExact(
      `${LEADS_A}?limit=10&page=3&sort=updatedAt%3Adesc&stageId=stage-9`,
      { leads: [{ id: 'lead-9', name: 'Filtered' }], totalItems: 41 },
    );

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams({
        page: 3,
        limit: 10,
        sort: [{ field: 'updatedAt', sort: 'desc' }],
        filters: { stageId: 'stage-9' },
      })),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.leads).toHaveLength(1));
    expect(result.current.total).toBe(41);
  });

  it('trims the search term before sending it', async () => {
    api.getExact(`${LEADS_A}?limit=25&page=1&search=acme`, { leads: [], totalItems: 0 });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams({ search: '  acme  ' })),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()[0].query.search).toEqual(['acme']);
  });
});

describe('usePagedLeads: paging keeps the previous page on screen', () => {
  it('holds the prior rows and total while the next page loads', async () => {
    api.getExact(`${LEADS_A}?limit=10&page=1`, { leads: [{ id: 'page-one' }], totalItems: 30 });
    api.getExact(`${LEADS_A}?limit=10&page=2`, { status: 200, body: { leads: [{ id: 'page-two' }], totalItems: 30 }, delayMs: 40 });

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => usePagedLeads('firm-a', baseParams({ page, limit: 10 })),
      { wrapper: createWrapper(), initialProps: { page: 1 } },
    );

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['page-one']));

    rerender({ page: 2 });

    // Mid-flight: page one's rows and total are still on screen.
    expect(result.current.leads.map((l) => l.id)).toEqual(['page-one']);
    expect(result.current.total).toBe(30);

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['page-two']));
    expect(result.current.total).toBe(30);
  });

  it('does not show one law firm the leads of another after a scope change', async () => {
    // The bug this file exists to pin: usePagedLeads used a bare
    // `placeholderData: (prev) => prev`, which hands the previous query's
    // data to the NEXT query on ANY key change - including a law-firm
    // switch, not just a same-firm page/filter change. Firm A's rows must not
    // render as though they belong to firm B while firm B's request is still
    // in flight.
    const heldFirmB = holdResponse();
    api.getExact(`${LEADS_A}?limit=25&page=1`, { leads: [{ id: 'firm-a-lead' }], totalItems: 1 });
    api.getExact(`${LEADS_B}?limit=25&page=1`, heldFirmB.handler);

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => usePagedLeads(firm, baseParams()),
      { wrapper: createWrapper(), initialProps: { firm: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['firm-a-lead']));

    rerender({ firm: 'firm-b' });
    await heldFirmB.untilRequested();

    // Firm B's request is still pending here. Firm A's leads must not still be
    // on screen as though they were firm B's.
    expect(result.current.leads.map((l) => l.id)).not.toContain('firm-a-lead');

    await heldFirmB.release({ leads: [{ id: 'firm-b-lead' }], totalItems: 1 });

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['firm-b-lead']));
  });
});

describe('usePagedLeads: mutation invalidation', () => {
  it('refetches when a mutation invalidates the shared ["leads", lawFirmId] prefix', async () => {
    let calls = 0;
    api.getExact(`${LEADS_A}?limit=25&page=1`, () => {
      calls += 1;
      return { leads: [{ id: `lead-v${calls}` }], totalItems: 1 };
    });

    const { result } = renderHook(
      () => usePagedLeads('firm-a', baseParams()),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['lead-v1']));

    // This is the exact prefix LeadDetailModal and LeadsGrid invalidate after
    // creating, converting, or deleting a lead.
    await queryClient.invalidateQueries({ queryKey: ['leads', 'firm-a'] });

    await waitFor(() => expect(result.current.leads.map((l) => l.id)).toEqual(['lead-v2']));
  });
});

describe('useLeadById: prerequisites and query keys', () => {
  it('useLeadById sends nothing without both a firm and a lead id, and is keyed per lead', async () => {
    api.getExact('/api/lawfirms/firm-a/leads/lead-1', { lead: { id: 'lead-1', name: 'Alice' } });

    const { result, rerender } = renderHook(
      ({ leadId }: { leadId: string | null }) => useLeadById('firm-a', leadId),
      { wrapper: createWrapper(), initialProps: { leadId: null as string | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);

    rerender({ leadId: 'lead-1' });
    await waitFor(() => expect(result.current.lead?.id).toBe('lead-1'));
  });
});
