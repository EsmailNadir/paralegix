/**
 * Offline contract coverage for the calendar's firm-wide matter events read.
 *
 * Keyed `["matterEvents", lawFirmId, "window", from, to]` with bare
 * `placeholderData: keepPreviousData`. Consumed directly by
 * `DashboardCalendarWidget` (not only through `useCalendarWindowData`, which
 * suppresses stale-firm data at its own call site), so the raw hook still
 * needs its own guard.
 */
jest.unmock('@/services/matterEvents.service');

// Mocked so the timezone tests below can change what the hook AND the (real,
// unmocked) service observe without touching the OS clock. Every other test in
// this file relies on the default 'America/New_York' set in `beforeEach`.
jest.mock('@/lib/utils/timezone', () => ({ getUserTimeZone: jest.fn(() => 'America/New_York') }));

import { act, renderHook, waitFor } from '@testing-library/react';

import useMatterEvents from '@/hooks/calendarHooks/useMatterEvents';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { setupApiMock, sequence } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const WINDOW = { key: '2026-09', from: '2026-09-01', to: '2026-09-30' };
const DECEMBER_WINDOW = { key: '2026-12', from: '2026-12-01', to: '2026-12-31' };

const api = setupApiMock();

beforeEach(() => {
  (getUserTimeZone as jest.Mock).mockReturnValue('America/New_York');
});

