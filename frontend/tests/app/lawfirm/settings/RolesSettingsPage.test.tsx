/**
 * The firm's role management settings page: `useRoles` driving a `ListView` of
 * built-in and custom roles, gated on `firm.manageRoles` for anything that
 * writes.
 *
 * `roles.service` and `requestDeduplicator` run for real against a faked
 * transport, so a wrong url, a swallowed error, or a stale response reaching a
 * switched firm fails the spec instead of a stubbed hook quietly returning
 * whatever the test handed it.
 */
jest.unmock('@/services/roles.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/settings/roles',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RolesSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/roles/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { Role } from '@/types/role';
import { PERMISSIONS } from '@/lib/constants/permissions';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function rolesUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/roles`;
}

function roleUrl(firmId: string, roleId: string): string {
  return `${rolesUrl(firmId)}/${roleId}`;
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-1',
    name: 'Attorney',
    isBuiltIn: true,
    permissions: ['matters.view', 'matters.create'],
    ...overrides,
  } as Role;
}

function renderRolesPage() {
  return renderWithProviders(<RolesSettingsPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real roles returned by the server, most-privileged first', async () => {
    api.getExact(rolesUrl(FIRM_A), [
      role({ id: 'role-1', name: 'Attorney', isBuiltIn: true, permissions: ['matters.view', 'matters.create'] }),
      role({ id: 'role-2', name: 'Contract Reviewer', isBuiltIn: false, permissions: ['clients.view'] }),
    ]);

    renderRolesPage();

    expect(await screen.findByText('Attorney')).toBeInTheDocument();
    expect(screen.getByText('Contract Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('2 permissions')).toBeInTheDocument();
    expect(screen.getByText('1 permission')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no roles were found rather than rendering a blank list', async () => {
    api.getExact(rolesUrl(FIRM_A), []);

    renderRolesPage();

    expect(await screen.findByText('No roles found')).toBeInTheDocument();
    expect(screen.getByText('Create a role to get started.')).toBeInTheDocument();
  });
});

describe('an API failure', () => {
  it('tells the user the role list failed to load', async () => {
    api.getExact(rolesUrl(FIRM_A), { status: 500, body: { error: 'roles service unavailable' } });

    renderRolesPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/roles service unavailable/i);
  });
});

describe('narrow role behavior', () => {
  it('lets a member without firm.manageRoles view roles but not create, edit, or delete them', async () => {
    grantBaselineMember();
    api.getExact(rolesUrl(FIRM_A), [
      role({ id: 'role-1', name: 'Attorney', isBuiltIn: true }),
      role({ id: 'role-2', name: 'Custom Role', isBuiltIn: false }),
    ]);

    renderRolesPage();

    expect(await screen.findByText('Attorney')).toBeInTheDocument();
    expect(screen.getByText(/only members with/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Role' })).toBeDisabled();

    // Row click would normally open the editor for someone who can manage roles.
    await userEvent.click(screen.getByText('Custom Role'));
    expect(screen.queryByText('Edit Role')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Role')).not.toBeInTheDocument();

    // Without firm.manageRoles every icon button's tooltip reads "You cannot
    // manage roles" instead of "Edit"/"Delete", and each one is disabled.
    const restrictedButtons = screen
      .getAllByLabelText('You cannot manage roles')
      .map((wrap) => within(wrap).getByRole('button'));
    expect(restrictedButtons.length).toBeGreaterThan(0);
    restrictedButtons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    api.getExact(rolesUrl(FIRM_A), [role()]);

    renderRolesPage();

    expect(await screen.findByText('Attorney')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Role' })).toBeDisabled();
  });
});

describe('a successful representative action', () => {
  it('deletes a custom role and reflects the removal in the list', async () => {
    grantBaselineMember(['firm.manageRoles']);
    // "Owner" is the only role name the page hides the delete affordance for,
    // so this is the one fixture where "Delete" resolves to a single element.
    api.getExact(rolesUrl(FIRM_A), sequence(
      [role({ id: 'role-1', name: 'Owner', isBuiltIn: true }), role({ id: 'role-2', name: 'Contract Reviewer', isBuiltIn: false })],
      [role({ id: 'role-1', name: 'Owner', isBuiltIn: true })],
    ));
    api.deleteExact(roleUrl(FIRM_A, 'role-2'), { message: 'Role deleted' });

    renderRolesPage();

    await screen.findByText('Contract Reviewer');
    // The icon button's accessible name lives on the Tooltip's wrapping span,
    // not the button itself.
    const deleteWrap = screen.getByLabelText('Delete');
    await userEvent.click(within(deleteWrap).getByRole('button'));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Contract Reviewer')).not.toBeInTheDocument());
    expect(await screen.findByText(/Deleted role "Contract Reviewer"/)).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});

describe('a refused action', () => {
  it('shows the server refusal and keeps the role in the list', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), [
      role({ id: 'role-1', name: 'Owner', isBuiltIn: true }),
      role({ id: 'role-2', name: 'Contract Reviewer', isBuiltIn: false }),
    ]);
    api.deleteExact(roleUrl(FIRM_A, 'role-2'), {
      status: 403,
      body: { error: 'Members are still assigned to this role' },
    });

    renderRolesPage();

    await screen.findByText('Contract Reviewer');
    const deleteWrap = screen.getByLabelText('Delete');
    await userEvent.click(within(deleteWrap).getByRole('button'));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    // The dialog stays open on a refusal, so the reason belongs inside it: a
    // page banner would sit behind the backdrop.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Members are still assigned to this role');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // The refused delete must not have removed the role from view.
    expect(screen.getByText('Contract Reviewer')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s role list', async () => {
    api.getExact(rolesUrl(FIRM_A), [role({ id: 'role-1', name: 'Firm A Attorney', isBuiltIn: true })]);
    api.getExact(rolesUrl(FIRM_B), { delayMs: 200, body: [role({ id: 'role-b', name: 'Firm B Attorney', isBuiltIn: true })] });

    const { rerender } = renderRolesPage();
    await screen.findByText('Firm A Attorney');

    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<RolesSettingsPage />);

    // `useRoles` keys its query on `['roles', lawFirmId]` with no
    // `placeholderData`, so switching firms must clear firm A's rows
    // immediately rather than holding them over while firm B's slower request
    // is still in flight.
    expect(screen.queryByText('Firm A Attorney')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Firm B Attorney')).toBeInTheDocument());
    expect(screen.queryByText('Firm A Attorney')).not.toBeInTheDocument();
  });
});

describe('saving role permissions', () => {
  it('creates a role with the selected permissions and trims its name', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), sequence([], [role({ name: 'Reviewer', isBuiltIn: false })]));
    api.postExact(rolesUrl(FIRM_A), { role: role({ name: 'Reviewer', isBuiltIn: false }) });
    renderRolesPage();
    await screen.findByText('No roles found');
    await userEvent.click(screen.getByRole('button', { name: 'New Role' }));
    await userEvent.type(screen.getByLabelText(/Role Name/), '  Reviewer  ');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    const baseline = screen.getByRole('checkbox', { name: /View Dashboard/ });
    expect(baseline).toBeChecked();
    expect(baseline).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Create Matters/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Role' }));
    await screen.findByText('Created role "Reviewer"');
    expect(api.calls('POST')[0].body).toEqual({ name: 'Reviewer', permissions: ['matters.create'] });
  });

  it('updates built-in role permissions without attempting to rename it', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), [role()]);
    api.putExact(roleUrl(FIRM_A, 'role-1'), { role: role({ permissions: Object.keys(PERMISSIONS) }) });
    renderRolesPage();
    await userEvent.click(await screen.findByText('Attorney'));
    expect(screen.getByLabelText(/Role Name/)).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Select All' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Role' }));
    await screen.findByText('Updated role "Attorney"');
    expect(api.calls('PUT')[0].body).toEqual({ permissions: Object.keys(PERMISSIONS) });
  });

  it('sends the reads a held manage permission implies when a role is saved', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), [role({ permissions: ['billing.manageInvoices'] })]);
    api.putExact(roleUrl(FIRM_A, 'role-1'), { role: role() });
    renderRolesPage();
    await userEvent.click(await screen.findByText('Attorney'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Role' }));
    await screen.findByText('Updated role "Attorney"');
    expect(api.calls('PUT')[0].body).toEqual({
      permissions: ['billing.manageInvoices', 'billing.viewInvoices', 'billing.viewRates'],
    });
  });

  it('does not let a non-owner admin open the Owner role, whose save the server always refuses', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), [
      role({ id: 'role-owner', name: 'Owner', permissions: Object.keys(PERMISSIONS) }),
      role({ id: 'role-1', name: 'Attorney' }),
    ]);
    renderRolesPage();

    await screen.findByText('Attorney');
    expect(screen.getByRole('button', { name: 'Edit Owner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Attorney' })).toBeEnabled();
    await userEvent.click(screen.getByText('Owner'));
    expect(screen.queryByRole('region', { name: 'Edit Role' })).not.toBeInTheDocument();
  });

  it('lets the firm owner open the Owner role', async () => {
    api.getExact(rolesUrl(FIRM_A), [
      role({ id: 'role-owner', name: 'Owner', permissions: Object.keys(PERMISSIONS) }),
    ]);
    renderRolesPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Owner' }));
    expect(screen.getByRole('region', { name: 'Edit Role' })).toBeInTheDocument();
  });

  it('shows a refused role save inside the editor, beside the Save button', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), [role()]);
    api.putExact(roleUrl(FIRM_A, 'role-1'), {
      status: 403,
      body: { error: 'You cannot grant a role more permissions than you have' },
    });
    renderRolesPage();

    await userEvent.click(await screen.findByText('Attorney'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Role' }));

    const editor = screen.getByRole('region', { name: 'Edit Role' });
    expect(await within(editor).findByRole('alert')).toHaveTextContent(
      'You cannot grant a role more permissions than you have',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('keeps the name and selected permissions after a refused create', async () => {
    grantBaselineMember(['firm.manageRoles']);
    api.getExact(rolesUrl(FIRM_A), []);
    api.postExact(rolesUrl(FIRM_A), { status: 403, body: { error: 'Cannot grant that permission' } });
    renderRolesPage();
    await screen.findByText('No roles found');
    await userEvent.click(screen.getByRole('button', { name: 'New Role' }));
    await userEvent.type(screen.getByLabelText(/Role Name/), 'Reviewer');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Create Matters/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot grant that permission');
    expect(screen.getByLabelText(/Role Name/)).toHaveValue('Reviewer');
    expect(screen.getByRole('checkbox', { name: /Create Matters/ })).toBeChecked();
    expect(api.calls('POST')).toHaveLength(1);
  });
});

it('retries a failed role load and shows the recovered roles', async () => {
  api.getExact(rolesUrl(FIRM_A), sequence(
    { status: 500, body: { error: 'roles service unavailable' } },
    [role()],
  ));
  renderRolesPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('roles service unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Attorney')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
