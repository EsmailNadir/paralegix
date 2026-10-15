/**
 * Offline contract coverage for the calendar's window fan-out, counted at the
 * transport.
 *
 * The defect this pins: opening the calendar mounted five window reads and then,
 * as soon as they settled, warmed BOTH neighbouring months with five more reads
 * each, all issued in the same tick. That is about thirteen requests in flight
 * at once and fifteen per calendar open, against an API instance holding twelve
 * Postgres pool connections, so one person opening a month could stall everyone
 * else on the firm.
 *
 * The current month must still load in one go - the user is looking at it. The
 * warm-up is speculative, so it runs one neighbour at a time.
 *
 * Each window is now one `calendar-feed` request that fills the five per-section
 * caches. The sections keep their own endpoints for what the feed cannot cover:
 * a section the member may not see (null in the feed), a feed that failed, and
 * an invalidation after a mutation, which re-reads only the section it names.
 */
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/calendarEvents.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';

import useCalendarWindowData from '@/hooks/calendarHooks/useCalendarWindowData';
import { getCalendarWindow, neighbourWindows } from '@/lib/utils/calendarWindow';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock, type RecordedCall } from '../support/apiMock';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';

/** Held in a module constant for the same reason the hook's doc comment demands
 * a stable `anchor`: a fresh dayjs per render would re-run the warm-up effect. */
const ANCHOR = dayjs('2026-05-15');
const CURRENT = getCalendarWindow(ANCHOR);
const [PREVIOUS, NEXT] = neighbourWindows(ANCHOR);

const PAYMENT_DATES_PATH = '/invoices/calendar-payment-dates';
const FEED_PATH = '/calendar-feed';
const SECTION_PATHS = ['/matters/events', '/clients/events', '/calendar-events', '/tasks', PAYMENT_DATES_PATH];

const api = setupApiMock();
let neighbourGate: { promise: Promise<void>; open: () => void };

function deferred() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

let queryClient: QueryClient;

function createWrapper() {
  queryClient = makeTestQueryClient();
  // Sections are fresh for a minute, as they are in the app, so a feed-filled
  // entry is read from cache rather than re-requested the moment it mounts.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, gcTime: 60_000 } });
  const client = queryClient;
  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * Which calendar window a recorded request was for.
 *
 * Four of the five datasets send `from`; the task read calls the same bound
 * `dueFrom`, because the server treats it as a due-date filter rather than a
 * range.
 */
function windowOf(call: RecordedCall): string | undefined {
  return call.query.from?.[0] ?? call.query.dueFrom?.[0];
}

function currentWindowCalls(): RecordedCall[] {
  return api.calls().filter((call) => windowOf(call) === CURRENT.from);
}

/** Every read for a month the user is NOT looking at: the speculative warm-up. */
function warmCalls(): RecordedCall[] {
  return api.calls().filter((call) => {
    const from = windowOf(call);
    return from !== undefined && from !== CURRENT.from;
  });
}

/**
 * Answer the current window immediately and HOLD every neighbour read open, so
 * a request that has been issued stays in flight and counting the recorded
 * calls counts what is concurrently outstanding.
 */
type FeedBody = Record<'matterEvents' | 'clientEvents' | 'calendarEvents' | 'tasks' | 'paymentDates', unknown>;

function fullFeed(overrides: Partial<FeedBody> = {}): FeedBody {
  return {
    matterEvents: { events: [], totalEvents: 0 },
    clientEvents: { events: [], totalEvents: 0 },
    calendarEvents: { events: [], totalEvents: 0 },
    tasks: { tasks: [], totalTasks: 0 },
    paymentDates: { paymentDates: [] },
    ...overrides,
  };
}

function seedCalendarWindows(feed: FeedBody | ((call: RecordedCall) => unknown) = fullFeed()) {
  const answer = (body: unknown) => async (call: RecordedCall) => {
    if (windowOf(call) !== CURRENT.from) await neighbourGate.promise;
    return typeof body === 'function' ? (body as (c: RecordedCall) => unknown)(call) : body;
  };
  api.get(FEED_PATH, answer(feed));
  api.get('/matters/events', answer({ events: [] }));
  api.get('/clients/events', answer({ events: [], totalEvents: 0 }));
  api.get('/calendar-events', answer({ events: [] }));
  api.get('/tasks', answer({ tasks: [], totalTasks: 0 }));
  api.get(PAYMENT_DATES_PATH, answer({ paymentDates: [] }));
}

function sectionCalls(): RecordedCall[] {
  return api.calls().filter((call) => SECTION_PATHS.some((path) => call.pathname.endsWith(path)));
}

/** Long enough for anything the warm-up was going to fire in one go to land. */
function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  neighbourGate = deferred();
});

