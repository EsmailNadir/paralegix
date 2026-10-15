/**
 * The firm billing hub: the workbench overview, and the tabs beneath it
 * (upcoming payments, invoices, time entries, recurring plans, reports,
 * rates & setup).
 *
 * This is the page every dollar the firm bills passes through, so the two
 * things worth failing loudly on are a load that silently reports "nothing to
 * bill" when the request actually failed, and a billing action that fails
 * with no sign to the user that it didn't happen. The services stay real and
 * only the transport is faked, so a wrong URL, a swallowed error, or a stale
 * response reaching a switched firm fails the spec instead of a stubbed hook
 * quietly returning whatever the test handed it.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/chargeCodes.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouter = {
  push: mockRouterPush,
  replace: mockRouterReplace,
  back: jest.fn(),
  forward: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/billing',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

// Stands in for the add-time modal so a spec can finish a save with "bill now".
jest.mock('@/components/billingComp/TimeEntryModal', () => ({
  __esModule: true,
  default: ({ open, onSuccess }: { open: boolean; onSuccess?: (r: unknown) => void }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSuccess?.({
            shouldBillNow: true,
            draftItem: { timeEntryId: 'te-1', contextType: 'matter', entityId: 'matter-1' },
          })
        }
      >
        Stub save and bill
      </button>
    ) : null,
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import BillingPage from '@/app/lawfirm/[lawFirmId]/billing/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { BillingWorkbenchResponse, UnbilledWorkResponse, BillingAttentionRow } from '@/types';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

/** apiMock's plain-body handler wants a `Record<string, unknown>`, which a
 * named response interface (no index signature) doesn't structurally satisfy
 * as a passed-in value, only as a fresh literal. The shape is unchanged. */
function toBody<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function summary(overrides: Partial<BillingWorkbenchResponse['summary']> = {}): BillingWorkbenchResponse['summary'] {
  return {
    overdueAmount: 0,
    overdueCount: 0,
    readyToBillCount: 0,
    readyToBillAmount: 0,
    activePlanCount: 0,
    plansReadyThisWeek: 0,
    unbilledHours: 0,
    awaitingCount: 0,
    awaitingAmount: 0,
    totalCollected: 0,
    totalInvoices: 0,
    uninvoicedTimeEntryCount: 0,
    ...overrides,
  };
}

function workbench(overrides: Partial<BillingWorkbenchResponse> = {}): BillingWorkbenchResponse {
  return {
    summary: summary(),
    attention: { rows: [], totalItems: 0 },
    collections: { overdueCount: 0, dueSoonCount: 0, partiallyPaidCount: 0 },
    plans: [],
    ...overrides,
  };
}

function unbilledWork(overrides: Partial<UnbilledWorkResponse> = {}): UnbilledWorkResponse {
  return {
    summary: { totalCount: 0, taskCount: 0, eventCount: 0 },
    items: [],
    totalItems: 0,
    ...overrides,
  };
}

/** A "ready to bill" recurring-plan-period row, the one attention-row kind with its own write action. */
function planRow(overrides: Partial<BillingAttentionRow & { item: Record<string, unknown> }> = {}): BillingAttentionRow {
  return {
    kind: 'plan',
    key: 'plan-row-1',
    item: {
      id: 'ready-1',
      itemType: 'plan_period',
      contextType: 'matter',
      entityId: 'matter-1',
      matterId: 'matter-1',
      matterName: 'Smith v. Jones',
      description: 'March retainer',
      amount: 1500,
      planId: 'plan-1',
      periodId: 'period-1',
    },
    ...overrides,
  } as BillingAttentionRow;
}

