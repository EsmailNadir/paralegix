/**
 * The matter detail page: the overview tab, the tab strip, and the single-matter
 * delete flow, driven through the REAL matters/tasks services against a faked
 * transport.
 *
 * Unlike the billing hub and trust overview (fixed earlier in this pass), this
 * page manages its own matter/tasks/clients state with plain `useState` +
 * `useEffect` instead of React Query, so it gets none of React Query's
 * automatic per-key staleness protection. That makes the "context change while
 * a request is pending" case (switching from one matter to another while the
 * first is still loading) the one most likely to have its own, page-specific
 * bug rather than a shared one.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

// The Billing tab loads its invoices, time entries and flat fees through the
// billing service; empty lists let the narrow-role cases open the tab.
jest.mock('@/services/billing.service', () =>
  require('../../../support/mockServiceModule').mockServiceModule({
    listInvoices: jest.fn(async () => []),
    listTimeEntries: jest.fn(async () => []),
    listFlatFees: jest.fn(async () => []),
    removeFlatFee: jest.fn(async () => ({})),
  }),
);

// The Billing tab's trust callout reads the firm balance report; a recorded
// mock lets a spec assert whether the request was made at all.
jest.mock('@/services/trust.service', () =>
  require('../../../support/mockServiceModule').mockServiceModule({
    getAllBalances: jest.fn(async () => []),
  }),
);

// The Notes tab pulls in `isomorphic-dompurify`, whose server-side (jsdom)
// branch requires the real `jsdom` package - which drags in an ESM-only
// dependency Jest's transform can't parse. Swap in the plain browser
// `dompurify` package, matching `tests/components/notes/NotesSection.test.tsx`.
jest.mock('isomorphic-dompurify', () => require('dompurify'));

const mockRouterPush = jest.fn();
const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/matters/matter-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

// Record what the page asks the courts and charge-code hooks for, while keeping
// their real behaviour, so a spec can see whether the closed modals' picker data
// was requested.
const mockUseCourtsArgs = jest.fn();
const mockUseChargeCodesArgs = jest.fn();
jest.mock('@/hooks/courtHooks/useCourts', () => {
  const actual = jest.requireActual('@/hooks/courtHooks/useCourts');
  return {
    __esModule: true,
    default: (...args: unknown[]) => {
      mockUseCourtsArgs(...args);
      return actual.default(...args);
    },
  };
});
jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () => {
  const actual = jest.requireActual('@/hooks/chargeCodeHooks/useChargeCodes');
  return {
    __esModule: true,
    default: (...args: unknown[]) => {
      mockUseChargeCodesArgs(...args);
      return actual.default(...args);
    },
  };
});

// Stands in for the add-time modal so a spec can finish a save with "bill now".
// `mockBillNowDraft` is the draft the save hands back; a spec reassigns it to
// model an entry the modal filed under a different context.
const DEFAULT_BILL_NOW_DRAFT = { timeEntryId: 'te-1', matterId: 'matter-1' };
let mockBillNowDraft: Record<string, unknown> = DEFAULT_BILL_NOW_DRAFT;
jest.mock('@/components/billingComp/TimeEntryModal', () => ({
  __esModule: true,
  default: ({ open, onSuccess }: { open: boolean; onSuccess?: (r: unknown) => void }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSuccess?.({ shouldBillNow: true, draftItem: mockBillNowDraft })
        }
      >
        Stub save and bill
      </button>
    ) : null,
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createLawFirmQueryClient } from '@/lib/query/lawFirmQueryClient';
import userEvent from '@testing-library/user-event';

import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import ViewMatterPage from '@/app/lawfirm/[lawFirmId]/matters/[matterId]/page';
import billingService from '@/services/billing.service';
import trustService from '@/services/trust.service';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { holdResponse } from '../../../support/deferred';
import { grantBaselineMember, grantPermissions, resetPermissions } from '../../../support/permissions';
import { mockPermissionsValue } from '../../../setup';
import type { Matter } from '@/types';

const FIRM_A = 'firm-a';
const MATTER_1 = 'matter-1';
const MATTER_2 = 'matter-2';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function matterUrl(matterId: string, firmId: string = FIRM_A): string {
  return `${API}/lawfirms/${firmId}/matters/${matterId}`;
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: MATTER_1,
    name: 'Smith v. Jones',
    status: 'active',
    matterNumber: 'M-1001',
    practiceAreaName: 'Litigation',
    courtName: 'Superior Court',
    leadUserName: 'Pat Attorney',
    billingMethod: 'hourly',
    createdAt: '2025-01-01T00:00:00.000Z',
    members: [],
    totalNotes: 0,
    ...overrides,
  } as Matter;
}

/**
 * The tasks, clients and firm-users reads the page fires unconditionally on
 * mount (they're plain top-level hooks, run regardless of whether the matter
 * read itself succeeds), plus the Overview's pipeline, custom-field and
 * activity reads, which the page starts alongside the matter read.
 */
function seedIncidentalReads(firmId: string, matterId: string) {
  // The tz query param varies with the test host's timezone, so match by suffix.
  api.get(`/tasks/matter/${matterId}`, { tasks: [] });
  api.getExact(`${matterUrl(matterId, firmId)}/clients`, { clients: [] });
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
  api.get('/matter-stage-pipelines', { pipelines: [] });
  api.get('/matter-field-defs', { fieldDefs: [] });
  api.get(`/matters/${matterId}/activity`, { activity: [], totalItems: 0 });
}

