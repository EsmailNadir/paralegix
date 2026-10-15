/**
 * Offline contract for `dashboardHooks/useDashboardSummary.ts`: the delayed
 * automatic refetch after a summary arrives carrying `sectionErrors`.
 *
 * A per-section failure rides inside an HTTP 200, so React Query never treats
 * it as an error. The hook refetches once, after a short delay, and then leaves
 * the widgets' manual Retry to the user.
 *
 * Call counts are transport GETs, and `dashboardService.getDashboardSummary`
 * already retries ONCE immediately when a response has section errors. So one
 * query run that keeps failing costs TWO GETs, and a run that comes back clean
 * on its first request costs ONE.
 */
jest.unmock('@/services/dashboard.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';

import {
  useDashboardSummary,
  DASHBOARD_SECTION_RETRY_DELAY_MS,
} from '@/hooks/dashboardHooks/useDashboardSummary';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

import { setupApiMock, sequence } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const SUMMARY_A = 'http://localhost:5001/api/lawfirms/firm-a/dashboard-summary';
const SUMMARY_B = 'http://localhost:5001/api/lawfirms/firm-b/dashboard-summary';

const makeSummary = (overrides: Record<string, unknown> = {}) => ({
  stats: { openMatters: 7 },
  recentMatters: [],
  upcomingTasks: [],
  myAssignments: null,
  recentConversations: [],
  permissions: { matters: true, tasks: true },
  ...overrides,
});

const FAILED_SECTIONS = { matters: true, taskStats: true };
const FAILED = makeSummary({ sectionErrors: FAILED_SECTIONS });
const CLEAN = makeSummary({ sectionErrors: {} });

const api = setupApiMock();

function getsTo(url: string) {
  return api.calls('GET').filter((call) => call.url === url).length;
}

// Runs the pending delay timer and lets the refetch it starts settle.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  // The service's immediate second GET trips the dev-only duplicate-fetch
  // warning, which is expected here and would only bury real output.
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  jest.useFakeTimers();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

describe('useDashboardSummary: automatic refetch after section errors', () => {
  it('refetches once after the delay, not before, and keeps the rendered data meanwhile', async () => {
    api.getExact(SUMMARY_A, sequence(FAILED, FAILED, CLEAN));

    const { result } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    expect(getsTo(SUMMARY_A)).toBe(2);

    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS - 1);
    expect(getsTo(SUMMARY_A)).toBe(2);

    await advance(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeDefined();
    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual({}));
    expect(getsTo(SUMMARY_A)).toBe(3);
  });

  it('does not refetch a second time when the automatic retry still has section errors', async () => {
    api.getExact(SUMMARY_A, sequence(FAILED));

    const { result } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS);
    await waitFor(() => expect(getsTo(SUMMARY_A)).toBe(4));
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS * 10);
    expect(getsTo(SUMMARY_A)).toBe(4);
    expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS);
  });

  it('auto-retries again for a new failure after a clean response ended the episode', async () => {
    // failed run (2), auto retry comes back clean (1), manual refetch fails (2),
    // then the second episode's auto retry (2).
    api.getExact(SUMMARY_A, sequence(FAILED, FAILED, CLEAN, FAILED, FAILED, FAILED));

    const { result } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS);
    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual({}));
    expect(getsTo(SUMMARY_A)).toBe(3);

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    expect(getsTo(SUMMARY_A)).toBe(5);

    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS);
    await waitFor(() => expect(getsTo(SUMMARY_A)).toBe(7));
  });

  it('does not refetch when sectionErrors is empty', async () => {
    api.getExact(SUMMARY_A, CLEAN);

    const { result } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS * 10);
    expect(getsTo(SUMMARY_A)).toBe(1);
  });

  it('does not refetch when sectionErrors is absent', async () => {
    api.getExact(SUMMARY_A, makeSummary());

    const { result } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS * 10);
    expect(getsTo(SUMMARY_A)).toBe(1);
  });

  it('cancels the pending refetch on unmount', async () => {
    api.getExact(SUMMARY_A, FAILED);

    const { result, unmount } = renderHook(() => useDashboardSummary('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    unmount();
    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS * 10);
    expect(getsTo(SUMMARY_A)).toBe(2);
  });

  it('cancels the pending refetch for the previous firm when the law firm changes', async () => {
    api.getExact(SUMMARY_A, FAILED);
    api.getExact(SUMMARY_B, CLEAN);

    const { result, rerender } = renderHook(
      ({ firmId }: { firmId: string }) => useDashboardSummary(firmId),
      { wrapper: createQueryWrapper(), initialProps: { firmId: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual(FAILED_SECTIONS));
    rerender({ firmId: 'firm-b' });
    await waitFor(() => expect(result.current.data?.sectionErrors).toEqual({}));

    await advance(DASHBOARD_SECTION_RETRY_DELAY_MS * 10);
    expect(getsTo(SUMMARY_A)).toBe(2);
    expect(getsTo(SUMMARY_B)).toBe(1);
  });
});
