/**
 * The firm workspace shell: identity, membership, bootstrap failure, and paywall.
 *
 * Every firm-scoped page in the app renders inside this layout, so the layout is
 * where four decisions are made once for all of them: whether an identity is
 * present, whether that identity is a firm member, whether the firm record
 * loaded, and whether billing keeps the workspace open. A mistake here is not
 * one broken page, it is the wrong screen for every page at once.
 *
 * The services stay real and only the transport is faked, so a wrong URL, a
 * mishandled status code, or a stale response reaching a switched workspace
 * fails the spec instead of passing through a stubbed service.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');
// The global setup narrows these three to their hooks for ordinary component
// tests. This layout renders the providers themselves, so it needs the real
// context objects and the real permission resolution inside them.
jest.unmock('@/contexts/LawFirmContext');
jest.unmock('@/contexts/PermissionsContext');
jest.unmock('@/contexts/NavigationContext');

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
// One object for the whole file, not a fresh one per call. The layout lists the
// router in the dependency array of the effect that verifies the user type, so a
// router identity that changes every render re-runs that effect every render and
// turns a single profile read into one per render.
const mockRouter = {
  push: mockRouterPush,
  replace: mockRouterReplace,
  back: jest.fn(),
  forward: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};

let mockSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: jest.fn(),
  usePathname: jest.fn(),
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: jest.fn() }));

// The layout hands the sidebar the billing status and trial date it resolved.
// A probe keeps that hand-off assertable without dragging navigation, unread
// counts, and icon rendering into a spec about the shell's own decisions.
jest.mock('@/components/sidebar/LawfirmSidebar', () => {
  const React = require('react');
  function SidebarProbe({
    billingStatus, trialEndsAt,
  }: { billingStatus: string | null; trialEndsAt: string | null }) {
    return React.createElement('aside', null,
      React.createElement('output', { 'data-testid': 'sidebar-billing-status' }, billingStatus ?? ''),
      React.createElement('output', { 'data-testid': 'sidebar-trial-ends' }, trialEndsAt ?? ''),
    );
  }
  return { __esModule: true, default: SidebarProbe };
});

// Chrome that mounts beside the workspace and fetches its own unrelated data.
// None of it participates in the decisions under test.
jest.mock('@/components/notificationComp/NotificationToaster', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/GoogleCalendarReconnectBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/OutlookCalendarReconnectBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/PendingMemberInviteBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/providers/ThemeApplier', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useCalendarBackgroundSync', () => ({
  __esModule: true,
  useCalendarBackgroundSync: () => ({ syncingGoogle: false, syncingOutlook: false, outlookError: null }),
}));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useParams, usePathname } from 'next/navigation';

import LawFirmLayout from '@/app/lawfirm/[lawFirmId]/layout';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../../support/apiMock';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

const useParamsMock = useParams as jest.Mock;
const usePathnameMock = usePathname as jest.Mock;
const useAuthMock = useAuth as jest.Mock;

const FIRM_A = 'firm-a';
const OTHER_FIRM = 'firm-b';
const MEMBER_A = 'member-a';
const MEMBER_B = 'member-b';

const api = setupApiMock();
let consoleErrorSpy: jest.SpyInstance;

function signedInAs(uid: string) {
  return {
    user: { uid, email: `${uid}@example.test`, emailVerified: true, providerData: [], metadata: {} },
    loading: false,
  };
}

/** Reads the resolved permission set from inside the shell's own provider. */
function PermissionProbe() {
  const { member, permissions, loading } = usePermissions();
  return (
    <div>
      <output data-testid="probe-member">{member?.userId ?? ''}</output>
      <output data-testid="probe-permissions">{loading ? 'loading' : permissions.join(',')}</output>
    </div>
  );
}

/** Makes a firm-scoped request from inside the workspace, the way a page does. */
function BillingRefusalProbe({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => { void apiFetch(`http://localhost:5001/api${path}`).catch(() => {}); }}
    >
      load page data
    </button>
  );
}

function workspace(children: React.ReactNode = <div>workspace content</div>) {
  return <LawFirmLayout>{children}</LawFirmLayout>;
}