/** Every route the detail page fetches on mount for a given matter, regardless of tab. */
function seedMatterWorkspace(opts: { firmId?: string; matterId?: string; matter?: Matter } = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const matterId = opts.matterId ?? MATTER_1;
  api.getExact(matterUrl(matterId, firmId), opts.matter ?? matter({ id: matterId }));
  seedIncidentalReads(firmId, matterId);
  // The always-mounted (but closed) "Add Hours" modal resolves its preset
  // matter target through the matters lookup endpoint - not the subject of
  // these specs, but a REAL request once `matters.service` is unmocked.
  api.get('/matters/lookup', { items: [], hasMore: false });
}

function renderMatterPage() {
  return renderWithProviders(<ViewMatterPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, matterId: MATTER_1 });
  mockBillNowDraft = DEFAULT_BILL_NOW_DRAFT;
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real matter information', async () => {
    seedMatterWorkspace({ matter: matter({ practiceAreaName: 'Family Law', courtName: 'County Court' }) });

    renderMatterPage();

    expect(await screen.findByRole('heading', { name: /Smith v\. Jones/ })).toBeInTheDocument();
    expect(screen.getByText('Family Law')).toBeInTheDocument();
    expect(screen.getByText('County Court')).toBeInTheDocument();
    expect(screen.getByText('Pat Attorney')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('reflects the real task count on the Tasks tab', async () => {
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, {
      tasks: [
        { id: 't1', title: 'File motion', status: 'open' },
        { id: 't2', title: 'Serve papers', status: 'open' },
      ],
    });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(await screen.findByRole('button', { name: /Tasks.*2/ })).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says there is nothing upcoming, rather than leaving the panels blank', async () => {
    seedMatterWorkspace();

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.getByText('No upcoming events')).toBeInTheDocument();
    expect(screen.getByText('No upcoming tasks')).toBeInTheDocument();
  });
});

describe('the Overview tab\'s Upcoming Tasks widget', () => {
  it('opens the Tasks tab when an item card itself is clicked, not only "View all"', async () => {
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, {
      tasks: [
        { id: 't1', title: 'Draft and file the responsive pleading', status: 'open', dueDate: '2099-01-15', priority: 'high' },
      ],
    });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    // The Tasks tab isn't showing yet: its search box isn't on screen.
    expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Draft and file the responsive pleading'));

    // Landing on the real Tasks tab, not just re-showing the same title text
    // still sitting in the Overview widget.
    expect(await screen.findByPlaceholderText('Search tasks...')).toBeInTheDocument();
  });
});

describe('the Tasks tab\'s New Task button', () => {
  it('opens the create-task modal and posts the new task against this matter', async () => {
    seedMatterWorkspace();
    api.post('/tasks', { task: { id: 't-new', title: 'Serve interrogatories', status: 'open' } });
    // The modal's dependency picker (step 3) looks up other tasks to depend on.
    api.get('/tasks/lookup', { items: [], hasMore: false });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    // The Overview tab's activity feed also has a "Tasks" filter chip; the tab
    // strip's own "Tasks" tab is the first one in document order.
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);

    await userEvent.click(await screen.findByRole('button', { name: 'New Task' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create a New Task' });
    await userEvent.type(within(dialog).getByLabelText('Title *'), 'Serve interrogatories');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a New Task' })).not.toBeInTheDocument());
    const posted = api.callsTo('/tasks').filter((c) => c.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({ title: 'Serve interrogatories', matterId: MATTER_1 });
  });
});

describe('the Tasks tab\'s Edit action', () => {
  it('opens the edit-task modal pre-filled and saves the change', async () => {
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, {
      tasks: [{ id: 't1', taskId: 't1', title: 'Serve interrogatories', status: 'open' }],
    });
    api.put(`/tasks/t1`, { task: { id: 't1', title: 'Serve interrogatories - urgent', status: 'open' } });
    // The modal's dependency picker (step 3) looks up other tasks to depend on.
    api.get('/tasks/lookup', { items: [], hasMore: false });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);
    await screen.findByText('Serve interrogatories');

    await userEvent.click(screen.getByRole('button', { name: 'Edit Serve interrogatories' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Task' });
    const titleInput = within(dialog).getByLabelText('Title *');
    expect(titleInput).toHaveValue('Serve interrogatories');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Serve interrogatories - urgent');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Task' })).not.toBeInTheDocument());
    const updated = api.callsTo('/tasks/t1').filter((c) => c.method === 'PUT');
    expect(updated).toHaveLength(1);
    expect(updated[0].body).toMatchObject({ title: 'Serve interrogatories - urgent' });
  });
});

describe('the Edit Task modal\'s duplicate-title check', () => {
  it('scopes the check to this matter, so a same-titled task on another matter is not a false positive', async () => {
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, {
      tasks: [{ id: 't1', taskId: 't1', title: 'Assemble the exhibit index', status: 'open', matterId: MATTER_1 }],
    });
    // Mimics the real backend: an unscoped exact-name search would also surface
    // a same-titled task that lives on a completely different matter - the
    // scenario that produced the false "already exists" warning on this task's
    // own unchanged title. Scoped by matterId, only this task's own row comes back.
    api.get('/tasks/lookup', (call) => {
      const scopedToThisMatter = call.query.matterId?.[0] === MATTER_1;
      return {
        items: scopedToThisMatter
          ? [{ id: 't1', label: 'Assemble the exhibit index' }]
          : [
              { id: 't1', label: 'Assemble the exhibit index' },
              { id: 't-other-matter', label: 'Assemble the exhibit index' },
            ],
        hasMore: false,
      };
    });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);
    await screen.findByText('Assemble the exhibit index');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Assemble the exhibit index' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Task' });
    // Wait past the 300ms debounce for the lookup to resolve, then assert no
    // false "already exists" warning renders for the task's own untouched title.
    await waitFor(() => {
      const lookupCalls = api.callsTo('/tasks/lookup');
      expect(lookupCalls.length).toBeGreaterThan(0);
    });
    await waitFor(() => expect(within(dialog).queryByText(/already exists/i)).not.toBeInTheDocument());

    const lookupCalls = api.callsTo('/tasks/lookup');
    expect(lookupCalls[0].query.matterId).toEqual([MATTER_1]);
  });
});