/** Every route the page fetches on mount, regardless of which tab is active. */
function seedBillingWorkspace(opts: {
  firmId?: string;
  workbench?: BillingWorkbenchResponse;
  unbilledWork?: UnbilledWorkResponse;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const base = `${API}/lawfirms/${firmId}/billing`;
  api.getExact(`${base}/workbench?attentionLimit=5&attentionPage=1`, toBody(opts.workbench ?? workbench()));
  api.getExact(`${base}/unbilled-work?limit=5&page=1`, toBody(opts.unbilledWork ?? unbilledWork()));
  api.getExact(`${base}/charge-codes?includeInactive=true`, { chargeCodes: [] });
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
  // The page opens on the "Upcoming payments" tab by default, which owns its
  // own paged, awaiting-only read of the firm's invoices independent of the
  // workbench summary above it.
  api.get(`/lawfirms/${firmId}/billing/invoices/firm`, { invoices: [], totalItems: 0 });
}

function renderBillingPage() {
  return renderWithProviders(<BillingPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

it.each(['matter', 'client'])('opens the same context composer when billing one %s entry', async (context) => {
  useSearchParamsMock.mockReturnValue(new URLSearchParams('view=time'));
  seedBillingWorkspace();
  api.get(`/lawfirms/${FIRM_A}/billing/time-entries/firm`, {
    timeEntries: [{ id: 'entry-1', context, contextType: context, entityId: `${context}-1`,
      matterId: context === 'matter' ? 'matter-1' : null,
      clientId: context === 'client' ? 'client-1' : null,
      matterName: 'Meridian Freight', clientName: 'Jane Smith', userId: 'test-uid', userName: 'Pat Attorney',
      hours: 1, date: '2026-09-01', amount: 200, rate: 200, billable: true, billingStatus: 'unbilled' }],
    totalItems: 1,
  });
  renderBillingPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Bill now' }));
  const segment = context === 'matter' ? 'matters' : 'clients';
  expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/${segment}/${context}-1/generate-invoice?draftType=time_entry&draftId=entry-1`);
});

describe('loaded content', () => {
  it('shows plan placeholders until the workbench resolves', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('view=plans'));
    seedBillingWorkspace({ workbench: workbench({ plans: [{ id: 'plan-1', name: 'Monthly retainer' }] as BillingWorkbenchResponse['plans'] }) });
    api.getExact(`${API}/lawfirms/${FIRM_A}/billing/workbench?attentionLimit=5&attentionPage=1`, {
      body: toBody(workbench({ plans: [{ id: 'plan-1', name: 'Monthly retainer' }] as BillingWorkbenchResponse['plans'] })),
      delayMs: 100,
    });

    renderBillingPage();

    expect(screen.getByRole('status', { name: 'Loading billing plans' })).toBeInTheDocument();
    expect(screen.queryByText('No billing plans yet')).not.toBeInTheDocument();
    expect(await screen.findByText('Monthly retainer')).toBeInTheDocument();
  });

  it('shows the real workbench figures and the actual attention row', async () => {
    seedBillingWorkspace({
      workbench: workbench({
        summary: summary({
          awaitingAmount: 2500, awaitingCount: 2, overdueAmount: 500, overdueCount: 1,
          totalCollected: 9000, totalInvoices: 6,
        }),
        attention: { rows: [planRow()], totalItems: 1 },
      }),
    });

    renderBillingPage();

    expect(await screen.findByText('Smith v. Jones', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('1 past due')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invoices/ })).toBeInTheDocument();
    // The row's action renders once for the mobile layout and once for
    // desktop (`sm:hidden` siblings) - both real, only one visible at a time
    // in a browser, but jsdom does not apply the layout that hides one.
    expect(screen.getAllByRole('button', { name: 'Create invoice' }).length).toBeGreaterThan(0);
  });
});

describe('a meaningful empty state', () => {
  it('reads as caught up, not broken, when nothing needs attention', async () => {
    seedBillingWorkspace();

    renderBillingPage();

    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.getByText('Nothing past due')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('tells the user their billing data failed to load rather than showing an empty workbench', async () => {
    seedBillingWorkspace();
    api.getExact(`${API}/lawfirms/${FIRM_A}/billing/workbench?attentionLimit=5&attentionPage=1`, {
      status: 500, body: { error: 'ledger service down' },
    });

    renderBillingPage();

    // Before the fix this silently rendered "You're all caught up" - identical
    // to a firm with genuinely nothing to bill.
    expect(await screen.findByRole('alert')).toHaveTextContent(/ledger service down/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real workbench once the retry succeeds', async () => {
    seedBillingWorkspace();
    let attempt = 0;
    api.getExact(`${API}/lawfirms/${FIRM_A}/billing/workbench?attentionLimit=5&attentionPage=1`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'ledger service down' } };
      return workbench({ summary: summary({ overdueAmount: 123, overdueCount: 1 }) });
    });

    renderBillingPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('$123.00')).toBeInTheDocument();
    expect(attempt).toBe(2);
  });
});

describe('narrow role behavior', () => {
  it('opens the workbench for a member explicitly granted invoice viewing', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    seedBillingWorkspace();

    renderBillingPage();

    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.queryByText('You do not have access to this area')).not.toBeInTheDocument();
  });

  it('withholds the financial workbench from a member without a financial role grant', async () => {
    grantBaselineMember();
    seedBillingWorkspace();
    renderBillingPage();
    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Billing' })).not.toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedBillingWorkspace();

    renderBillingPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
  });

  // Characterisation, not a bug fix: RequirePermission only gates what
  // RENDERS. BillingPage's data hooks run unconditionally at the top of the
  // component on every render, so a viewer the page refuses to show anything
  // to still causes every one of its requests to go out. The backend's own
  // authorization is the real boundary; this frontend gate is cosmetic.
  it('still fires every billing request for a viewer the page refuses to show anything to', async () => {
    grantOutsider();
    seedBillingWorkspace();

    renderBillingPage();

    await screen.findByText('You do not have access to this area');
    expect(api.callsTo('/billing/workbench')).toHaveLength(1);
    expect(api.callsTo('/billing/unbilled-work')).toHaveLength(1);
  });
});

describe('save and bill now from Log time', () => {
  async function logTimeAndBill(codes: string[]) {
    grantBaselineMember(codes);
    seedBillingWorkspace();
    renderBillingPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Log time' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stub save and bill' }));
  }

  it('does not open the composer for a member without billing.manageInvoices', async () => {
    await logTimeAndBill(['billing.viewInvoices', 'billing.manageTimeEntries']);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // One entry bills one context, so it opens that context's composer with the
  // entry preloaded, the same destination "bill now" has everywhere else.
  it('opens the composer for the entry\'s context for a member who can manage invoices', async () => {
    await logTimeAndBill(['billing.viewInvoices', 'billing.manageTimeEntries', 'billing.manageInvoices']);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      `/lawfirm/${FIRM_A}/matters/matter-1/generate-invoice?draftType=time_entry&draftId=te-1`,
    );
  });
});

describe('a successful action: creating an invoice from a ready plan period', () => {
  it('drafts the invoice and lands on Invoices', async () => {
    seedBillingWorkspace();
    api.postExact(
      `${API}/lawfirms/${FIRM_A}/billing/plans/plan-1/periods/period-1/create-draft`,
      { invoice: { id: 'inv-1' }, period: { id: 'period-1' } },
    );
    // First load answers with the seeded row; the refresh AFTER a successful
    // draft re-requests the same URL and gets the now-cleared workbench.
    api.getExact(
      `${API}/lawfirms/${FIRM_A}/billing/workbench?attentionLimit=5&attentionPage=1`,
      sequence(toBody(workbench({ attention: { rows: [planRow()], totalItems: 1 } })), toBody(workbench())),
    );

    renderBillingPage();

    await screen.findAllByText('March retainer');
    // Rendered once for mobile and once for desktop (see the "loaded content" note above).
    const createInvoice = screen.getAllByRole('button', { name: 'Create invoice' })[0];
    await userEvent.click(createInvoice);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(
      expect.stringContaining('view=invoices'),
      expect.anything(),
    ));
    expect(api.callsTo('/billing/plans/plan-1/periods/period-1/create-draft')).toHaveLength(1);
    // The refresh actually re-requested the workbench rather than only
    // updating local state (`handleRefresh` both invalidates the whole
    // `billing` query key AND explicitly refetches, so a second real request
    // is guaranteed - exactly how many is React Query's own business).
    await waitFor(() => expect(api.callsTo('/billing/workbench').length).toBeGreaterThanOrEqual(2));
  });
});

describe('a refused action: the draft request fails', () => {
  it('tells the user the invoice was not created, rather than failing silently', async () => {
    seedBillingWorkspace({
      workbench: workbench({ attention: { rows: [planRow()], totalItems: 1 } }),
    });
    api.postExact(
      `${API}/lawfirms/${FIRM_A}/billing/plans/plan-1/periods/period-1/create-draft`,
      { status: 409, body: { error: 'This period already has a draft invoice' } },
    );

    renderBillingPage();

    await screen.findAllByText('March retainer');
    // Rendered once for mobile and once for desktop (see the "loaded content" note above).
    const createInvoice = screen.getAllByRole('button', { name: 'Create invoice' })[0];
    await userEvent.click(createInvoice);

    // Before the fix, `handleCreatePlanDraft`'s rejection was voided
    // (`void handleCreatePlanDraft(item)`) with no catch anywhere in the
    // chain: the button stopped spinning and nothing else told the user the
    // draft was never created.
    expect(await screen.findByText(/already has a draft invoice/i)).toBeInTheDocument();
    // And it must NOT have navigated to Invoices as though it had succeeded.
    expect(mockRouterReplace).not.toHaveBeenCalledWith(
      expect.stringContaining('view=invoices'),
      expect.anything(),
    );
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s workbench', async () => {
    api.getExact(`${API}/lawfirms/${FIRM_A}/billing/workbench?attentionLimit=5&attentionPage=1`, {
      delayMs: 200,
      body: workbench({ summary: summary({ overdueAmount: 90000, overdueCount: 9 }) }),
    });
    seedBillingWorkspace({ firmId: FIRM_A });
    seedBillingWorkspace({
      firmId: FIRM_B,
      workbench: workbench({ summary: summary({ overdueAmount: 1000, overdueCount: 1 }) }),
    });

    const { rerender } = renderBillingPage();

    // Firm A's slow request is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<BillingPage />);

    await waitFor(() => expect(screen.getByText('1 past due')).toBeInTheDocument());
    const overdueTile = screen.getByText('Overdue').closest('button')!;
    expect(within(overdueTile).getByText('$1,000.00')).toBeInTheDocument();

    // Even once firm A's slow response finally arrives, it must not overwrite
    // the figure now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(within(overdueTile).getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.queryByText('$90,000.00')).not.toBeInTheDocument();
  });
});
