/**
 * Offline contract coverage for the firm unbilled-work read.
 *
 * This hook had zero test coverage. It shares the same
 * `[..., lawFirmId, page, limit]` query-key shape and bare `placeholderData:
 * keepPreviousData` already found and fixed as a cross-tenant leak in
 * `useTasks`/`useClients`/`useClientLedger`/`useMatterLedger`/`useTrustTransactions`.
 */
jest.unmock('@/services/billing.service');

import { renderHook, waitFor } from '@testing-library/react';

import useFirmUnbilledWork from '@/hooks/billingHooks/useFirmUnbilledWork';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useFirmUnbilledWork offline contract', () => {
  it('does not request unbilled work before a firm scope exists', async () => {
    const { result } = renderHook(() => useFirmUnbilledWork(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact firm endpoint', async () => {
    api.getExact('/api/lawfirms/firm-a/billing/unbilled-work', { items: [{ id: 'work-a' }], totalItems: 1 });

    const { result } = renderHook(() => useFirmUnbilledWork('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.items?.map((i) => i.id)).toEqual(['work-a']));
  });

  // Firm B's request is still pending here. Firm A's rows must not render as
  // though they belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show firm A unbilled work as firm B rows after firm A already resolved',
    mode: 'pending',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useFirmUnbilledWork(lawFirmId),
    ids: (r) => (r.data?.items ?? []).map((i) => i.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/api/lawfirms/firm-a/billing/unbilled-work', body: { items: [{ id: 'firm-a-work' }], totalItems: 1 }, ids: ['firm-a-work'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/api/lawfirms/firm-b/billing/unbilled-work', body: { items: [{ id: 'firm-b-work' }], totalItems: 1 }, ids: ['firm-b-work'] },
  });
});