describe('an API failure, with retry', () => {
  it('shows the real error rather than a blank page', async () => {
    seedIncidentalReads(FIRM_A, MATTER_1);
    api.getExact(matterUrl(MATTER_1), { status: 500, body: { error: 'matters service unavailable' } });

    renderMatterPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/matters service unavailable/i);
  });

  it('offers a way back to the matters list', async () => {
    seedIncidentalReads(FIRM_A, MATTER_1);
    api.getExact(matterUrl(MATTER_1), { status: 500, body: { error: 'matters service unavailable' } });

    renderMatterPage();

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /Back to Matters/i })).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('shows a baseline member the matter read-only, with no edit or delete controls', async () => {
    grantBaselineMember();
    seedMatterWorkspace();

    renderMatterPage();

    expect(await screen.findByRole('heading', { name: /Smith v\. Jones/ })).toBeInTheDocument();
    // matters.view is baseline; matters.update/matters.delete are not.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  // Create Invoice opens the composer, which needs billing.manageInvoices.
  // Red if the matter Billing tab renders the button without it.
  it('hides Create Invoice on the Billing tab from a member who cannot manage invoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries']);
    seedMatterWorkspace();
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    // The tab header proves the tab rendered.
    expect(await screen.findByRole('button', { name: 'View Invoices' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Invoice' })).not.toBeInTheDocument();
  });

  it('offers Create Invoice to a member who can manage invoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries', 'billing.manageInvoices']);
    seedMatterWorkspace();
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    expect(await screen.findByRole('button', { name: 'Create Invoice' })).toBeInTheDocument();
  });
});

describe('the Billing and Time Tracking tabs without billing read permissions', () => {
  const billingCalls = () => [
    billingService.listInvoices,
    billingService.listTimeEntries,
    billingService.listFlatFees,
  ];

  // Red if: the Billing tab is offered to a member whose every read behind it answers 403, which
  // opens onto a page-wide error banner.
  it('shows neither tab to a baseline member, and reads nothing from the billing service', async () => {
    grantBaselineMember();
    seedMatterWorkspace();

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.queryByRole('button', { name: /^Billing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Time Tracking/ })).not.toBeInTheDocument();
    for (const call of billingCalls()) expect(call).not.toHaveBeenCalled();
  });

  // Red if: a ?tab=billing link is stored as the active tab for a member who is not shown it, so the
  // loaders still fire (and 403) behind an Overview-less page.
  it.each(['billing', 'time-tracking'])('lands on the Overview, with no billing reads, for a ?tab=%s link', async (tab) => {
    grantBaselineMember();
    seedMatterWorkspace();

    await renderOnTab(tab);

    expect(screen.getByText('Matter Information')).toBeInTheDocument();
    for (const call of billingCalls()) expect(call).not.toHaveBeenCalled();
  });

  // Red if: the tab is gated on invoices alone, or the loaders run for every permitted section.
  it('shows the Billing tab to a member who can only view time entries, and reads only time entries', async () => {
    grantBaselineMember(['billing.viewTimeEntries']);
    seedMatterWorkspace();
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));

    await waitFor(() => expect(billingService.listTimeEntries).toHaveBeenCalled());
    expect(billingService.listInvoices).not.toHaveBeenCalled();
    expect(billingService.listFlatFees).not.toHaveBeenCalled();
    expect(screen.queryByText('Flat Fees')).not.toBeInTheDocument();
    expect(screen.queryByText('Upcoming Invoice Payments')).not.toBeInTheDocument();
  });

  // Red if: the invoice sections render, or their loaders run, without billing.viewInvoices.
  it('shows the Billing tab to a member who can only view invoices, and reads no time entries', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    seedMatterWorkspace();
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.queryByRole('button', { name: /^Time Tracking/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));

    await waitFor(() => expect(billingService.listInvoices).toHaveBeenCalled());
    expect(billingService.listFlatFees).toHaveBeenCalled();
    expect(billingService.listTimeEntries).not.toHaveBeenCalled();
    expect(await screen.findByText('Upcoming Invoice Payments')).toBeInTheDocument();
  });

  // Red if: the trust balance read is fired on the Billing tab without trust.view, which the trust
  // routes refuse with a 403.
  it.each([
    ['without', [] as string[], false],
    ['with', ['trust.view'], true],
  ])('reads the firm trust balances %s trust.view', async (_label, extra, expected) => {
    grantBaselineMember(['billing.viewInvoices', ...extra]);
    seedMatterWorkspace();
    api.getExact(`${matterUrl(MATTER_1)}/clients`, { clients: [{ id: 'c1', name: 'Pat Client', email: 'p@x.test' }] });
    api.get('/clients', { clients: [{ id: 'c1', name: 'Pat Client', email: 'p@x.test' }] });
    // Trust accounting is a plan feature; without it the read is held back for a different reason.
    renderWithProviders(
      <FirmSettingsProvider lawFirmId={FIRM_A} initialSettings={{ features: { trustAccounting: true } as never }}>
        <ViewMatterPage />
      </FirmSettingsProvider>,
    );

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    await waitFor(() => expect(billingService.listInvoices).toHaveBeenCalled());

    if (expected) await waitFor(() => expect(trustService.getAllBalances).toHaveBeenCalled());
    else expect(trustService.getAllBalances).not.toHaveBeenCalled();
  });

  it('shows both tabs and loads all three reads for a member who holds both view permissions', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries']);
    seedMatterWorkspace();
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.getByRole('button', { name: /^Time Tracking/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));

    await waitFor(() => {
      for (const call of billingCalls()) expect(call).toHaveBeenCalled();
    });
  });
});