describe('useMatterEvents offline contract', () => {
  it('fetches the exact firm matter-events endpoint', async () => {
    api.get('/lawfirms/firm-a/matters/events', { events: [{ id: 'evt-a' }] });

    const { result } = renderHook(() => useMatterEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['evt-a']));
  });

  // Firm B's window request is still pending here (the window itself did not
  // change, only the firm). Firm A's matter events must not render as though
  // they belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one firm the matter events of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useMatterEvents(lawFirmId, WINDOW),
    ids: (r) => r.matterEvents.map((e) => e.id),
    a: { props: { lawFirmId: 'firm-a' }, url: '/lawfirms/firm-a/matters/events', body: { events: [{ id: 'firm-a-event' }] }, ids: ['firm-a-event'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/lawfirms/firm-b/matters/events', body: { events: [{ id: 'firm-b-event' }] }, ids: ['firm-b-event'] },
  });

  it('is disabled without a firm or a window - no request at all', async () => {
    const { result, rerender } = renderHook(
      ({ lawFirmId, window }: { lawFirmId?: string; window?: typeof WINDOW }) => useMatterEvents(lawFirmId, window),
      {
        initialProps: { lawFirmId: undefined as string | undefined, window: undefined as typeof WINDOW | undefined },
        wrapper: createQueryWrapper(),
      },
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.matterEvents).toEqual([]);

    rerender({ lawFirmId: 'firm-a', window: undefined });
    rerender({ lawFirmId: undefined, window: WINDOW });

    expect(api.calls('GET')).toHaveLength(0);
  });

  it('renders an actual empty response as zero events, not an error', async () => {
    api.get('/lawfirms/firm-a/matters/events', { events: [] });

    const { result } = renderHook(() => useMatterEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.matterEvents).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a load failure and recovers on refetch', async () => {
    api.get('/lawfirms/firm-a/matters/events', sequence(
      { status: 500, body: { error: 'Internal error' } },
      { events: [{ id: 'recovered-event' }] },
    ));

    const { result } = renderHook(() => useMatterEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toBe('Internal error'));
    expect(result.current.matterEvents).toEqual([]);

    await act(async () => { await result.current.refresh(); });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.matterEvents.map((e) => e.id)).toEqual(['recovered-event']);
  });

  it('sends the exact window bounds and viewer timezone as parameters', async () => {
    api.get('/lawfirms/firm-a/matters/events', { events: [] });

    renderHook(() => useMatterEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(api.calls('GET')).toHaveLength(1));
    const [call] = api.calls('GET');
    expect(call.query.from).toEqual([WINDOW.from]);
    expect(call.query.to).toEqual([WINDOW.to]);
    expect(call.query.tz).toEqual(['America/New_York']);
  });

  it('does not refetch when the same firm, window and timezone render again', async () => {
    api.get('/lawfirms/firm-a/matters/events', { events: [{ id: 'evt-a' }] });

    const { result, rerender } = renderHook(() => useMatterEvents('firm-a', WINDOW), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.matterEvents).toHaveLength(1));

    rerender();
    rerender();

    // Same queryKey every render (lawFirmId, window bounds, and tz all
    // unchanged) - React Query must serve the cached entry, not refetch.
    expect(api.calls('GET')).toHaveLength(1);
  });

  describe('window/date boundaries', () => {
    it('issues a fresh request when navigating to a non-overlapping window', async () => {
      api.get('/lawfirms/firm-a/matters/events', (call) => ({
        events: call.query.from?.[0] === WINDOW.from ? [{ id: 'september-event' }] : [{ id: 'december-event' }],
      }));

      const { result, rerender } = renderHook(
        ({ window }: { window: typeof WINDOW }) => useMatterEvents('firm-a', window),
        { initialProps: { window: WINDOW }, wrapper: createQueryWrapper() },
      );
      await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['september-event']));

      rerender({ window: DECEMBER_WINDOW });

      await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['december-event']));
      // Two genuinely distinct windows must be two genuinely distinct requests -
      // a jump this large shares no days with the loaded window, so nothing
      // about the December cache entry can come from September's response.
      expect(api.calls('GET')).toHaveLength(2);
    });

    it('a stale answer for a window the user has since navigated away from never reaches the active state', async () => {
      let releaseSeptember: ((value: unknown) => void) | undefined;
      api.get('/lawfirms/firm-a/matters/events', (call) => {
        if (call.query.from?.[0] === WINDOW.from) {
          return new Promise((resolve) => { releaseSeptember = resolve; });
        }
        return { events: [{ id: 'december-event' }] };
      });

      const { result, rerender } = renderHook(
        ({ window }: { window: typeof WINDOW }) => useMatterEvents('firm-a', window),
        { initialProps: { window: WINDOW }, wrapper: createQueryWrapper() },
      );
      await waitFor(() => expect(releaseSeptember).toBeDefined());

      // Navigate to December while September's request is still in flight, then
      // let September's answer land late.
      rerender({ window: DECEMBER_WINDOW });
      await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['december-event']));

      await act(async () => {
        releaseSeptember?.({ events: [{ id: 'september-event' }] });
      });

      // September's late answer belongs to a query key nobody is subscribed to
      // any more (the component now reads December's key); it must not
      // overwrite the December data on screen.
      expect(result.current.matterEvents.map((e) => e.id)).toEqual(['december-event']);
    });
  });

  describe('timezone-specific query keys', () => {
    it('does not keep rendering the old zone\'s events after the viewer\'s timezone changes', async () => {
      api.get('/lawfirms/firm-a/matters/events', (call) => ({
        events: call.query.tz?.[0] === 'Asia/Karachi' ? [{ id: 'karachi-event' }] : [{ id: 'new-york-event' }],
      }));

      const { result, rerender } = renderHook(
        () => useMatterEvents('firm-a', WINDOW),
        { wrapper: createQueryWrapper() },
      );
      await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['new-york-event']));

      // Same firm, same window bounds - only the viewer's zone changed (e.g. the
      // OS travelled zones mid-session). The day-only window bounds are
      // resolved against a DIFFERENT UTC range server-side for a different
      // zone (see calendarRange.ts), so the cached New York answer is not a
      // valid stand-in for Karachi's.
      (getUserTimeZone as jest.Mock).mockReturnValue('Asia/Karachi');
      rerender();

      await waitFor(() => expect(result.current.matterEvents.map((e) => e.id)).toEqual(['karachi-event']));
      // Proves an actual second request went out for the new zone rather than
      // the component silently continuing to show New York's cached answer.
      expect(api.calls('GET')).toHaveLength(2);
    });
  });
});
