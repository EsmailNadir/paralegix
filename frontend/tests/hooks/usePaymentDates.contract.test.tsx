/**
 * Offline contract coverage for the calendar payment-dates read.
 *
 * This hook had zero test coverage. It shares the same
 * `[..., lawFirmId, "window", from, to]` query-key shape and bare
 * `placeholderData: keepPreviousData` already found and fixed as a cross-tenant
 * leak in `useTasks`/`useClients`/`useClientLedger`/`useMatterLedger`/
 * `useTrustTransactions`. `useCalendarWindowData` suppresses this hook's stale
 * output at the CALLER level on a firm switch, but the raw hook itself still
 * leaks the previous firm's payment dates to any other caller (or any test) that
 * reads it directly.
 */
jest.unmock('@/services/billing.service');

import { renderHook, waitFor } from '@testing-library/react';

import usePaymentDates from '@/hooks/billingHooks/usePaymentDates';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

const WINDOW = { key: '2026-09', from: '2026-09-01', to: '2026-09-30' };

describe('usePaymentDates offline contract', () => {
  it('does not request payment dates before a firm scope exists', async () => {
    const { result } = renderHook(() => usePaymentDates(undefined, WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact firm/window endpoint', async () => {
    api.getExact(
      `/api/lawfirms/firm-a/billing/invoices/calendar-payment-dates?from=${WINDOW.from}&to=${WINDOW.to}`,
      { paymentDates: [{ id: 'payment-a' }] },
    );

    const { result } = renderHook(() => usePaymentDates('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.map((p) => p.id)).toEqual(['payment-a']));
  });

  // Firm B's request is still pending here. Firm A's payment dates must not
  // render as though they belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show firm A payment dates as firm B dates after firm A already resolved',
    mode: 'pending',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => usePaymentDates(lawFirmId, WINDOW),
    ids: (r) => (r.data ?? []).map((p) => p.id),
    a: {
      props: { lawFirmId: 'firm-a' },
      url: `/api/lawfirms/firm-a/billing/invoices/calendar-payment-dates?from=${WINDOW.from}&to=${WINDOW.to}`,
      body: { paymentDates: [{ id: 'firm-a-payment' }] },
      ids: ['firm-a-payment'],
    },
    b: {
      props: { lawFirmId: 'firm-b' },
      url: `/api/lawfirms/firm-b/billing/invoices/calendar-payment-dates?from=${WINDOW.from}&to=${WINDOW.to}`,
      body: { paymentDates: [{ id: 'firm-b-payment' }] },
      ids: ['firm-b-payment'],
    },
  });
});
