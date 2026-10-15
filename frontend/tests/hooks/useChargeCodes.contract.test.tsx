/**
 * Offline contract for the firm's charge codes (`useChargeCodes`).
 *
 * The list is cached per firm AND per `includeInactive`, so the settings page
 * (all codes) and every time-entry picker (active only) hold separate entries.
 * A write must refresh both, and only for its own firm. The service layer also
 * reorders arguments on the way through (`chargeCodes.service` takes the code
 * id first, `billing.service` takes the firm first), so each write is checked
 * against the exact url it must reach.
 *
 * Driven through the real `chargeCodes.service` and `billing.service`.
 *
 * What has to break for these to go red: the `includeInactive` flag not sent,
 * a write addressing the wrong firm or code, an invalidation that misses one of
 * the two cached variants or reaches another firm, a write sent without a firm,
 * or a failed load reported as an empty list.
 */
jest.unmock('@/services/chargeCodes.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useChargeCodes from '@/hooks/chargeCodeHooks/useChargeCodes';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { sequence, setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { grantBaselineMember, grantPermissions, resetPermissions } from '../support/permissions';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

// A write re-reads the list it just changed, which trips the dev-only
// duplicate-GET warning. That re-read is what these specs are about.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
  resetPermissions();
});

const BASE = (firm: string) => `/api/lawfirms/${firm}/billing/charge-codes`;
const LIST = (firm: string, includeInactive = false) => `${BASE(firm)}?includeInactive=${includeInactive}`;
const codes = (...ids: string[]) => ({ chargeCodes: ids.map((id) => ({ id, code: id.toUpperCase(), name: id })) });
const ids = (r: { chargeCodes: Array<{ id: string }> }) => r.chargeCodes.map((c) => c.id);

itSendsNothingWithoutScope({
  title: 'sends nothing without a firm',
  api: () => api,
  useHook: () => useChargeCodes(undefined),
  settled: (r) => r.loading === false,
  finally: (r) => expect(r.chargeCodes).toEqual([]),
});

itSendsNothingWithoutScope({
  title: 'sends nothing while the caller holds it back',
  api: () => api,
  useHook: () => useChargeCodes('firm-a', false, false),
  settled: (r) => r.loading === false,
});

