/**
 * The firm's team/clients settings page: a plain `useState`/`useEffect` load
 * for members and pending invites, plus two paged `useQuery` reads (active
 * clients window + total) that share a cache key with the rest of the app's
 * client list.
 *
 * `lawfirm.service`, `clients.service`, `roles.service` and
 * `requestDeduplicator` run for real against a faked transport, so a wrong
 * url, a swallowed error, or a stale response reaching a switched firm fails
 * the spec instead of a stubbed hook quietly returning whatever the test
 * handed it.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/roles.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/settings/members',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import MembersPage from '@/app/lawfirm/[lawFirmId]/settings/members/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { holdResponse } from '../../../support/deferred';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function membersUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/members`;
}
function memberUrl(firmId: string, memberId: string): string {
  return `${membersUrl(firmId)}/${memberId}`;
}
function pendingClientInvitesUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/invitations/pending-client-invites`;
}
function pendingMemberInvitesUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/invitations/pending-member-invites`;
}
function rolesUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/roles`;
}
function clientsBase(firmId: string): string {
  return `${API}/lawfirms/${firmId}/clients`;
}
/** The default first active-clients page: no pending invites ahead of it, no search. */
function activeClientsUrl(firmId: string, limit = 10): string {
  return `${clientsBase(firmId)}?limit=${limit}&offset=0&sortBy=name&order=asc`;
}
function clientsTotalUrl(firmId: string): string {
  return `${clientsBase(firmId)}?limit=1&offset=0`;
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'member-1',
    name: 'Jane Attorney',
    email: 'jane@example.test',
    roleId: 'role-1',
    isOwner: false,
    ...overrides,
  };
}

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    name: 'Attorney',
    isBuiltIn: true,
    permissions: ['matters.view'],
    ...overrides,
  };
}

/** Every route the page fetches on mount, for one firm, with an empty roster by default. */
function seedMembersWorkspace(opts: {
  firmId?: string;
  members?: unknown[];
  pendingMembers?: unknown[];
  pendingClients?: unknown[];
  roles?: unknown[];
  clients?: unknown[];
  clientsTotal?: number;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const clients = opts.clients ?? [];
  const total = opts.clientsTotal ?? clients.length;
  api.getExact(membersUrl(firmId), opts.members ?? []);
  api.getExact(pendingClientInvitesUrl(firmId), { invites: opts.pendingClients ?? [] });
  api.getExact(pendingMemberInvitesUrl(firmId), { invites: opts.pendingMembers ?? [] });
  api.getExact(rolesUrl(firmId), opts.roles ?? [role()]);
  api.getExact(activeClientsUrl(firmId), { clients, totalItems: total });
  api.getExact(clientsTotalUrl(firmId), { clients: clients.slice(0, 1), totalItems: total });
}

function renderMembersPage() {
  return renderWithProviders(<MembersPage />);
}

async function openClientsTab() {
  await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('autocompletes the organization in the Add Client modal', async () => {
    seedMembersWorkspace();
    api.get('/clients/lookup', (call) => ({
      items: call.query.clientType?.[0] === 'company' ? [{ id: 'org-1', label: 'Delgado Freight LLC' }] : [],
      hasMore: false,
    }));
    renderMembersPage();
    await screen.findByText('No members yet.');
    await openClientsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Add Client' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Client' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Organization' }), 'delgado');
    await userEvent.click(await screen.findByRole('option', { name: 'Delgado Freight LLC' }));

    expect(within(dialog).getByRole('combobox', { name: 'Organization' })).toHaveValue('Delgado Freight LLC');
    expect(api.callsTo('/clients/lookup').some((call) => call.query.clientType?.[0] === 'company')).toBe(true);
  });

  it('shows the real members and, on the clients tab, the real associated clients', async () => {
    seedMembersWorkspace({
      members: [member()],
      clients: [{ id: 'client-1', name: 'Acme Corp', email: 'acme@example.test' }],
    });

    renderMembersPage();

    expect(await screen.findByText('Jane Attorney')).toBeInTheDocument();
    expect(screen.getByText('jane@example.test')).toBeInTheDocument();

    await openClientsTab();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no members and no clients rather than rendering blank lists', async () => {
    seedMembersWorkspace();

    renderMembersPage();

    expect(await screen.findByText('No members yet.')).toBeInTheDocument();

    await openClientsTab();
    expect(await screen.findByText('No clients associated yet.')).toBeInTheDocument();
  });
});

describe('an API failure', () => {
  it('tells the user the member list failed to load', async () => {
    seedMembersWorkspace();
    api.getExact(membersUrl(FIRM_A), { status: 500, body: { error: 'members service unavailable' } });

    renderMembersPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/members service unavailable/i);
  });
});