function seedFirm(plan: Record<string, unknown> = { billingStatus: 'active' }) {
  api.getExact(`/api/lawfirms/${FIRM_A}`, {
    lawFirm: { id: FIRM_A, name: 'Firm A', ownerId: MEMBER_A, plan, settings: {} },
  });
}

/**
 * The two firm members, by uid.
 *
 * Both permission codes sit outside the always-on baseline every member
 * receives, so they genuinely separate the two users; a `.view` code would be
 * granted to both by the baseline and could not.
 */
const MEMBERSHIPS: Record<string, Record<string, unknown>> = {
  [MEMBER_A]: { id: MEMBER_A, userId: MEMBER_A, name: 'Ada Admin', isOwner: false, permissions: ['clients.delete'] },
  [MEMBER_B]: { id: MEMBER_B, userId: MEMBER_B, name: 'Ben Bench', isOwner: false, permissions: ['tasks.create'] },
};

/**
 * `GET /members/me` answers for whoever holds the token, so the fake resolves
 * the row from the currently signed-in uid rather than returning a fixed one.
 * A caller who is not a member of this firm is refused, exactly as the route
 * refuses one.
 */
function seedMembers() {
  api.getExact(`/api/lawfirms/${FIRM_A}/members/me`, () => {
    const uid = (useAuthMock() as { user?: { uid?: string } } | null)?.user?.uid;
    const member = uid ? MEMBERSHIPS[uid] : undefined;
    if (!member) return { status: 403, body: { error: 'Not a member of this firm' } };
    return { member };
  });
}

function seedStatus(status: Record<string, unknown> = { billingStatus: 'active' }) {
  api.getExact(`/api/lawfirms/${FIRM_A}/subscriptions/status`, status);
}

function seedProfile(userType: string = 'firm_member') {
  api.getExact('/api/users/profile', { id: MEMBER_A, userType, name: 'Ada Admin' });
}

/** The whole happy path, so a spec only re-seeds the one route it is about. */
function seedWorkspace() {
  seedProfile();
  seedFirm();
  seedMembers();
  seedStatus();
}

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  __resetDuplicateRequestGuard();
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  usePathnameMock.mockReturnValue(`/lawfirm/${FIRM_A}/matters`);
  useAuthMock.mockReturnValue(signedInAs(MEMBER_A));
  window.history.replaceState({}, '', `/lawfirm/${FIRM_A}/matters`);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  window.history.replaceState({}, '', '/');
  mockSearchParams = new URLSearchParams();
  jest.clearAllMocks();
});

