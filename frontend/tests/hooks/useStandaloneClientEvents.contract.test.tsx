/**
 * Offline contract coverage for the calendar's firm-wide standalone client
 * events read.
 *
 * Keyed `["clientEvents", lawFirmId, "window", from, to, tz]` with bare
 * `placeholderData: keepPreviousData`. Consumed directly by
 * `DashboardCalendarWidget` (not only through `useCalendarWindowData`, which
 * suppresses stale-firm data at its own call site), so the raw hook still
 * needs its own guard - the same reasoning `usePaymentDates` was fixed under
 * even though its one caller already mitigated the leak.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import useStandaloneClientEvents from '@/hooks/calendarHooks/useStandaloneClientEvents';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const WINDOW = { key: '2026-09', from: '2026-09-01', to: '2026-09-30' };

const api = setupApiMock();

describe('useStandaloneClientEvents offline contract', () => {
  it('fetches the exact firm client-events endpoint', async () => {
    api.get('/lawfirms/firm-a/clients/events', { events: [{ id: 'evt-a' }], totalEvents: 1 });

    const { result } = renderHook(() => useStandaloneClientEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.clientEvents.map((e) => e.id)).toEqual(['evt-a']));
  });

  // Firm B's window request is still pending here (the window itself did not
  // change, only the firm), so nothing but the firm id flags this as a
  // different scope. Firm A's events must not render as though they belong
  // to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one firm the client events of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useStandaloneClientEvents(lawFirmId, WINDOW),
    ids: (r) => r.clientEvents.map((e) => e.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/lawfirms/firm-a/clients/events', body: { events: [{ id: 'firm-a-event' }], totalEvents: 1 }, ids: ['firm-a-event'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/lawfirms/firm-b/clients/events', body: { events: [{ id: 'firm-b-event' }], totalEvents: 1 }, ids: ['firm-b-event'] },
  });
});