describe('without billing.viewRates', () => {
  // The list route answers 403 without the permission, and a time-entry modal that
  // asked anyway would draw an error for a member who did nothing wrong.
  // Red if: the permission stops gating the query.
  it('sends nothing, and reports an empty list rather than an error', async () => {
    grantPermissions(['billing.manageTimeEntries']);

    const { result } = renderHook(() => useChargeCodes('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);
    expect(result.current.chargeCodes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('reads the list for a member who holds it', async () => {
    grantBaselineMember(['billing.viewRates']);
    api.getExact(LIST('firm-a'), codes('active'));

    const { result } = renderHook(() => useChargeCodes('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(ids(result.current)).toEqual(['active']));
  });
});

describe('reading', () => {
  it('asks for active codes only by default, and for every code when told to', async () => {
    api.getExact(LIST('firm-a', false), codes('active'));
    api.getExact(LIST('firm-a', true), codes('active', 'retired'));

    const { result } = renderHook(() => ({
      active: useChargeCodes('firm-a'),
      all: useChargeCodes('firm-a', true),
    }), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(ids(result.current.active)).toEqual(['active']));
    await waitFor(() => expect(ids(result.current.all)).toEqual(['active', 'retired']));
  });

  it('reports a failed load rather than an empty list', async () => {
    api.getExact(LIST('firm-a'), { status: 500, body: { error: 'Billing database unavailable' } });

    const { result } = renderHook(() => useChargeCodes('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toBe('Billing database unavailable'));
    expect(result.current.chargeCodes).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  itKeepsScopeIsolated({
    title: "does not show one firm's codes while another firm's load",
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useChargeCodes(firm),
    ids,
    a: { props: { firm: 'firm-a' }, url: LIST('firm-a'), body: codes('a-code'), ids: ['a-code'] },
    b: { props: { firm: 'firm-b' }, url: LIST('firm-b'), body: codes('b-code'), ids: ['b-code'] },
  });
});

describe('writing', () => {
  type Hook = ReturnType<typeof useChargeCodes>;
  const WRITES: Array<{ name: string; method: string; path: string; body: unknown; run: (h: Hook) => Promise<unknown> }> = [
    {
      name: 'createChargeCode',
      method: 'POST',
      path: BASE('firm-a'),
      body: { code: 'L110', name: 'Research', defaultRate: 25000 },
      run: (h) => h.createChargeCode({ code: 'L110', name: 'Research', defaultRate: 25000 }),
    },
    {
      name: 'updateChargeCode',
      method: 'PUT',
      path: `${BASE('firm-a')}/cc-1`,
      body: { code: 'L110', name: 'Legal research', isActive: false },
      run: (h) => h.updateChargeCode('cc-1', { code: 'L110', name: 'Legal research', isActive: false }),
    },
    {
      name: 'deleteChargeCode',
      method: 'DELETE',
      path: `${BASE('firm-a')}/cc-1`,
      body: null,
      run: (h) => h.deleteChargeCode('cc-1'),
    },
    {
      name: 'reorderChargeCodes',
      method: 'PUT',
      path: `${BASE('firm-a')}/reorder`,
      body: { chargeCodeIds: ['cc-2', 'cc-1'] },
      run: (h) => h.reorderChargeCodes(['cc-2', 'cc-1']),
    },
  ];

  describe.each(WRITES)('$name', ({ method, path, body, run }) => {
    it("reaches its own firm and code, then refreshes both of that firm's lists and no other firm's", async () => {
      api.getExact(LIST('firm-a', false), sequence(codes('before'), codes('after')));
      api.getExact(LIST('firm-a', true), sequence(codes('before'), codes('after', 'retired')));
      api.getExact(LIST('firm-b', false), codes('b-code'));
      const register = { POST: api.postExact, PUT: api.putExact, DELETE: api.deleteExact }[method as 'POST' | 'PUT' | 'DELETE'];
      register(path, { message: 'ok', chargeCodeId: 'cc-new' });

      const { result } = renderHook(() => ({
        active: useChargeCodes('firm-a'),
        all: useChargeCodes('firm-a', true),
        other: useChargeCodes('firm-b'),
      }), { wrapper: createQueryWrapper() });
      await waitFor(() => expect(ids(result.current.active)).toEqual(['before']));
      await waitFor(() => expect(ids(result.current.all)).toEqual(['before']));
      await waitFor(() => expect(ids(result.current.other)).toEqual(['b-code']));

      await act(async () => {
        await run(result.current.active);
      });

      const writes = api.calls().filter((c) => c.method !== 'GET');
      expect(writes.map((c) => [c.method, c.pathname, c.body])).toEqual([[method, path, body]]);
      await waitFor(() => expect(ids(result.current.active)).toEqual(['after']));
      await waitFor(() => expect(ids(result.current.all)).toEqual(['after', 'retired']));
      expect(api.callsTo('/firm-b/billing/charge-codes')).toHaveLength(1);
    });

    it('rejects without sending anything when there is no firm', async () => {
      const { result } = renderHook(() => useChargeCodes(undefined), { wrapper: createQueryWrapper() });

      await act(async () => {
        await expect(run(result.current)).rejects.toThrow('Law firm ID is required');
      });

      expect(api.calls()).toEqual([]);
    });
  });

  it('rejects with the server reason and leaves the list as it was', async () => {
    api.getExact(LIST('firm-a'), codes('cc-1'));
    api.deleteExact(`${BASE('firm-a')}/cc-1`, { status: 409, body: { error: 'Charge code is used on billed time' } });

    const { result } = renderHook(() => useChargeCodes('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(ids(result.current)).toEqual(['cc-1']));

    await act(async () => {
      await expect(result.current.deleteChargeCode('cc-1')).rejects.toThrow('Charge code is used on billed time');
    });

    expect(ids(result.current)).toEqual(['cc-1']);
    expect(api.callsTo('/charge-codes')).toHaveLength(1);
  });
});