describe('returning from a calendar connect', () => {
  // The callback returns to whichever firm page started the connect, so the
  // shell, not one settings page, has to report what happened.
  it('reports the outcome on any firm page and removes it from the URL', async () => {
    mockSearchParams = new URLSearchParams('google_error=access_denied');
    seedWorkspace();

    render(workspace());

    expect(await screen.findByText('Google Calendar was not connected because access was declined.')).toBeInTheDocument();
    expect(screen.getByText('workspace content')).toBeInTheDocument();
    expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/matters`, { scroll: false });
  });
});

describe('waiting for an identity', () => {
  it('requests nothing at all while Firebase is still resolving the user', async () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    seedWorkspace();

    render(workspace());

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    // The assertion that matters: not "no firm request", but no request whose
    // url was built from an identity that does not exist yet.
    expect(api.calls()).toHaveLength(0);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to login carrying the page they asked for', async () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    usePathnameMock.mockReturnValue(`/lawfirm/${FIRM_A}/matters`);
    window.history.replaceState({}, '', `/lawfirm/${FIRM_A}/matters?tab=open`);
    seedWorkspace();

    render(workspace());

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/lawfirm/${FIRM_A}/matters?tab=open`)}`,
    ));
    expect(api.calls()).toHaveLength(0);
  });

  it('does not open the workspace for an unverified email', async () => {
    useAuthMock.mockReturnValue({
      user: { uid: MEMBER_A, email: 'new@example.test', emailVerified: false, providerData: [], metadata: {} },
      loading: false,
    });
    seedWorkspace();

    render(workspace());

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/verify-email'));
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
  });
});

describe('a sign-out that happens while the workspace is open', () => {
  it('tears the workspace down and cannot leave the previous member resolved', async () => {
    seedWorkspace();

    const { rerender } = render(workspace(<PermissionProbe />));

    await waitFor(() => expect(screen.getByTestId('probe-member')).toHaveTextContent(MEMBER_A));
    expect(screen.getByTestId('probe-permissions')).toHaveTextContent('clients.delete');

    useAuthMock.mockReturnValue({ user: null, loading: false });
    rerender(workspace(<PermissionProbe />));

    // The probe is gone, so no consumer can still read member A's permissions.
    expect(screen.queryByTestId('probe-member')).not.toBeInTheDocument();
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/lawfirm/${FIRM_A}/matters`)}`,
    ));
  });

  it('resolves the second user\'s own permissions when another signs in without a reload', async () => {
    seedWorkspace();

    const { rerender } = render(workspace(<PermissionProbe />));
    await waitFor(() => expect(screen.getByTestId('probe-member')).toHaveTextContent(MEMBER_A));

    useAuthMock.mockReturnValue({ user: null, loading: false });
    rerender(workspace(<PermissionProbe />));

    useAuthMock.mockReturnValue(signedInAs(MEMBER_B));
    rerender(workspace(<PermissionProbe />));

    await waitFor(() => expect(screen.getByTestId('probe-member')).toHaveTextContent(MEMBER_B));
    // Both codes are outside the always-on baseline every member receives, so
    // they actually separate the two users. A view-level code would not: the
    // baseline grants those to member B as well and the assertion would pass
    // even if the provider had kept member A's resolved set.
    expect(screen.getByTestId('probe-permissions')).toHaveTextContent('tasks.create');
    expect(screen.getByTestId('probe-permissions')).not.toHaveTextContent('clients.delete');
  });
});

describe('the firm-member guard', () => {
  it('redirects a portal client out of the firm shell and never renders it', async () => {
    seedProfile('client');
    seedFirm();
    seedMembers();
    seedStatus();

    render(workspace());

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/client/dashboard'));
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-billing-status')).not.toBeInTheDocument();
  });

  it('sends an account with no user type to finish registration', async () => {
    seedProfile('pending');
    seedFirm();
    seedMembers();
    seedStatus();

    render(workspace());

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/complete-registration'));
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
  });

  it('lets a member through when the profile read fails, because the backend still gates every request', async () => {
    api.getExact('/api/users/profile', { status: 503, body: { error: 'upstream' } });
    seedFirm();
    seedMembers();
    seedStatus();

    render(workspace());

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('a firm record that does not load', () => {
  it('names a refused firm as access denied rather than missing', async () => {
    seedProfile();
    seedMembers();
    seedStatus();
    api.getExact(`/api/lawfirms/${FIRM_A}`, { status: 403, body: { error: 'Forbidden' } });

    render(workspace());

    await waitFor(() => expect(screen.getByText('You do not have access to this firm')).toBeInTheDocument());
    expect(screen.queryByText("We couldn't find this law firm")).not.toBeInTheDocument();
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
  });

  it('names a missing firm as missing', async () => {
    seedProfile();
    seedMembers();
    seedStatus();
    api.getExact(`/api/lawfirms/${FIRM_A}`, { status: 404, body: { error: 'Not found' } });

    render(workspace());

    await waitFor(() => expect(screen.getByText("We couldn't find this law firm")).toBeInTheDocument());
  });

  it('offers a retry for an unreachable API, and opens the workspace when the retry answers', async () => {
    seedProfile();
    seedMembers();
    seedStatus();
    let attempts = 0;
    api.getExact(`/api/lawfirms/${FIRM_A}`, () => {
      attempts += 1;
      // The two automatic attempts are the cold-start retry inside the service.
      if (attempts <= 2) throw new TypeError('Failed to fetch');
      return { lawFirm: { id: FIRM_A, name: 'Firm A', ownerId: MEMBER_A, plan: { billingStatus: 'active' }, settings: {} } };
    });

    render(workspace());

    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 10000 });
    expect(screen.getByText("We're having trouble reaching the server")).toBeInTheDocument();
    expect(attempts).toBe(2);

    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
  }, 20000);

  it('shows the maintenance screen rather than a generic failure', async () => {
    seedProfile();
    seedMembers();
    seedStatus();
    api.getExact(`/api/lawfirms/${FIRM_A}`, {
      status: 503,
      body: { error: 'Maintenance mode', code: 'MAINTENANCE_MODE', maintenanceMode: true },
    });

    render(workspace());

    await waitFor(() => expect(screen.getByText('Paralegix is under maintenance')).toBeInTheDocument());
  });

  it('reports an unexpected server failure with the message, not as a missing firm', async () => {
    seedProfile();
    seedMembers();
    seedStatus();
    api.getExact(`/api/lawfirms/${FIRM_A}`, { status: 500, body: { error: 'boom in the firm reader' } });

    render(workspace());

    await waitFor(() => expect(screen.getByText("We couldn't open this law firm")).toBeInTheDocument());
    expect(screen.queryByText("We couldn't find this law firm")).not.toBeInTheDocument();
  });
});

describe('the billing gate', () => {
  it('opens the workspace and hands the sidebar the status it resolved', async () => {
    seedWorkspace();

    render(workspace());

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
    expect(screen.getByTestId('sidebar-billing-status')).toHaveTextContent('active');
  });

  it('resolves the subscription status once per workspace load', async () => {
    seedWorkspace();

    render(workspace());

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
    // The status endpoint is exempt from the billing gate and is read on the
    // critical path of every workspace open, so a second identical request is
    // paid for by every user on every navigation into a firm.
    expect(api.callsTo(`/lawfirms/${FIRM_A}/subscriptions/status`)).toHaveLength(1);
  });

  it('replaces the workspace with the paywall when the subscription is past due', async () => {
    seedProfile();
    seedMembers();
    seedFirm({ billingStatus: 'past_due' });
    seedStatus({ billingStatus: 'past_due' });

    render(workspace());

    await waitFor(() => expect(screen.getByText("A payment didn't go through")).toBeInTheDocument());
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
  });

  it('still opens billing settings while locked, so an owner can pay', async () => {
    usePathnameMock.mockReturnValue(`/lawfirm/${FIRM_A}/settings/billing`);
    seedProfile();
    seedMembers();
    seedFirm({ billingStatus: 'past_due' });
    seedStatus({ billingStatus: 'past_due' });

    render(workspace());

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
    expect(screen.queryByText("A payment didn't go through")).not.toBeInTheDocument();
  });

  it('falls back to the firm plan when the status endpoint fails, rather than opening the workspace', async () => {
    seedProfile();
    seedMembers();
    seedFirm({ billingStatus: 'canceled' });
    api.getExact(`/api/lawfirms/${FIRM_A}/subscriptions/status`, { status: 500, body: { error: 'stripe down' } });

    render(workspace());

    await waitFor(() => expect(screen.getByText('Your subscription has ended')).toBeInTheDocument());
  });

  it('locks a no-card trial that has run past its end date', async () => {
    seedProfile();
    seedMembers();
    seedFirm({ billingStatus: 'trialing' });
    seedStatus({ billingStatus: 'trialing', trialEndsAt: '2020-01-01T00:00:00.000Z' });

    render(workspace());

    await waitFor(() => expect(screen.getByText('Your trial has ended')).toBeInTheDocument());
  });

  it('leaves a Stripe-tracked trial open past that same date, because Stripe ends it', async () => {
    seedProfile();
    seedMembers();
    seedFirm({ billingStatus: 'trialing' });
    seedStatus({
      billingStatus: 'trialing',
      trialEndsAt: '2020-01-01T00:00:00.000Z',
      stripeSubscriptionId: 'sub_123',
    });

    render(workspace());

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());
  });
});

describe('the mount lifecycle repeating, as React Strict Mode makes it', () => {
  it('opens the workspace once, with one read of each bootstrap route', async () => {
    seedWorkspace();

    render(
      <React.StrictMode>
        {workspace()}
      </React.StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('workspace content')).toBeInTheDocument());

    // Strict Mode mounts, unmounts and remounts every effect. A bootstrap read
    // that issues one request per mount doubles the cost of opening a firm for
    // every user in development, and hides a missing cleanup in production.
    expect(api.callsTo(`/lawfirms/${FIRM_A}/subscriptions/status`)).toHaveLength(1);
    expect(api.callsTo('/api/users/profile')).toHaveLength(1);
    expect(api.callsTo(`/lawfirms/${FIRM_A}/members/me`)).toHaveLength(1);
  });

  it('leaves no billing-lock listener behind when the workspace unmounts', async () => {
    seedWorkspace();
    api.getExact(`/api/lawfirms/${FIRM_A}/matters`, {
      status: 402,
      body: { error: 'Billing inactive', code: 'BILLING_INACTIVE', details: { billingStatus: 'canceled' } },
    });

    const { unmount } = render(workspace(<BillingRefusalProbe path={`/lawfirms/${FIRM_A}/matters`} />));
    await screen.findByRole('button', { name: 'load page data' });

    unmount();

    // A 402 raised after the layout is gone must not reach a listener it left
    // registered. The subscriber sets state, so a surviving one warns at best
    // and updates a dead tree at worst.
    await apiFetch(`http://localhost:5001/api/lawfirms/${FIRM_A}/matters`).catch(() => {});

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Billing lock listener failed'),
      expect.anything(),
    );
  });
});