afterEach(() => {
  // Before restore: a held request that never settles leaks into the next spec.
  neighbourGate.open();
});

describe('useCalendarWindowData offline contract', () => {
  it('loads the month on screen in one go, with no neighbour read racing it', async () => {
    seedCalendarWindows();

    const { result } = renderHook(
      () => useCalendarWindowData(FIRM_A, ANCHOR),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The five datasets the grid draws arrive in ONE feed request for the
    // anchor's window, and no section asks its own endpoint again.
    expect(currentWindowCalls()).toHaveLength(1);
    expect(currentWindowCalls()[0].pathname).toBe(`/api/lawfirms/${FIRM_A}${FEED_PATH}`);
    expect(currentWindowCalls()[0].query).toEqual(expect.objectContaining({ from: [CURRENT.from], to: [CURRENT.to] }));
    expect(sectionCalls()).toHaveLength(0);
    expect(warmCalls()).toHaveLength(0);
  });

  it('warms one neighbour at a time, one feed request each, never both months at once', async () => {
    seedCalendarWindows();

    const { result } = renderHook(
      () => useCalendarWindowData(FIRM_A, ANCHOR),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(() => expect(warmCalls().length).toBeGreaterThan(0), { timeout: 3000 });
    // Every held request is still outstanding, so this count IS the concurrency:
    // one neighbour's feed, not both.
    await settle();
    expect(warmCalls()).toHaveLength(1);
    expect(warmCalls()[0].pathname.endsWith(FEED_PATH)).toBe(true);

    neighbourGate.open();

    // Both neighbours do get warmed eventually, with one request each.
    await waitFor(() => expect(warmCalls()).toHaveLength(2), { timeout: 3000 });
    await settle();
    expect(warmCalls()).toHaveLength(2);
    expect(warmCalls().every((call) => call.pathname.endsWith(FEED_PATH))).toBe(true);
    expect(new Set(warmCalls().map(windowOf))).toEqual(new Set([PREVIOUS.from, NEXT.from]));
  });

  it('never warms payment dates for a month the user is not on', async () => {
    seedCalendarWindows();
    neighbourGate.open();

    const { result } = renderHook(
      () => useCalendarWindowData(FIRM_A, ANCHOR),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(warmCalls()).toHaveLength(2), { timeout: 3000 });
    await settle();

    // A neighbour's payment markers ride along in its single feed request; no
    // separate payment-dates read is spent on a month the user is not on.
    expect(warmCalls()).toHaveLength(2);
    expect(warmCalls().filter((call) => call.pathname.endsWith(PAYMENT_DATES_PATH))).toHaveLength(0);
  });

  it('asks for nothing at all without billing permission beyond the feed the grid needs', async () => {
    seedCalendarWindows(fullFeed({ paymentDates: null }));

    const { result } = renderHook(
      () => useCalendarWindowData(FIRM_A, ANCHOR, { includePaymentDates: false }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await settle();
    expect(currentWindowCalls()).toHaveLength(1);
    expect(api.callsTo(PAYMENT_DATES_PATH)).toHaveLength(0);
    expect(result.current.paymentDates).toEqual([]);
  });

  it('re-reads the window for the new firm on a switch, and hands back nothing from the old one', async () => {
    seedCalendarWindows();
    neighbourGate.open();

    const { result, rerender } = renderHook(
      ({ firmId }: { firmId: string }) => useCalendarWindowData(firmId, ANCHOR),
      { initialProps: { firmId: FIRM_A }, wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ firmId: FIRM_B });

    // `keepPreviousData` still holds firm A's results in each underlying query,
    // so the hook must mask them rather than render another firm's schedule.
    expect(result.current.rangeUnloaded).toBe(true);
    expect(result.current.matterEvents).toEqual([]);
    expect(result.current.clientEvents).toEqual([]);
    expect(result.current.externalEvents).toEqual([]);
    expect(result.current.tasks).toEqual([]);
    expect(result.current.paymentDates).toEqual([]);

    await waitFor(() => expect(result.current.fetching).toBe(false));
    expect(api.calls().filter((call) => call.pathname === `/api/lawfirms/${FIRM_B}${FEED_PATH}`).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('draws what the feed returned, shaped as the section endpoints were', async () => {
    seedCalendarWindows(fullFeed({
      matterEvents: { events: [{ id: 'm1', status: 'upcoming' }, { id: 'm2', status: 'cancelled' }], totalEvents: 2 },
      clientEvents: { events: [{ id: 'c1', status: 'cancelled' }, { id: 'c2', status: 'completed' }], totalEvents: 2 },
      calendarEvents: { events: [{ id: 'x1' }], totalEvents: 1 },
      tasks: { tasks: [{ id: 't1' }], totalTasks: 1 },
      paymentDates: { paymentDates: [{ id: 'p1' }] },
    }));
    neighbourGate.open();

    const { result } = renderHook(() => useCalendarWindowData(FIRM_A, ANCHOR), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(['t1']));
    expect(result.current.matterEvents.map((e) => e.id)).toEqual(['m1']);
    expect(result.current.clientEvents.map((e) => e.id)).toEqual(['c2']);
    expect(result.current.externalEvents.map((e) => e.id)).toEqual(['x1']);
    expect(result.current.paymentDates.map((p) => p.id)).toEqual(['p1']);
    expect(sectionCalls()).toHaveLength(0);
  });

  it('reads a section the member may not see from its own endpoint, exactly as before the feed', async () => {
    seedCalendarWindows(fullFeed({ tasks: null }));
    api.get('/tasks', { status: 403, body: { error: 'You do not have permission to view tasks' } });

    const { result } = renderHook(() => useCalendarWindowData(FIRM_A, ANCHOR), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/permission to view tasks/i));
    expect(result.current.tasks).toEqual([]);
    expect(currentWindowCalls().filter((call) => call.pathname.endsWith('/tasks'))).toHaveLength(1);
    expect(currentWindowCalls().filter((call) => !call.pathname.endsWith('/tasks') && !call.pathname.endsWith(FEED_PATH)))
      .toHaveLength(0);
  });

  it('falls back to every section endpoint when the feed itself fails', async () => {
    seedCalendarWindows({ status: 500, body: { error: 'feed unavailable' } } as never);
    api.get('/tasks', { tasks: [{ id: 't-fallback' }], totalTasks: 1 });

    const { result } = renderHook(() => useCalendarWindowData(FIRM_A, ANCHOR), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(['t-fallback']));
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(currentWindowCalls().filter((c) => !c.pathname.endsWith(FEED_PATH))).toHaveLength(5));
  });

  it('re-reads only the invalidated section from its own endpoint after a mutation', async () => {
    seedCalendarWindows();
    neighbourGate.open();

    const { result } = renderHook(() => useCalendarWindowData(FIRM_A, ANCHOR), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(warmCalls()).toHaveLength(2), { timeout: 3000 });
    await settle();
    const feedsBefore = api.callsTo(FEED_PATH).length;

    api.get('/tasks', { tasks: [{ id: 't-new' }], totalTasks: 1 });
    await queryClient.invalidateQueries({ queryKey: ['tasks', FIRM_A] });

    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(['t-new']));
    expect(currentWindowCalls().filter((call) => call.pathname.endsWith('/tasks'))).toHaveLength(1);
    expect(sectionCalls()).toHaveLength(1);
    expect(api.callsTo(FEED_PATH)).toHaveLength(feedsBefore);
  });

  it('does not overwrite a section invalidated while the feed was in flight', async () => {
    let releaseFeed!: () => void;
    const feedHeld = new Promise<void>((resolve) => { releaseFeed = resolve; });
    seedCalendarWindows(async () => {
      await feedHeld;
      return fullFeed({ tasks: { tasks: [{ id: 't-before-edit' }], totalTasks: 1 } });
    });
    api.get('/tasks', { tasks: [{ id: 't-after-edit' }], totalTasks: 1 });

    const { result } = renderHook(() => useCalendarWindowData(FIRM_A, ANCHOR), { wrapper: createWrapper() });
    await waitFor(() => expect(api.callsTo(FEED_PATH)).toHaveLength(1));

    await queryClient.invalidateQueries({ queryKey: ['tasks', FIRM_A] });
    releaseFeed();

    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(['t-after-edit']));
  });
});