describe('narrow role behavior', () => {
  it('lets a baseline member view the roster read-only, with no invite/role/remove controls', async () => {
    grantBaselineMember();
    seedMembersWorkspace({
      members: [member()],
      clients: [{ id: 'client-1', name: 'Acme Corp', email: 'acme@example.test' }],
    });

    renderMembersPage();

    expect(await screen.findByText('Jane Attorney')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite Member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change member role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();

    await openClientsTab();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedMembersWorkspace({ members: [member()] });

    renderMembersPage();

    expect(await screen.findByText('Jane Attorney')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite Member' })).not.toBeInTheDocument();
  });
});

describe('a successful representative action', () => {
  it('removes a member and reflects the removal in the list', async () => {
    grantBaselineMember(['members.remove']);
    seedMembersWorkspace({});
    api.getExact(membersUrl(FIRM_A), sequence(
      [member(), member({ userId: 'member-2', name: 'Bob Paralegal', email: 'bob@example.test' })],
      [member()],
    ));
    api.deleteExact(memberUrl(FIRM_A, 'member-2'), { message: 'Member removed' });

    renderMembersPage();

    await screen.findByText('Bob Paralegal');
    const rows = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(rows[rows.length - 1]);

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('Bob Paralegal')).not.toBeInTheDocument());
    expect(await screen.findByText('Member removed successfully.')).toBeInTheDocument();
    expect(screen.getByText('Jane Attorney')).toBeInTheDocument();
    expect(api.callsTo(`/lawfirms/${FIRM_A}/members/member-2`)).toHaveLength(1);
  });
});