describe('a 402 that arrives after the workspace is already open', () => {
  it('raises the paywall for a refusal scoped to this firm', async () => {
    seedWorkspace();
    api.getExact(`/api/lawfirms/${FIRM_A}/matters`, {
      status: 402,
      body: { error: 'Billing inactive', code: 'BILLING_INACTIVE', details: { billingStatus: 'canceled' } },
    });

    render(workspace(<BillingRefusalProbe path={`/lawfirms/${FIRM_A}/matters`} />));

    const load = await screen.findByRole('button', { name: 'load page data' });
    await userEvent.click(load);

    // The status the 402 carried wins over the stale 'active' the layout fetched.
    await waitFor(() => expect(screen.getByText('Your subscription has ended')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'load page data' })).not.toBeInTheDocument();
  });

  it('ignores a refusal that names a different firm', async () => {
    seedWorkspace();
    api.getExact(`/api/lawfirms/${OTHER_FIRM}/matters`, {
      status: 402,
      body: { error: 'Billing inactive', code: 'BILLING_INACTIVE', details: { billingStatus: 'canceled' } },
    });

    render(workspace(<BillingRefusalProbe path={`/lawfirms/${OTHER_FIRM}/matters`} />));

    const load = await screen.findByRole('button', { name: 'load page data' });
    await userEvent.click(load);

    await waitFor(() => expect(api.callsTo(`/lawfirms/${OTHER_FIRM}/matters`)).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'load page data' })).toBeInTheDocument();
    expect(screen.queryByText('Your subscription has ended')).not.toBeInTheDocument();
  });
});

