/**
 * Offline contract for the firm's roles (`useRoles`), behind Settings > Roles
 * and every role picker.
 *
 * Roles decide what a member can do, so a role list shown for the wrong firm
 * is a list someone acts on. The hook also imposes an order the server does
 * not: built-in roles first, in seniority order, then custom roles by name.
 *
 * Driven through the real `roles.service`.
 *
 * What has to break for these to go red: the ordering rule, either response
 * shape the service accepts, a write addressing the wrong firm or role, an
 * invalidation that misses this firm or reaches another, a write sent with no
 * firm, or a failed load reported as an empty list.
 */
jest.unmock('@/services/roles.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useRoles from '@/hooks/useRoles';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import type { Role } from '@/types/role';
import { sequence, setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
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
});

const ROLES = (firm: string) => `/api/lawfirms/${firm}/roles`;
const role = (id: string, name: string, isBuiltIn = false) => ({ id, name, isBuiltIn, permissions: [] }) as unknown as Role;
const names = (r: { roles: Role[] }) => r.roles.map((x) => x.name);
const ids = (r: { roles: Role[] }) => r.roles.map((x) => x.id);

itSendsNothingWithoutScope({
  title: 'sends nothing without a firm',
  api: () => api,
  useHook: () => useRoles(undefined),
  settled: (r) => r.loading === false,
  finally: (r) => expect(r.roles).toEqual([]),
});

describe('reading', () => {
  it('lists built-in roles by seniority, then any other built-in, then custom roles by name', async () => {
    api.getExact(ROLES('firm-a'), [
      role('c2', 'Billing clerk'),
      role('b5', 'Staff', true),
      role('b1', 'Owner', true),
      role('c1', 'Associate'),
      role('b9', 'Auditor', true),
      role('b3', 'Attorney', true),
      role('b2', 'Admin', true),
      role('b4', 'Paralegal', true),
    ]);

    const { result } = renderHook(() => useRoles('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(names(result.current)).toEqual([
      'Owner', 'Admin', 'Attorney', 'Paralegal', 'Staff', 'Auditor', 'Associate', 'Billing clerk',
    ]));
  });

  it('accepts the list wrapped in a roles envelope', async () => {
    api.getExact(ROLES('firm-a'), { roles: [role('c1', 'Associate'), role('b1', 'Owner', true)] });

    const { result } = renderHook(() => useRoles('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(names(result.current)).toEqual(['Owner', 'Associate']));
  });

  it('reports a failed load rather than an empty list', async () => {
    api.getExact(ROLES('firm-a'), { status: 403, body: { error: 'You cannot view roles' } });

    const { result } = renderHook(() => useRoles('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toBe('You cannot view roles'));
    expect(result.current.roles).toEqual([]);
  });

  itKeepsScopeIsolated({
    title: "does not show one firm's roles while another firm's load",
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useRoles(firm),
    ids,
    a: { props: { firm: 'firm-a' }, url: ROLES('firm-a'), body: [role('a-role', 'Associate')], ids: ['a-role'] },
    b: { props: { firm: 'firm-b' }, url: ROLES('firm-b'), body: [role('b-role', 'Associate')], ids: ['b-role'] },
  });
});

describe('writing', () => {
  type Hook = ReturnType<typeof useRoles>;
  const WRITES: Array<{ name: string; method: 'POST' | 'PUT' | 'DELETE'; path: string; body: unknown; reply: unknown; run: (h: Hook) => Promise<unknown>; returns: unknown }> = [
    {
      name: 'createRole',
      method: 'POST',
      path: ROLES('firm-a'),
      body: { name: 'Billing clerk', permissions: ['billing.view'] },
      reply: { role: { id: 'new', name: 'Billing clerk' } },
      run: (h) => h.createRole({ name: 'Billing clerk', permissions: ['billing.view'] }),
      returns: { id: 'new', name: 'Billing clerk' },
    },
    {
      name: 'updateRole',
      method: 'PUT',
      path: `${ROLES('firm-a')}/c1`,
      body: { permissions: ['matters.view'] },
      reply: { role: { id: 'c1', name: 'Associate' } },
      run: (h) => h.updateRole('c1', { permissions: ['matters.view'] }),
      returns: { id: 'c1', name: 'Associate' },
    },
    {
      name: 'deleteRole',
      method: 'DELETE',
      path: `${ROLES('firm-a')}/c1`,
      body: null,
      reply: { status: 204 },
      run: (h) => h.deleteRole('c1'),
      returns: undefined,
    },
  ];

  describe.each(WRITES)('$name', ({ method, path, body, reply, run, returns }) => {
    it("reaches its own firm and role, returns the server's role, and refreshes only that firm", async () => {
      api.getExact(ROLES('firm-a'), sequence([role('c1', 'Associate')], [role('c1', 'Associate'), role('new', 'Billing clerk')]));
      api.getExact(ROLES('firm-b'), [role('b-role', 'Other')]);
      ({ POST: api.postExact, PUT: api.putExact, DELETE: api.deleteExact })[method](path, reply as never);

      const { result } = renderHook(() => ({ a: useRoles('firm-a'), b: useRoles('firm-b') }), { wrapper: createQueryWrapper() });
      await waitFor(() => expect(ids(result.current.a)).toEqual(['c1']));
      await waitFor(() => expect(ids(result.current.b)).toEqual(['b-role']));

      let value: unknown = 'unset';
      await act(async () => {
        value = await run(result.current.a);
      });

      expect(value).toEqual(returns);
      expect(api.calls().filter((c) => c.method !== 'GET').map((c) => [c.method, c.pathname, c.body])).toEqual([[method, path, body]]);
      await waitFor(() => expect(ids(result.current.a)).toEqual(['c1', 'new']));
      expect(api.callsTo('/firm-b/roles')).toHaveLength(1);
    });

    it('rejects without sending anything when there is no firm', async () => {
      const { result } = renderHook(() => useRoles(undefined), { wrapper: createQueryWrapper() });

      await act(async () => {
        await expect(run(result.current)).rejects.toThrow('Law firm ID is required');
      });

      expect(api.calls()).toEqual([]);
    });
  });

  it('rejects a refused write with the server reason and does not refetch', async () => {
    api.getExact(ROLES('firm-a'), [role('b1', 'Owner', true)]);
    api.deleteExact(`${ROLES('firm-a')}/b1`, { status: 409, body: { error: 'Built-in roles cannot be deleted' } });

    const { result } = renderHook(() => useRoles('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(ids(result.current)).toEqual(['b1']));

    await act(async () => {
      await expect(result.current.deleteRole('b1')).rejects.toThrow('Built-in roles cannot be deleted');
    });

    expect(api.callsTo('/roles').filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});
