/**
 * Offline trust-account contracts.
 *
 * The former live-only check established only that one deployed account could
 * load. These cases keep the real hook and trust service, but control the
 * transport so ordinary CI verifies firm scoping, loading prerequisites, error
 * state, and an in-place firm change deterministically.
 */
jest.unmock('@/services/trust.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useTrustAccounts from '@/hooks/trustHooks/useTrustAccounts';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useTrustAccounts offline contract', () => {
  it('does not request or present a misleading empty balance before firm scope exists', async () => {
    const { result } = renderHook(() => useTrustAccounts(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accounts).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toHaveLength(0);
  });

  it('loads only the exact trust-account endpoint for the selected firm', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/accounts', {
      accounts: [{ id: 'account-a', name: 'Firm A IOLTA' }],
    });

    const { result } = renderHook(() => useTrustAccounts('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.accounts.map((account) => account.id)).toEqual(['account-a']));
    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: '/api/lawfirms/firm-a/trust/accounts',
    })]);
    expect(result.current.error).toBeNull();
  });

  it('reports a failed account load instead of presenting an empty result as success', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/accounts', {
      status: 500,
      body: { error: 'Trust accounts unavailable' },
    });

    const { result } = renderHook(() => useTrustAccounts('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/Trust accounts unavailable/i));
    expect(result.current.accounts).toEqual([]);
  });

  it('recovers from a transient account error when the user refreshes', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/accounts', {
      status: 503,
      body: { error: 'Trust accounts unavailable' },
    });

    const { result } = renderHook(() => useTrustAccounts('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toMatch(/Trust accounts unavailable/i));

    api.getExact('/api/lawfirms/firm-a/trust/accounts', {
      accounts: [{ id: 'account-a', name: 'Recovered IOLTA' }],
    });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.accounts.map((account) => account.id)).toEqual(['account-a']));
    expect(result.current.error).toBeNull();
  });

  itKeepsScopeIsolated({
    title: 'keeps firm B accounts visible when firm A resolves after the switch',
    mode: 'late',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useTrustAccounts(lawFirmId),
    ids: (r) => r.accounts.map((account) => account.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/api/lawfirms/firm-a/trust/accounts', body: { accounts: [{ id: 'account-a', name: 'Firm A IOLTA' }] }, ids: ['account-a'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/api/lawfirms/firm-b/trust/accounts', body: { accounts: [{ id: 'account-b', name: 'Firm B IOLTA' }] }, ids: ['account-b'] },
    finally: (result) => {
      expect(result.error).toBeNull();
    },
  });
});
