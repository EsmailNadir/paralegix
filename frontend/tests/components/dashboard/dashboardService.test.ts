/**
 * The firm dashboard summary aggregate service, tested OFFLINE against a fake transport.
 *
 * Unmocks dashboard.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, payload unwrapping, section-error silent retry policy,
 * and fallback resiliency without a running backend.
 */
jest.unmock('@/services/dashboard.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock, sequence } from '../../support/apiMock';
import dashboardService from '@/services/dashboard.service';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';

const makeSummary = (overrides: Record<string, any> = {}) => ({
  stats: {
    openMatters: 12,
    totalMatters: 20,
    closedMatters: 8,
    pendingTasks: 5,
    completedTasks: 15,
    totalTasks: 20,
    upcomingDeadlines: 3,
    overdueTasks: 1,
    unreadMessages: 2,
    conversationCount: 4,
    teamSize: 3,
    outstandingArCents: 50000,
    overdueInvoiceCents: 10000,
    overdueInvoiceCount: 1,
    collectedThisMonthCents: 25000,
    unbilledWipCents: 15000,
    unbilledHours: 4.5,
    hoursToday: 2.0,
    hoursThisWeek: 18.5,
  },
  recentMatters: [],
  upcomingTasks: [],
  myAssignments: null,
  recentConversations: [],
  permissions: {
    matters: true,
    tasks: true,
    messaging: true,
    members: true,
    signatures: true,
    billing: true,
    timeEntries: true,
    calendar: true,
    clients: true,
  },
  ...overrides,
});

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('dashboardService.getDashboardSummary', () => {
  it('requests the firm dashboard summary endpoint without retrying when no section errors exist', async () => {
    const summary = makeSummary();
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/dashboard-summary`, summary);

    const res = await dashboardService.getDashboardSummary(LAW_FIRM_ID);

    expect(res.stats.openMatters).toBe(12);
    expect(res.stats.outstandingArCents).toBe(50000);

    const calls = api.calls('GET');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/dashboard-summary`);
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/dashboard-summary`, makeSummary());

    await dashboardService.getDashboardSummary(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/dashboard-summary`);
  });

  it('silently retries once when the initial response contains section errors', async () => {
    const withError = makeSummary({ sectionErrors: { financial: true } });
    const recovered = makeSummary({ sectionErrors: {} });

    api.get(`/api/lawfirms/${LAW_FIRM_ID}/dashboard-summary`, sequence(withError, recovered));

    const res = await dashboardService.getDashboardSummary(LAW_FIRM_ID);

    expect(res.sectionErrors).toEqual({});
    const calls = api.calls('GET');
    expect(calls).toHaveLength(2);
  });

  it('falls back to the initial response if the retry throws an error', async () => {
    const withError = makeSummary({ sectionErrors: { financial: true } });

    api.get(
      `/api/lawfirms/${LAW_FIRM_ID}/dashboard-summary`,
      sequence(withError, { status: 500, body: { error: 'Internal server error' } })
    );

    const res = await dashboardService.getDashboardSummary(LAW_FIRM_ID);

    expect(res.sectionErrors).toEqual({ financial: true });
    const calls = api.calls('GET');
    expect(calls).toHaveLength(2);
  });
});
