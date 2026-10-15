/**
 * The firm matters list: `RequirePermission` gating `MattersGrid`, the entry
 * point for every matter in the firm.
 *
 * `matters.service`, `practiceArea.service`, `users.service` and
 * `requestDeduplicator` run for real against a faked transport, so a wrong url,
 * a swallowed error, or a stale response reaching a switched firm fails the
 * spec instead of a stubbed hook quietly returning whatever the test handed it.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/matters',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  // A stable fn, unlike the global stub in `tests/setup.ts`, which hands out a
  // fresh `jest.fn()` per call so nothing it received can be asserted.
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LawFirmMattersPage from '@/app/lawfirm/[lawFirmId]/matters/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { Matter } from '@/types';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function mattersUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/matters`;
}

/** The default first-page request: page 1, limit 10, name ascending - the grid's opening state. */
function defaultListUrl(firmId: string): string {
  return `${mattersUrl(firmId)}?limit=10&page=1&sort=name:asc`;
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 'matter-1',
    name: 'Smith v. Jones',
    status: 'active',
    matterNumber: 'M-1001',
    practiceAreaName: 'Litigation',
    leadUserName: 'Pat Attorney',
    clientNames: ['Jane Smith'],
    clientCount: 1,
    ...overrides,
  } as Matter;
}

/** Every route the grid fetches on mount, regardless of filters. */
function seedMattersWorkspace(opts: {
  firmId?: string;
  matters?: Matter[];
  totalItems?: number;
  listUrl?: string;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const rows = opts.matters ?? [];
  api.getExact(opts.listUrl ?? defaultListUrl(firmId), { matters: rows, totalItems: opts.totalItems ?? rows.length });
  api.getExact(`${API}/lawfirms/${firmId}/practice-areas`, { practiceAreas: [] });
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
  api.getExact(`${mattersUrl(firmId)}/categories`, { categories: [] });
}

function renderMattersPage() {
  return renderWithProviders(<LawFirmMattersPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real matters returned by the server', async () => {
    seedMattersWorkspace({
      matters: [matter(), matter({ id: 'matter-2', name: 'Doe Estate', matterNumber: 'M-1002', status: 'closed' })],
      totalItems: 2,
    });

    renderMattersPage();

    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
    expect(screen.getByText('Doe Estate')).toBeInTheDocument();
    expect(screen.getByText('Matters (2)')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no matters were found rather than rendering a blank grid', async () => {
    seedMattersWorkspace();

    renderMattersPage();

    expect(await screen.findByText('No matters found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filters.')).toBeInTheDocument();
    expect(screen.getByText('Matters (0)')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('tells the user the list failed to load rather than showing an empty grid', async () => {
    seedMattersWorkspace();
    api.getExact(defaultListUrl(FIRM_A), { status: 500, body: { error: 'matters service unavailable' } });

    renderMattersPage();

    // Unlike the billing/trust bugs fixed earlier in this pass, the failure here
    // is NOT silently swallowed: a real, visible error banner names the actual
    // problem and offers a retry.
    expect(await screen.findByRole('alert')).toHaveTextContent(/matters service unavailable/i);
    expect(screen.queryByText('Try adjusting your search or filters.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real list once the retry succeeds', async () => {
    seedMattersWorkspace();
    api.getExact(defaultListUrl(FIRM_A), sequence(
      { status: 500, body: { error: 'matters service unavailable' } },
      { matters: [matter()], totalItems: 1 },
    ));

    renderMattersPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('opens the grid for a baseline member without the write controls', async () => {
    grantBaselineMember();
    seedMattersWorkspace({ matters: [matter()], totalItems: 1 });

    renderMattersPage();

    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
    // matters.view is baseline, but create/update/delete/manageMembers are not.
    expect(screen.queryByText('Create New Matter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedMattersWorkspace({ matters: [matter()], totalItems: 1 });

    renderMattersPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
  });

  it('never requests the matters list for a viewer the page refuses to show anything to', async () => {
    grantOutsider();
    seedMattersWorkspace({ matters: [matter()], totalItems: 1 });

    renderMattersPage();

    await screen.findByText('You do not have access to this area');
    // Unlike the billing/trust hubs (whose data hooks run above their permission
    // gate), MattersGrid is mounted INSIDE RequirePermission here, so a refused
    // viewer's render never reaches the component that would fire the request.
    expect(api.callsTo('/matters')).toHaveLength(0);
  });
});

describe('a successful action: deleting a matter', () => {
  it('removes the matter and refreshes the list', async () => {
    seedMattersWorkspace();
    // First load answers with the seeded matter; the refresh AFTER a successful
    // delete re-requests the same URL and gets the now-empty list.
    api.getExact(defaultListUrl(FIRM_A), sequence(
      { matters: [matter()], totalItems: 1 },
      { matters: [], totalItems: 0 },
    ));
    api.deleteExact(`${mattersUrl(FIRM_A)}/matter-1`, { message: 'Matter deleted' });

    renderMattersPage();

    await screen.findByText('Smith v. Jones');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Smith v\. Jones/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Smith v. Jones')).not.toBeInTheDocument());
    expect(await screen.findByText('No matters found')).toBeInTheDocument();
    expect(api.callsTo('/matters/matter-1')).toHaveLength(1);
  });
});

describe('a refused action: the delete fails', () => {
  it('tells the user the matter was not deleted, and leaves it in the list', async () => {
    seedMattersWorkspace({ matters: [matter()], totalItems: 1 });
    api.deleteExact(`${mattersUrl(FIRM_A)}/matter-1`, {
      status: 409, body: { error: 'This matter has billing history and cannot be deleted' },
    });

    renderMattersPage();

    await screen.findByText('Smith v. Jones');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/billing history and cannot be deleted/i)).toBeInTheDocument();
    // Still in the list - the delete never actually happened.
    expect(screen.getByText('Smith v. Jones')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s matter list', async () => {
    api.getExact(defaultListUrl(FIRM_A), { delayMs: 200, body: { matters: [matter({ name: 'Firm A Matter' })], totalItems: 1 } });
    seedMattersWorkspace({ firmId: FIRM_A });
    seedMattersWorkspace({ firmId: FIRM_B, matters: [matter({ id: 'matter-b', name: 'Firm B Matter' })], totalItems: 1 });

    const { rerender } = renderMattersPage();

    // Firm A's slow request is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<LawFirmMattersPage />);

    expect(await screen.findByText('Firm B Matter')).toBeInTheDocument();

    // Even once firm A's slow response finally arrives, it must not overwrite
    // the list now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByText('Firm B Matter')).toBeInTheDocument();
    expect(screen.queryByText('Firm A Matter')).not.toBeInTheDocument();
  });
});