describe('query cache', () => {
  /** Hands the workspace's own QueryClient back to the spec. */
  function QueryClientProbe({ onClient }: { onClient: (client: QueryClient) => void }) {
    const client = useQueryClient();
    onClient(client);
    return <div>query probe</div>;
  }

  it('serves pages a client that does not refetch on focus and keeps results fresh for two minutes', async () => {
    seedWorkspace();
    let client: QueryClient | null = null;

    render(workspace(<QueryClientProbe onClient={(c) => { client = c; }} />));
    await screen.findByText('query probe');

    const queries = (client as QueryClient | null)?.getDefaultOptions().queries;
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.staleTime).toBe(2 * 60_000);
  });

  it('marks cached results stale after a successful write made from inside the workspace', async () => {
    seedWorkspace();
    api.post(`/api/lawfirms/${FIRM_A}/matters`, { matter: { id: 'm-1' } });
    let client: QueryClient | null = null;

    render(workspace(<QueryClientProbe onClient={(c) => { client = c; }} />));
    await screen.findByText('query probe');
    const workspaceClient = client as unknown as QueryClient;
    workspaceClient.setQueryData(['matters', FIRM_A], []);
    expect(workspaceClient.getQueryState(['matters', FIRM_A])?.isInvalidated).toBe(false);

    await apiFetch(`http://localhost:5001/api/lawfirms/${FIRM_A}/matters`, { method: 'POST', body: '{}' });

    expect(workspaceClient.getQueryState(['matters', FIRM_A])?.isInvalidated).toBe(true);
  });
});