describe('save and bill now from the Billing tab Log Time', () => {
  async function logTimeAndBill() {
    seedMatterWorkspace({
      matter: matter({ members: [{ userId: 'u1', name: 'Pat Attorney' }] as unknown as Matter['members'] }),
    });
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Log Time' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stub save and bill' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stub save and bill' })).not.toBeInTheDocument());
  }

  it('does not open the composer for a member without billing.manageInvoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries', 'billing.manageTimeEntries']);
    await logTimeAndBill();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the matter composer for a member who can manage invoices', async () => {
    grantBaselineMember([
      'billing.viewInvoices',
      'billing.viewTimeEntries',
      'billing.manageTimeEntries',
      'billing.manageInvoices',
    ]);
    await logTimeAndBill();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toContain(`/lawfirm/${FIRM_A}/matters/${MATTER_1}/generate-invoice`);
  });
});

/** The matter as its own member sees it: the backend deletes only for a matter member. */
const MEMBER_MATTER = () =>
  matter({ members: [{ userId: 'test-uid', name: 'Test User' }] as unknown as Matter['members'] });

describe('a successful action: deleting the matter', () => {
  it('deletes the matter and returns to the matters list', async () => {
    seedMatterWorkspace({ matter: MEMBER_MATTER() });
    api.deleteExact(matterUrl(MATTER_1), { message: 'Matter deleted' });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Smith v\. Jones/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/matters`));
    expect(api.callsTo(`/matters/${MATTER_1}`).filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});

describe('a refused action: the delete fails', () => {
  it('tells the user the matter was not deleted, and stays on the page', async () => {
    seedMatterWorkspace({ matter: MEMBER_MATTER() });
    api.deleteExact(matterUrl(MATTER_1), {
      status: 409, body: { error: 'This matter has trust activity and cannot be deleted' },
    });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/trust activity and cannot be deleted/i)).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
    // Still showing the matter - the delete never actually happened.
    expect(screen.getByRole('heading', { name: /Smith v\. Jones/ })).toBeInTheDocument();
  });
});

describe('a matter switch while a request is pending', () => {
  it('never lets a slow response for the old matter land as the new matter\'s detail', async () => {
    seedMatterWorkspace({ matterId: MATTER_1 });
    seedMatterWorkspace({ matterId: MATTER_2, matter: matter({ id: MATTER_2, name: 'New Fast Matter' }) });
    // Registered LAST so it wins over the plain route `seedMatterWorkspace`
    // just set up for the same url (later registrations take precedence).
    api.getExact(matterUrl(MATTER_1), { delayMs: 200, body: matter({ id: MATTER_1, name: 'Old Slow Matter' }) });

    const { rerender } = renderMatterPage();

    // Matter 1's slow response is still in flight when the viewer navigates to
    // matter 2 (e.g. via browser back/forward, without a full page remount).
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, matterId: MATTER_2 });
    rerender(<ViewMatterPage />);

    expect(await screen.findByRole('heading', { name: /New Fast Matter/ })).toBeInTheDocument();

    // Even once matter 1's slow response finally arrives, it must not
    // overwrite the page now showing matter 2.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('heading', { name: /New Fast Matter/ })).toBeInTheDocument();
    expect(screen.queryByText('Old Slow Matter')).not.toBeInTheDocument();
  });
});

describe('first load', () => {
  it('starts the overview stage, custom-field and activity reads without waiting for the matter', async () => {
    seedMatterWorkspace();
    // A slow matter read: the spinner stays up for its whole duration.
    api.getExact(matterUrl(MATTER_1), { delayMs: 300, body: matter() });
    // The firm workspace's own client, so a section mounting after the matter
    // treats the started reads as fresh the way it does in the app.
    const client = createLawFirmQueryClient();
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });

    render(<QueryClientProvider client={client}><ViewMatterPage /></QueryClientProvider>);

    await waitFor(() => {
      expect(api.callsTo('/matter-stage-pipelines')).toHaveLength(1);
      expect(api.callsTo('/matter-field-defs')).toHaveLength(1);
      expect(api.callsTo(`/matters/${MATTER_1}/activity`)).toHaveLength(1);
    });
    // All three went out while the matter itself was still loading.
    expect(screen.queryByRole('heading', { name: /Smith v\. Jones/ })).not.toBeInTheDocument();

    // Once the overview renders, its sections reuse those reads rather than
    // repeating them.
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.callsTo('/matter-stage-pipelines')).toHaveLength(1);
    expect(api.callsTo('/matter-field-defs')).toHaveLength(1);
    expect(api.callsTo(`/matters/${MATTER_1}/activity`)).toHaveLength(1);
  });

  it('does not read the overview sections when the page opens on another tab', async () => {
    seedMatterWorkspace();
    const searchParams = jest.requireMock('next/navigation') as { useSearchParams: () => URLSearchParams };
    const original = searchParams.useSearchParams;
    searchParams.useSearchParams = () => new URLSearchParams('tab=team');
    try {
      renderMatterPage();
      await screen.findByRole('heading', { name: /Smith v\. Jones/ });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(api.callsTo('/matter-field-defs')).toHaveLength(0);
      expect(api.callsTo(`/matters/${MATTER_1}/activity`)).toHaveLength(0);
    } finally {
      searchParams.useSearchParams = original;
    }
  });

  it('holds back courts and charge codes, which only the closed task and time-entry modals use', async () => {
    seedMatterWorkspace();

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });

    expect(mockUseCourtsArgs).toHaveBeenCalled();
    expect(mockUseCourtsArgs.mock.calls.every((call) => call[1] === false)).toBe(true);
    expect(mockUseChargeCodesArgs).toHaveBeenCalled();
    expect(mockUseChargeCodesArgs.mock.calls.every((call) => call[2] === false)).toBe(true);
  });
});


/** Opens the page on `tab` the way a deep link does, then restores the real search params. */
async function renderOnTab(tab: string) {
  const nav = jest.requireMock('next/navigation') as { useSearchParams: () => URLSearchParams };
  const original = nav.useSearchParams;
  nav.useSearchParams = () => new URLSearchParams(`tab=${tab}`);
  try {
    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
  } finally {
    nav.useSearchParams = original;
  }
}

describe('the ?tab= deep link', () => {
  // Red if: an unknown value is stored as the active tab again, which renders no panel at all.
  it('lands on the Overview for a tab that does not exist', async () => {
    seedMatterWorkspace();

    await renderOnTab('bogus');

    expect(screen.getByText('Matter Information')).toBeInTheDocument();
  });

  // Red if: the tab filter and the deep link disagree again, so the strip hides Messages while the
  // panel stays unreachable and the page shows nothing.
  it('lands on the Overview when the tab is Messages and the member cannot view messaging', async () => {
    grantPermissions(['matters.view', 'tasks.view']);
    seedMatterWorkspace();

    await renderOnTab('messages');

    expect(screen.getByText('Matter Information')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Messages/ })).not.toBeInTheDocument();
  });

  // Red if: the link is resolved once at mount against the permissions that exist before they have
  // loaded (every check answers "no" then), so an authorised member is sent to the Overview for good.
  it('keeps a Messages link for a member whose permissions are still loading', async () => {
    grantPermissions(['matters.view', 'tasks.view']);
    mockPermissionsValue.loading = true;
    seedMatterWorkspace();

    const nav = jest.requireMock('next/navigation') as { useSearchParams: () => URLSearchParams };
    const original = nav.useSearchParams;
    nav.useSearchParams = () => new URLSearchParams('tab=messages');
    try {
      const view = renderMatterPage();
      await screen.findByRole('heading', { name: /Smith v\. Jones/ });

      grantPermissions(['matters.view', 'tasks.view', 'messaging.view']);
      mockPermissionsValue.loading = false;
      view.rerender(<ViewMatterPage />);
    } finally {
      nav.useSearchParams = original;
      mockPermissionsValue.loading = false;
    }

    expect(await screen.findByRole('button', { name: /^Messages/ })).toHaveAttribute('aria-current', 'true');
  });

  it('shows the Messages tab to a member who can view messaging', async () => {
    seedMatterWorkspace();

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });

    expect(screen.getByRole('button', { name: /^Messages/ })).toBeInTheDocument();
  });

  it('still opens a real tab from the link', async () => {
    seedMatterWorkspace();

    await renderOnTab('team');

    expect(await screen.findByText('Team Members')).toBeInTheDocument();
  });
});

describe('the Tasks tab when the tasks cannot be read', () => {
  // Red if: a failed read is turned back into an empty list, which reads as "this matter has no tasks".
  it('shows the failure with a retry instead of "No tasks found"', async () => {
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, { status: 500, body: { error: 'tasks service unavailable' } });

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);

    expect(await screen.findByText(/tasks service unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('No tasks found for this matter')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('reads the tasks again on retry and shows them', async () => {
    seedMatterWorkspace();
    let attempts = 0;
    api.get(`/tasks/matter/${MATTER_1}`, () => {
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { error: 'tasks service unavailable' } }
        : { tasks: [{ id: 't1', taskId: 't1', title: 'File motion', status: 'open' }] };
    });

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('File motion')).toBeInTheDocument();
    expect(screen.queryByText(/tasks service unavailable/i)).not.toBeInTheDocument();
  });
});

describe('the Clients tab edit action', () => {
  const DANA = { id: 'c1', name: 'Dana Client', email: 'dana@example.test', clientType: 'person' };

  function seedClients() {
    seedMatterWorkspace();
    api.getExact(`${matterUrl(MATTER_1)}/clients`, { clients: [DANA] });
    api.getExact(`${API}/lawfirms/${FIRM_A}/clients?ids=c1`, { clients: [] });
  }

  // Editing a client from here writes the firm-wide client record, which the backend gates on
  // clients.manage. Red if: the entry is offered on matters.manageClients alone.
  it('is hidden from a member who can manage matter clients but not edit client records', async () => {
    grantBaselineMember(['matters.manageClients']);
    seedClients();

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));

    expect(await screen.findByRole('button', { name: 'Remove Dana Client' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Dana Client' })).not.toBeInTheDocument();
  });

  it('is offered to a member who can also manage clients', async () => {
    grantBaselineMember(['matters.manageClients', 'clients.manage']);
    seedClients();

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));

    expect(await screen.findByRole('button', { name: 'Edit Dana Client' })).toBeInTheDocument();
  });
});

describe('Save & Add Time on the Notes tab', () => {
  async function openComposerWithSubject(subject: string) {
    api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    // The Overview's activity feed also has a "Notes" filter chip; the tab strip comes first.
    await userEvent.click(screen.getAllByRole('button', { name: /^Notes/ })[0]);
    await userEvent.click(await screen.findByRole('button', { name: /Add Note/i }));
    // The rich-text control is not typeable under jsdom; a template is what fills the editor.
    await userEvent.click(await screen.findByRole('button', { name: /Blank Note/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Phone Call' }));
    await userEvent.type(screen.getByPlaceholderText(/Brief title for this note/i), subject);
  }

  async function chooseSaveAndAddTime() {
    await userEvent.click(screen.getByRole('button', { name: 'More save options' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save & Add Time' }));
  }

  // Red if: the page's add-note handler stops returning the service result, so the panel has no
  // note id to open the time modal against.
  it('opens the time modal for the note that was just saved', async () => {
    seedMatterWorkspace();
    api.post('/notes', { status: 201, body: { note: { id: 'note-new' } } });

    await openComposerWithSubject('Called opposing counsel');
    await chooseSaveAndAddTime();

    expect(await screen.findByRole('dialog', { name: 'Add Time Entry' })).toBeInTheDocument();
  });

  it('keeps the draft and says why when the save is refused, without opening the time modal', async () => {
    seedMatterWorkspace();
    api.post('/notes', { status: 403, body: { error: 'You cannot add notes to this matter' } });

    await openComposerWithSubject('Called opposing counsel');
    await chooseSaveAndAddTime();

    expect((await screen.findAllByText(/You cannot add notes to this matter/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog', { name: 'Add Time Entry' })).not.toBeInTheDocument();
    // The template prefixes its own title, so the typed text is kept after it.
    expect((screen.getByPlaceholderText(/Brief title for this note/i) as HTMLInputElement).value).toContain('Called opposing counsel');
  });
});

describe('removing a member from the Team tab', () => {
  const PAT = { userId: 'u-pat', name: 'Pat Attorney', email: 'pat@firm.test', role: 'lead' };
  const SAM = { userId: 'u-sam', name: 'Sam Paralegal', email: 'sam@firm.test', role: 'member' };

  async function openTeamAndRemove(name: string) {
    seedMatterWorkspace({ matter: matter({ members: [PAT, SAM] as Matter['members'] }) });
    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Team/ })[0]);
    await userEvent.click(await screen.findByRole('button', { name: `Remove ${name}` }));
  }

  const removals = () => api.callsTo('/members/remove').filter((c) => c.method === 'POST');

  // Red if: the page skips the preview and confirms a bare "are you sure", or drops reassignTo.
  it('asks what the member still has assigned and sends the chosen member as reassignTo', async () => {
    api.post('/members/remove/preview', { members: [{ userId: 'u-sam', openTasks: 3, upcomingEvents: 1, reminderSlots: 0 }] });
    api.post('/members/remove', { message: 'ok' });

    await openTeamAndRemove('Sam Paralegal');

    const dialog = await screen.findByRole('dialog', { name: 'Remove User from Matter?' });
    expect(within(dialog).getByText(/3 open tasks and 1 upcoming event on this matter are assigned to Sam Paralegal/)).toBeInTheDocument();
    const previewed = api.callsTo('/members/remove/preview');
    expect(previewed).toHaveLength(1);
    expect(previewed[0].body).toEqual({ targetUserIds: ['u-sam'] });

    await userEvent.click(within(dialog).getByRole('button', { name: /^Reassign to/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Pat Attorney' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removals()).toHaveLength(1));
    expect(removals()[0].body).toEqual({ targetUserIds: ['u-sam'], reassignTo: 'u-pat' });
  });

  it('removes without a picker, and without reassignTo, when nothing is assigned', async () => {
    api.post('/members/remove/preview', { members: [{ userId: 'u-sam', openTasks: 0, upcomingEvents: 0, reminderSlots: 0 }] });
    api.post('/members/remove', { message: 'ok' });

    await openTeamAndRemove('Sam Paralegal');

    const dialog = await screen.findByRole('dialog', { name: 'Remove User from Matter?' });
    expect(within(dialog).queryByRole('button', { name: /^Reassign to/ })).not.toBeInTheDocument();
    expect(api.callsTo('/members/remove/preview')).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removals()).toHaveLength(1));
    expect(removals()[0].body).toEqual({ targetUserIds: ['u-sam'] });
  });

  it('leaves the work unassigned when no reassignment is chosen', async () => {
    api.post('/members/remove/preview', { members: [{ userId: 'u-sam', openTasks: 2, upcomingEvents: 0, reminderSlots: 0 }] });
    api.post('/members/remove', { message: 'ok' });

    await openTeamAndRemove('Sam Paralegal');

    const dialog = await screen.findByRole('dialog', { name: 'Remove User from Matter?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removals()).toHaveLength(1));
    expect(removals()[0].body).toEqual({ targetUserIds: ['u-sam'] });
  });

  // Red if: a failed preview is swallowed and the removal goes ahead blind.
  it('shows an error and removes nobody when the preview fails', async () => {
    api.post('/members/remove/preview', { status: 500, body: { error: 'preview unavailable' } });
    api.post('/members/remove', { message: 'ok' });

    await openTeamAndRemove('Sam Paralegal');

    expect(await screen.findByText(/preview unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Remove User from Matter?' })).not.toBeInTheDocument();
    expect(removals()).toHaveLength(0);
  });
});


describe('a task created from a note', () => {
  const NOTE = {
    id: 'n1',
    content: 'Follow up with the clerk',
    contentHtml: '<p>Follow up with the clerk</p>',
    subject: 'Clerk call',
    noteType: 'general',
    noteDate: '2026-02-01',
    createdBy: 'test-uid',
    createdByName: 'Test User',
    createdAt: '2026-02-01T10:00:00.000Z',
    parentType: 'matter',
    parentId: MATTER_1,
    lawFirmId: FIRM_A,
  };

  // The page keeps its own task list; creating from a note only invalidates the shared query
  // cache, so without the callback the Tasks tab stays on the old count until a reload.
  // Red if: the page stops passing onTaskCreated to the notes panel.
  it('appears on the Tasks tab straight away', async () => {
    seedMatterWorkspace();
    let created = false;
    api.get(`/tasks/matter/${MATTER_1}`, () => ({
      tasks: created ? [{ id: 't9', taskId: 't9', title: 'Clerk call', status: 'open' }] : [],
    }));
    api.get('/notes', { notes: [NOTE], totalNotes: 1, counts: { all: 1, withTime: 0, withoutTime: 1 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    api.get('/tasks/lookup', { items: [], hasMore: false });
    api.post('/notes/n1/tasks', () => {
      created = true;
      return { status: 201, body: { taskId: 't9', link: { id: 'l1' } } };
    });

    const { container } = renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.queryByRole('button', { name: /^Tasks.*1/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: /^Notes/ })[0]);
    await screen.findByText('Clerk call');
    const card = container.querySelector('#note-n1') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Task from Note' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create/ }));

    await waitFor(() => expect(api.callsTo('/notes/n1/tasks')).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /^Tasks.*1/ })).toBeInTheDocument();
  });
});

it('retries an initial matter load without leaving the detail page', async () => {
  seedIncidentalReads(FIRM_A, MATTER_1);
  let attempts = 0;
  api.getExact(matterUrl(MATTER_1), () => ++attempts === 1
    ? { status: 500, body: { error: 'matters service unavailable' } }
    : matter());
  renderMatterPage();
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() => expect(screen.queryByText('Matter not found')).not.toBeInTheDocument());
  expect(screen.getAllByText(matter().name).length).toBeGreaterThan(0);
});

describe('Escape while team members are being added', () => {
  // Red if: the Add Users dialog stays dismissible (or its Cancel stays
  // enabled) while the add-members POST is pending, so Escape closes it
  // mid-save and the selection is lost before the request settles.
  it('keeps the Add Users dialog open and Cancel disabled until the add settles', async () => {
    seedMatterWorkspace();
    api.getExact(`${API}/users/lawfirm/${FIRM_A}/users`, [
      { uid: 'user-2', name: 'Lee Paralegal', email: 'lee@example.test', userType: 'firm_member' },
    ]);
    const post = holdResponse();
    api.postExact(`${matterUrl(MATTER_1)}/members`, post.handler);

    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Team/ })[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Users to Matter' });
    await userEvent.click(within(dialog).getByText('Lee Paralegal'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await post.untilRequested();
    expect(api.callsTo(`/matters/${MATTER_1}/members`)[0].body).toEqual(
      expect.objectContaining({ targetUserIds: ['user-2'] }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    // The page's close only flips its open flag, and the Modal stays mounted for
    // its 100ms exit animation, so the check has to outlast that window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByRole('dialog', { name: 'Add Users to Matter' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ message: 'Members added' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add Users to Matter' })).not.toBeInTheDocument(),
    );
  });
});

describe('the Billing tab member totals', () => {
  const PRICED_MEMBER = { userId: 'u1', name: 'Pat Attorney', hourlyRate: null };

  async function openBillingWith(entries: Record<string, unknown>[]) {
    grantBaselineMember(['billing.viewTimeEntries']);
    (billingService.listTimeEntries as jest.Mock).mockResolvedValueOnce(entries);
    seedMatterWorkspace({
      matter: matter({ members: [PRICED_MEMBER] as unknown as Matter['members'] }),
    });
    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    await waitFor(() => expect(billingService.listTimeEntries).toHaveBeenCalled());
    return screen.findByRole('heading', { name: 'Pat Attorney' });
  }

  const memberCard = (heading: HTMLElement) => heading.closest('div.rounded-2xl') as HTMLElement;

  // Red if: the card prices only the manual override (`hourlyRate`) or the
  // member's matter rate, so time rated from the client's, a charge code's, the
  // member's own or the firm's rate shows $0.00 here while the Time Tracking tab
  // and the invoice show what the server stamped on it.
  it('shows the server-resolved amount for an entry with no override and no matter rate', async () => {
    const card = memberCard(await openBillingWith([
      {
        id: 'te-1', userId: 'u1', hours: 1.5, hourlyRate: null,
        resolvedRate: 200, rateSource: 'client default rate', amount: 300,
      },
    ]));

    expect(within(card).getByText('$300.00')).toBeInTheDocument();
    expect(within(card).queryByText('$0.00')).not.toBeInTheDocument();
  });

  // Red if: the total is a float product of hours and rate. 0.33h at $100.50 is
  // 33.165, which a float holds as 33.16499... and formats as $33.16; the server
  // stored 3317 cents (half up on hundredths of an hour), which is what the
  // invoice bills.
  it('sums each entry\'s stored cents rather than a float product of hours and rate', async () => {
    const card = memberCard(await openBillingWith([
      {
        id: 'te-1', userId: 'u1', hours: 0.33, hourlyRate: 100.5,
        resolvedRate: 100.5, rateSource: 'time entry override', amount: 33.17,
      },
      {
        id: 'te-2', userId: 'u1', hours: 1.5, hourlyRate: null,
        resolvedRate: 200, rateSource: 'firm default rate', amount: 300,
      },
    ]));

    expect(within(card).getByText('$333.17')).toBeInTheDocument();
  });
});

describe('save and bill now for an entry filed under a client', () => {
  // Red if: the matter page builds the composer url itself, always under this
  // matter, so an entry the modal filed under a client opens the matter's
  // composer, which cannot find the draft it was handed.
  it('opens that client\'s composer, not this matter\'s', async () => {
    grantBaselineMember([
      'billing.viewInvoices',
      'billing.viewTimeEntries',
      'billing.manageTimeEntries',
      'billing.manageInvoices',
    ]);
    mockBillNowDraft = { timeEntryId: 'te-9', contextType: 'client', entityId: 'client-9', clientId: 'client-9' };
    seedMatterWorkspace({
      matter: matter({ members: [{ userId: 'u1', name: 'Pat Attorney' }] as unknown as Matter['members'] }),
    });
    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Log Time' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stub save and bill' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith(
      `/lawfirm/${FIRM_A}/clients/client-9/generate-invoice?draftType=time_entry&draftId=te-9`,
    );
  });
});

describe('the Billing tab flat fees', () => {
  const SAVED_FEE = { id: 'fee-1', description: 'Filing fee', amount: 125, date: '2026-02-02' };

  async function openFlatFees(extra: string[]) {
    grantBaselineMember(['billing.viewInvoices', ...extra]);
    (billingService.listFlatFees as jest.Mock).mockResolvedValue([SAVED_FEE]);
    seedMatterWorkspace();
    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getByRole('button', { name: /^Billing/ }));
    // The saved fee proves the section rendered and its read finished.
    await screen.findByText('Filing fee');
  }

  afterEach(() => {
    (billingService.listFlatFees as jest.Mock).mockResolvedValue([]);
  });

  // Red if: the add, edit or remove controls render for a member the flat-fee
  // write routes refuse, so every click ends in a 403.
  it('shows a member without billing.manageInvoices the fees with no way to change them', async () => {
    await openFlatFees([]);

    expect(screen.queryByRole('button', { name: '+ Add Flat Fee' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove flat fee' })).not.toBeInTheDocument();
    const feeRow = screen.getByText('Filing fee').closest('div.rounded-lg') as HTMLElement;
    expect(within(feeRow).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('offers add, edit and remove to a member who can manage invoices', async () => {
    await openFlatFees(['billing.manageInvoices']);

    expect(screen.getByRole('button', { name: '+ Add Flat Fee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove flat fee' })).toBeInTheDocument();
    const feeRow = screen.getByText('Filing fee').closest('div.rounded-lg') as HTMLElement;
    expect(within(feeRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  // The remove handler lets the rejection reach `ConfirmAction`, which shows it
  // inside the confirm and keeps the confirm open for a retry. Red if the
  // handler swallows the error (the confirm closes on a delete that never
  // happened) or the confirm stops reporting it.
  it('says why when removing a fee is refused, and keeps the confirm open', async () => {
    (billingService.removeFlatFee as jest.Mock).mockRejectedValueOnce(
      new Error('This flat fee is already on an invoice'),
    );
    await openFlatFees(['billing.manageInvoices']);

    await userEvent.click(screen.getByRole('button', { name: 'Remove flat fee' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Flat Fee' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByText('This flat fee is already on an invoice')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Remove Flat Fee' })).toBeInTheDocument();
    expect(billingService.removeFlatFee).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Filing fee')).toBeInTheDocument();
  });
});

describe('the Tasks tab row actions follow their own permissions', () => {
  const TASK = { id: 't1', taskId: 't1', title: 'Serve interrogatories', status: 'open' };

  async function openTasks(codes: string[]) {
    grantBaselineMember(codes);
    seedMatterWorkspace();
    api.get(`/tasks/matter/${MATTER_1}`, { tasks: [TASK] });
    renderMatterPage();
    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    await userEvent.click(screen.getAllByRole('button', { name: /^Tasks/ })[0]);
    await screen.findByText('Serve interrogatories');
  }

  // Red if: the row actions are gated on tasks.create, so a member who may
  // update tasks but not create them gets no Edit.
  it('offers Edit to a member with tasks.update but not tasks.create', async () => {
    await openTasks(['tasks.update']);

    expect(screen.getByRole('button', { name: 'Edit Serve interrogatories' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Serve interrogatories' })).not.toBeInTheDocument();
  });

  it('offers New Task but not Edit to a member with tasks.create alone', async () => {
    await openTasks(['tasks.create']);

    expect(screen.getByRole('button', { name: 'New Task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Serve interrogatories' })).not.toBeInTheDocument();
  });

  // Red if: the page never hands the tab a delete handler, so a member with
  // tasks.delete has to leave the matter to delete one of its tasks.
  it('deletes a task for a member with tasks.delete, after confirming', async () => {
    api.delete('/tasks/t1', { message: 'Task deleted' });
    await openTasks(['tasks.delete']);

    const taskReads = () => api.callsTo(`/tasks/matter/${MATTER_1}`).length;
    const readsBefore = taskReads();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Serve interrogatories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Task' });
    expect(within(dialog).getByText(/Serve interrogatories/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(api.callsTo('/tasks/t1').filter((c) => c.method === 'DELETE')).toHaveLength(1),
    );
    // The tab re-reads the matter's tasks so the deleted one leaves the list.
    await waitFor(() => expect(taskReads()).toBeGreaterThan(readsBefore));
  });

  // Red if: a refused delete (a matter under legal hold) closes the confirm
  // without a word, which reads as though the task were deleted.
  it('shows the legal-hold refusal when the delete is turned away', async () => {
    api.delete('/tasks/t1', {
      status: 403,
      body: { error: 'This matter is under legal hold, so its tasks cannot be deleted.' },
    });
    await openTasks(['tasks.delete']);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Serve interrogatories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/under legal hold, so its tasks cannot be deleted/)).toBeInTheDocument();
  });
});

describe('the matter Delete button and matter membership', () => {
  // Red if: Delete is offered on matters.delete alone. The delete route also
  // requires the caller to be a member of THIS matter, so a firm admin who can
  // read every matter would be shown a button that always answers 403.
  it('is hidden from a member with matters.delete who is not on the matter', async () => {
    grantBaselineMember(['matters.delete']);
    seedMatterWorkspace({
      matter: matter({ members: [{ userId: 'someone-else', name: 'Lee' }] as unknown as Matter['members'] }),
    });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('is shown to a member with matters.delete who is on the matter', async () => {
    grantBaselineMember(['matters.delete']);
    seedMatterWorkspace({ matter: MEMBER_MATTER() });

    renderMatterPage();

    await screen.findByRole('heading', { name: /Smith v\. Jones/ });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
