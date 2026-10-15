/**
 * Client-portal association resolution at the layout boundary.
 *
 * A portal UID can have a personal client record and company roster records in
 * the same firm. ClientLayoutClient selects one before any child page fetches,
 * so this is the boundary that prevents one record's documents, billing, and
 * matters from being rendered under another record's choice.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
// The global setup narrows this context to its hook for ordinary component
// tests. The layout renders the provider itself, so this integration contract
// needs the real context object too.
jest.unmock('@/contexts/NavigationContext');

const mockRouterPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: jest.fn(),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));

const mockSetAnalyticsContext = jest.fn();
jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  setAnalyticsContext: (...args: unknown[]) => mockSetAnalyticsContext(...args),
}));

jest.mock('@/services/users.service', () => ({
  __esModule: true,
  default: { getProfile: jest.fn() },
}));

// The resolver passes its result to the real sidebar. This shallow boundary
// keeps the spec about the layout's association contract rather than unrelated
// unread-count, animation, and icon behavior inside that sidebar. It does read
// the navigation context, because the sidebar's notification bell navigates
// through it and the layout is what provides it.
jest.mock('@/components/sidebar/ClientSidebar', () => {
  const React = require('react');
  const { useNavigation } = jest.requireActual('@/contexts/NavigationContext');
  function ClientSidebarProbe({
    associations, activeClientRecordId, onSwitchClientRecord,
  }: {
    associations: Array<{ clientRecordId: string }>;
    activeClientRecordId: string | null;
    onSwitchClientRecord: (id: string) => void;
  }) {
    const { navigate } = useNavigation();
    return React.createElement('aside', null,
      React.createElement('output', { 'data-testid': 'association-count' }, String(associations.length)),
      React.createElement('output', { 'data-testid': 'active-client-record' }, activeClientRecordId || ''),
      React.createElement('button', { type: 'button', onClick: () => onSwitchClientRecord('person-record') }, 'choose person'),
      React.createElement('button', { type: 'button', onClick: () => navigate('/client/lawfirm/firm-a/documents') }, 'sidebar navigate'),
    );
  }
  return {
    __esModule: true,
    default: ClientSidebarProbe,
  };
});

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import ClientLayoutClient from '@/app/client/ClientLayoutClient';
import { useAuth } from '@/hooks/useAuth';
import userService from '@/services/users.service';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';
import userEvent from '@testing-library/user-event';

const usePathnameMock = usePathname as jest.Mock;
const useAuthMock = useAuth as jest.Mock;
const getProfileMock = userService.getProfile as jest.Mock;

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const PERSON_RECORD = 'person-record';
const COMPANY_RECORD = 'company-record';

const api = setupApiMock();

const associations = [
  { clientRecordId: PERSON_RECORD, clientType: 'person', clientName: 'Pat Person', companyLinkId: null, canViewBilling: true },
  { clientRecordId: COMPANY_RECORD, clientType: 'company', clientName: 'Acme Org', companyLinkId: 'link-1', canViewBilling: false },
];

function firmList() {
  return {
    lawFirms: [
      { id: FIRM_A, name: 'Firm A', features: { clientPortal: true } },
      { id: FIRM_B, name: 'Firm B', features: { clientPortal: true } },
    ],
  };
}

function renderLayout() {
  return render(<ClientLayoutClient><div>portal content</div></ClientLayoutClient>);
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  localStorage.clear();
  window.history.replaceState({}, '', '/client/lawfirm/firm-a/matters');
  usePathnameMock.mockReturnValue('/client/lawfirm/firm-a/matters');
  useAuthMock.mockReturnValue({
    user: { uid: 'portal-user', emailVerified: true, email: 'pat@example.test' },
    loading: false,
  });
  getProfileMock.mockResolvedValue({ id: 'portal-user', userType: 'client', name: 'Pat Person' });
  api.getExact('/api/client-portal/my-lawfirms', firmList());
});

afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  jest.clearAllMocks();
});

describe('ClientLayoutClient association resolution', () => {
  it('auto-selects and persists the sole association before rendering portal children', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, {
      associations: [associations[0]],
    });

    renderLayout();

    await waitFor(() => expect(screen.getByTestId('active-client-record')).toHaveTextContent(PERSON_RECORD));
    expect(screen.getByText('portal content')).toBeInTheDocument();
    expect(localStorage.getItem(`paralegix-client-active-record:${FIRM_A}`)).toBe(PERSON_RECORD);
    expect(api.callsTo(`/lawfirm/${FIRM_A}/associations`)).toHaveLength(1);
  });

  it('requires a choice when an invalid saved record meets multiple associations', async () => {
    localStorage.setItem(`paralegix-client-active-record:${FIRM_A}`, 'revoked-record');
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, { associations });

    renderLayout();

    await waitFor(() => expect(screen.getByTestId('association-count')).toHaveTextContent('2'));
    expect(screen.getByTestId('active-client-record')).toHaveTextContent('');
    expect(localStorage.getItem(`paralegix-client-active-record:${FIRM_A}`)).toBeNull();
  });

  it('lets a valid deep link override a prior persisted association and persists an explicit later choice', async () => {
    localStorage.setItem(`paralegix-client-active-record:${FIRM_A}`, PERSON_RECORD);
    window.history.replaceState({}, '', `/client/lawfirm/${FIRM_A}/matters?clientRecordId=${COMPANY_RECORD}`);
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, { associations });

    renderLayout();

    await waitFor(() => expect(screen.getByTestId('active-client-record')).toHaveTextContent(COMPANY_RECORD));
    expect(localStorage.getItem(`paralegix-client-active-record:${FIRM_A}`)).toBe(COMPANY_RECORD);

    await act(async () => {
      screen.getByRole('button', { name: 'choose person' }).click();
    });
    expect(screen.getByTestId('active-client-record')).toHaveTextContent(PERSON_RECORD);
    expect(localStorage.getItem(`paralegix-client-active-record:${FIRM_A}`)).toBe(PERSON_RECORD);
  });

  it('does not let a delayed association response for firm A replace firm B', async () => {
    const heldFirmA = holdResponse();
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, heldFirmA.handler);
    api.getExact(`/api/client-portal/lawfirm/${FIRM_B}/associations`, {
      associations: [{ ...associations[1], clientRecordId: 'firm-b-record' }],
    });

    const view = renderLayout();
    await waitFor(() => expect(api.callsTo(`/lawfirm/${FIRM_A}/associations`)).toHaveLength(1));

    // The layout deliberately refreshes the firm list when its firm scope
    // changes. This is a new navigation boundary, not two callers competing
    // for the same stable query, so keep the dev-only duplicate detector from
    // treating the transition itself as a test warning.
    __resetDuplicateRequestGuard();
    usePathnameMock.mockReturnValue(`/client/lawfirm/${FIRM_B}/matters`);
    window.history.replaceState({}, '', `/client/lawfirm/${FIRM_B}/matters`);
    view.rerender(<ClientLayoutClient><div>portal content</div></ClientLayoutClient>);

    await waitFor(() => expect(screen.getByTestId('active-client-record')).toHaveTextContent('firm-b-record'));

    await act(async () => {
      heldFirmA.release({ associations: [associations[0]] });
    });

    expect(screen.getByTestId('active-client-record')).toHaveTextContent('firm-b-record');
  });
});

describe('ClientLayoutClient navigation context', () => {
  it('focuses the destination on route changes without stealing focus on a content update', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, {
      associations: [associations[0]],
    });
    const view = render(<ClientLayoutClient><h1>My Matters</h1><input aria-label="Search matters" /></ClientLayoutClient>);
    const search = await screen.findByRole('textbox', { name: 'Search matters' });
    search.focus();
    view.rerender(<ClientLayoutClient><h1>My Matters</h1><input aria-label="Search matters" /><p>Updated results</p></ClientLayoutClient>);
    expect(search).toHaveFocus();
    usePathnameMock.mockReturnValue('/client/lawfirm/firm-a/documents');
    view.rerender(<ClientLayoutClient><h1>Documents</h1><button>Upload</button></ClientLayoutClient>);
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
  });

  it('lets the skip link move keyboard focus into portal content', async () => {
    const user = userEvent.setup();
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, {
      associations: [associations[0]],
    });
    renderLayout();
    await screen.findByText('portal content');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    skip.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('lets the sidebar navigate through the router, which the notification bell depends on', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, {
      associations: [associations[0]],
    });

    renderLayout();
    await waitFor(() => expect(screen.getByTestId('active-client-record')).toHaveTextContent(PERSON_RECORD));

    await act(async () => {
      screen.getByRole('button', { name: 'sidebar navigate' }).click();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/client/lawfirm/firm-a/documents');
  });
});

// A shared browser remembers the last client's firm. Until the server confirms
// which firms this client belongs to, analytics must not file their activity
// under that leftover firm.
describe('ClientLayoutClient analytics firm', () => {
  it('tags only the firm the server confirms, never a firm left in storage by someone else', async () => {
    localStorage.setItem('paralegix-client-lawfirm', 'firm-of-previous-client');
    window.history.replaceState({}, '', '/client');
    usePathnameMock.mockReturnValue('/client');
    api.getExact('/api/client-portal/lawfirm/firm-of-previous-client/associations', {
      status: 403,
      body: { error: 'Forbidden' },
    });
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/associations`, { associations: [associations[0]] });
    api.allowUnhandled();

    renderLayout();

    await waitFor(() => expect(mockSetAnalyticsContext).toHaveBeenCalledWith('client', FIRM_A));
    const firmsTagged = mockSetAnalyticsContext.mock.calls.map(([, firmId]) => firmId);
    expect(firmsTagged).not.toContain('firm-of-previous-client');
  });
});
