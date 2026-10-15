/**
 * Offline contract coverage for the calendar's synced external-events read.
 *
 * Keyed `["externalEvents", lawFirmId, "window", from, to]` with bare
 * `placeholderData: keepPreviousData`. Only ever consumed through
 * `useCalendarWindowData` today, which suppresses stale-firm data at its own
 * call site - but that mitigation lives at the caller, not the hook, so a
 * future direct consumer (as `DashboardCalendarWidget` already is for
 * `useMatterEvents`/`useStandaloneClientEvents`) would inherit the leak. Fixed
 * in the hook itself, matching how `usePaymentDates` was fixed despite its own
 * caller already mitigating the same class of bug.
 */
jest.unmock('@/services/calendarEvents.service');
jest.unmock('@/services/requestDeduplicator');

// Mocked so the timezone test below can change what the hook AND the (real,
// unmocked) service observe without touching the OS clock.
jest.mock('@/lib/utils/timezone', () => ({ getUserTimeZone: jest.fn(() => 'America/New_York') }));

import { renderHook, waitFor } from '@testing-library/react';

import useExternalCalendarEvents from '@/hooks/calendarHooks/useExternalCalendarEvents';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const WINDOW = { key: '2026-09', from: '2026-09-01', to: '2026-09-30' };
const DECEMBER_WINDOW = { key: '2026-12', from: '2026-12-01', to: '2026-12-31' };

const api = setupApiMock();

beforeEach(() => {
  (getUserTimeZone as jest.Mock).mockReturnValue('America/New_York');
});

describe('useExternalCalendarEvents offline contract', () => {
  it('fetches the exact firm calendar-events endpoint', async () => {
    api.get('/lawfirms/firm-a/calendar-events', { events: [{ id: 'evt-a' }] });

    const { result } = renderHook(() => useExternalCalendarEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.externalEvents.map((e) => e.id)).toEqual(['evt-a']));
  });

  // Firm B's window request is still pending here (the window itself did not
  // change, only the firm). Firm A's external events must not render as
  // though they belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one firm the external events of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useExternalCalendarEvents(lawFirmId, WINDOW),
    ids: (r) => r.externalEvents.map((e) => e.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/lawfirms/firm-a/calendar-events', body: { events: [{ id: 'firm-a-event' }] }, ids: ['firm-a-event'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/lawfirms/firm-b/calendar-events', body: { events: [{ id: 'firm-b-event' }] }, ids: ['firm-b-event'] },
  });

  it('sends the exact window bounds and viewer timezone as parameters', async () => {
    api.get('/lawfirms/firm-a/calendar-events', { events: [] });

    renderHook(() => useExternalCalendarEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(api.calls('GET')).toHaveLength(1));
    const [call] = api.calls('GET');
    expect(call.query.from).toEqual([WINDOW.from]);
    expect(call.query.to).toEqual([WINDOW.to]);
    expect(call.query.tz).toEqual(['America/New_York']);
  });

  it('issues a fresh request when navigating to a non-overlapping window', async () => {
    api.get('/lawfirms/firm-a/calendar-events', (call) => ({
      events: call.query.from?.[0] === WINDOW.from ? [{ id: 'september-event' }] : [{ id: 'december-event' }],
    }));

    const { result, rerender } = renderHook(
      ({ window }: { window: typeof WINDOW }) => useExternalCalendarEvents('firm-a', window),
      { initialProps: { window: WINDOW }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.externalEvents.map((e) => e.id)).toEqual(['september-event']));

    rerender({ window: DECEMBER_WINDOW });

    await waitFor(() => expect(result.current.externalEvents.map((e) => e.id)).toEqual(['december-event']));
    expect(api.calls('GET')).toHaveLength(2);
  });

  describe('timezone-specific query keys', () => {
    it('does not keep rendering the old zone\'s events after the viewer\'s timezone changes', async () => {
      // `listExternalEvents` sends the same `tz` the day-only window bounds are
      // resolved against server-side (`calendarRange.ts`), so identical bounds
      // in a different zone are a different UTC range and a different result.
      api.get('/lawfirms/firm-a/calendar-events', (call) => ({
        events: call.query.tz?.[0] === 'Asia/Karachi' ? [{ id: 'karachi-event' }] : [{ id: 'new-york-event' }],
      }));

      const { result, rerender } = renderHook(
        () => useExternalCalendarEvents('firm-a', WINDOW),
        { wrapper: createQueryWrapper() },
      );
      await waitFor(() => expect(result.current.externalEvents.map((e) => e.id)).toEqual(['new-york-event']));

      (getUserTimeZone as jest.Mock).mockReturnValue('Asia/Karachi');
      rerender();

      await waitFor(() => expect(result.current.externalEvents.map((e) => e.id)).toEqual(['karachi-event']));
      expect(api.calls('GET')).toHaveLength(2);
    });
  });
});
