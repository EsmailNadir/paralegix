/** Offline contract coverage for the firm-wide client trust balance report. */
jest.unmock('@/services/trust.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientBalances from '@/hooks/trustHooks/useClientBalances';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useClientBalances offline contract', () => {
  it('waits for firm scope before requesting a balance report', async () => {
    const { result } = renderHook(() => useClientBalances(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balances).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toHaveLength(0);
  });

  it('loads only the selected firm balance report and preserves integer cents', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      balances: [{
        clientId: 'client-a', clientName: 'Firm A client', trustAccountId: 'account-a', balanceCents: 7350,
      }],
    });

    const { result } = renderHook(() => useClientBalances('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.balances.map((balance) => balance.clientId)).toEqual(['client-a']));
    expect(result.current.balances[0].balanceCents).toBe(7350);
    expect(Number.isInteger(result.current.balances[0].balanceCents)).toBe(true);
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: '/api/lawfirms/firm-a/trust/balances', method: 'GET',
    })]);
  });

  it('distinguishes a report failure from a real zero-balance report and recovers on refresh', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      status: 503,
      body: { error: 'Balance report unavailable' },
    });

    const { result } = renderHook(() => useClientBalances('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toMatch(/Balance report unavailable/i));
    expect(result.current.balances).toEqual([]);

    api.getExact('/api/lawfirms/firm-a/trust/balances', { balances: [] });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.balances).toEqual([]);
  });

  itKeepsScopeIsolated({
    title: 'keeps firm B balances active when firm A resolves after the switch',
    mode: 'late',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useClientBalances(lawFirmId),
    ids: (r) => r.balances.map((balance) => balance.clientId),
    a: {
      props: { lawFirmId: 'firm-a' },
      url: '/api/lawfirms/firm-a/trust/balances',
      body: { balances: [{ clientId: 'client-a', clientName: 'Firm A client', trustAccountId: 'account-a', balanceCents: 7350 }] },
      ids: ['client-a'],
    },
    b: {
      props: { lawFirmId: 'firm-b' },
      url: '/api/lawfirms/firm-b/trust/balances',
      body: { balances: [{ clientId: 'client-b', clientName: 'Firm B client', trustAccountId: 'account-b', balanceCents: 9100 }] },
      ids: ['client-b'],
    },
    finally: (result) => {
      expect(result.error).toBeNull();
    },
  });
});