describe('a refused action', () => {
  it('shows the server refusal and keeps the member in the list', async () => {
    grantBaselineMember(['members.remove']);
    seedMembersWorkspace({ members: [member()] });
    api.deleteExact(memberUrl(FIRM_A, 'member-1'), {
      status: 403,
      body: { error: 'The firm must keep at least one attorney' },
    });

    renderMembersPage();

    await screen.findByText('Jane Attorney');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText(/The firm must keep at least one attorney/)).toBeInTheDocument();
    expect(screen.getByText('Jane Attorney')).toBeInTheDocument();
  });

  it('says why inside the still-open dialog, not in a banner behind its backdrop', async () => {
    grantBaselineMember(['members.remove']);
    seedMembersWorkspace({ members: [member()] });
    api.deleteExact(memberUrl(FIRM_A, 'member-1'), {
      status: 403,
      body: { error: 'The firm must keep at least one attorney' },
    });

    renderMembersPage();

    await screen.findByText('Jane Attorney');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The firm must keep at least one attorney',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('clears the previous refusal when the dialog is opened again', async () => {
    grantBaselineMember(['members.remove']);
    seedMembersWorkspace({ members: [member()] });
    api.deleteExact(memberUrl(FIRM_A, 'member-1'), {
      status: 403,
      body: { error: 'The firm must keep at least one attorney' },
    });

    renderMembersPage();

    await screen.findByText('Jane Attorney');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Add Client', () => {
  // The button opens a form that POSTs /clients, which requires clients.manage;
  // clients.invite alone only covers portal invitations.
  it('is hidden from a member who can invite clients but not manage them', async () => {
    grantBaselineMember(['clients.invite']);
    seedMembersWorkspace();

    renderMembersPage();

    await screen.findByText('No members yet.');
    await openClientsTab();
    await screen.findByText(/No clients/);
    expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument();
  });

  it('sends null for a None preferred contact, so the client is not stored as preferring email', async () => {
    grantBaselineMember(['clients.invite', 'clients.manage']);
    seedMembersWorkspace();
    api.allowUnhandled();
    api.postExact(clientsBase(FIRM_A), { message: 'ok', clientId: 'client-new', portalStatus: null });

    renderMembersPage();

    await screen.findByText('No members yet.');
    await openClientsTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Client' });
    await userEvent.type(within(dialog).getByPlaceholderText('Full name'), 'Rosa Diaz');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Client' }));

    await waitFor(() =>
      expect(api.callsTo(`/lawfirms/${FIRM_A}/clients`).filter((c) => c.method === 'POST')).toHaveLength(1));
    const [create] = api.callsTo(`/lawfirms/${FIRM_A}/clients`).filter((c) => c.method === 'POST');
    // A missing field is defaulted to email by the server; null is a chosen None.
    expect(create.body).toHaveProperty('preferredContactMethod', null);
  });

  it('is offered to a member holding both clients.invite and clients.manage', async () => {
    grantBaselineMember(['clients.invite', 'clients.manage']);
    seedMembersWorkspace();

    renderMembersPage();

    await screen.findByText('No members yet.');
    await openClientsTab();
    expect(await screen.findByRole('button', { name: 'Add Client' })).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm overwrite the new firm\'s member list once it finally resolves', async () => {
    seedMembersWorkspace({ firmId: FIRM_B, members: [member({ userId: 'member-b', name: 'Firm B Member' })] });
    // Firm A's own read is the SLOW one here: it is still in flight at the
    // moment of the switch, and (without the fix) lands well after firm B's
    // fast response has already rendered.
    api.getExact(membersUrl(FIRM_A), { delayMs: 250, body: [member({ name: 'Firm A Member' })] });
    api.getExact(pendingClientInvitesUrl(FIRM_A), { invites: [] });
    api.getExact(pendingMemberInvitesUrl(FIRM_A), { invites: [] });
    api.getExact(rolesUrl(FIRM_A), [role()]);
    api.getExact(activeClientsUrl(FIRM_A), { clients: [], totalItems: 0 });
    api.getExact(clientsTotalUrl(FIRM_A), { clients: [], totalItems: 0 });

    const { rerender } = renderMembersPage();

    // Switch to firm B before firm A's slow `/members` read has resolved.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<MembersPage />);

    await waitFor(() => expect(screen.getByText('Firm B Member')).toBeInTheDocument());

    // Let firm A's delayed response land. Without the generation-counter
    // guard, this overwrites the already-rendered firm B roster with firm A's
    // stale member list.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.queryByText('Firm A Member')).not.toBeInTheDocument();
    expect(screen.getByText('Firm B Member')).toBeInTheDocument();
  });

  it('never renders the old firm\'s associated-clients page under the new firm\'s clients tab', async () => {
    seedMembersWorkspace({ firmId: FIRM_A, clients: [{ id: 'c-a', name: 'Firm A Client', email: 'a@example.test' }] });
    seedMembersWorkspace({ firmId: FIRM_B, clients: [{ id: 'c-b', name: 'Firm B Client', email: 'b@example.test' }] });
    // Firm B's paged client read is slow, so it is still in flight the instant
    // the firm switch happens - well after the page's OWN (unrelated, fast)
    // members/invites load has already resolved for firm B.
    api.getExact(activeClientsUrl(FIRM_B), { delayMs: 200, body: { clients: [{ id: 'c-b', name: 'Firm B Client', email: 'b@example.test' }], totalItems: 1 } });

    const { rerender } = renderMembersPage();
    await openClientsTab();
    await screen.findByText('Firm A Client');

    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<MembersPage />);

    // The clients panel is gated on `loading || activeClientsLoading`: `loading`
    // (the page's own member/invites read) settles quickly since it is not
    // delayed, while `activeClientsLoading` must stay true for the whole 200ms
    // firm B's real paged-clients read is in flight. An unguarded
    // `placeholderData` collapses `activeClientsLoading` to false the instant
    // the query key changes, which would let the spinner clear early and reveal
    // firm A's stale rows well before firm B's real response lands - so once the
    // spinner is gone, only firm B's row may ever have been on screen.
    await waitFor(() => expect(screen.queryByText('Loading clients')).not.toBeInTheDocument());
    expect(screen.queryByText('Firm A Client')).not.toBeInTheDocument();
    expect(screen.getByText('Firm B Client')).toBeInTheDocument();
  });
});

it('retries a failed member load and shows the recovered roster', async () => {
  seedMembersWorkspace();
  api.getExact(membersUrl(FIRM_A), sequence(
    { status: 500, body: { error: 'members service unavailable' } },
    [member()],
  ));
  renderMembersPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('members service unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Jane Attorney')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

describe('Escape while a new client is being added', () => {
  // Red if: the Add Client dialog stays dismissible (or its Cancel stays
  // enabled) while the create POST is pending, so Escape closes it mid-save and
  // a refused create reports into a closed dialog.
  it('keeps the Add Client dialog open and Cancel disabled until the create settles', async () => {
    seedMembersWorkspace();
    api.get('/clients/lookup', { items: [], hasMore: false });
    const post = holdResponse();
    api.postExact(clientsBase(FIRM_A), post.handler);
    renderMembersPage();
    await screen.findByText('No members yet.');
    await openClientsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Add Client' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Client' });
    await userEvent.type(within(dialog).getByPlaceholderText('Full name'), 'Rosa Delgado');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Client' }));

    await post.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    // The page's close only flips its open flag, and the Modal stays mounted for
    // its 100ms exit animation, so the check has to outlast that window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByRole('dialog', { name: 'Add Client' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ client: { id: 'client-9', name: 'Rosa Delgado' }, portalStatus: 'none' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Client' })).not.toBeInTheDocument());
    expect(await screen.findByText('Rosa Delgado added.')).toBeInTheDocument();
  });
});
