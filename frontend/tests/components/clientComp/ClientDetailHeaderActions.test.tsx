/**
 * The client page's header actions: the portal invite lifecycle (invite, resend,
 * revoke), and the "More actions" menu (export, remove, erase).
 *
 * The client and privacy services run for real against a faked transport, so
 * each case proves the request that left the page (method, url, body) and what
 * the page did with the answer, including the refusal paths that must keep the
 * page on screen with a banner rather than navigating away.
 */

jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

const mockDownloadJson = jest.fn();
jest.mock('@/lib/utils/csv', () => ({
  ...jest.requireActual('@/lib/utils/csv'),
  downloadJson: (...args: unknown[]) => mockDownloadJson(...args),
}));

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, grantPermissions, resetPermissions } from '../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const CLIENT_URL = '/lawfirms/firm-1/clients/client-1';

let api: ApiMock;

function person(overrides: Record<string, unknown> = {}) {
  return { id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person', ...overrides };
}

function serveClient(...answers: Array<Record<string, unknown>>) {
  let i = 0;
  api.get(CLIENT_URL, () => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return { client: answer };
  });
}

beforeEach(() => {
  api = installApiMock();
  // The page also asks for conversations, relationships and lookups this spec
  // does not examine; those may go unanswered.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  mockNavigate.mockReset();
  mockDownloadJson.mockReset();
  api.get(`${CLIENT_URL}/summary`, { clientId: 'client-1', matters: null, billing: null });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

async function renderPage() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  await screen.findByRole('heading', { name: /Dana Client/ });
}

// The menu is portaled to the body and renders its entries as plain buttons.
async function chooseMoreAction(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('button', { name: label }));
}

describe('portal invitation', () => {
  it('sends the invite to the trimmed client email and confirms a connected client', async () => {
    serveClient(person({ email: '  dana@example.com ' }), person({ joinedAt: '2026-01-01T00:00:00Z' }));
    api.post('/lawfirms/firm-1/invitations/send-client-invite', { status: 'added' });

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Invite to Portal' }));

    expect(await screen.findByText('Client has been connected to the portal.')).toBeInTheDocument();
    expect(api.callsTo('/lawfirms/firm-1/invitations/send-client-invite')[0].body).toEqual({ email: 'dana@example.com' });
    // The page re-reads the client, so the revoke action replaces the invite.
    expect(await screen.findByRole('button', { name: /Revoke Portal Access/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite to Portal' })).not.toBeInTheDocument();
  });

  it('tells the member the invite waits for signup when the person has no account yet', async () => {
    serveClient(person(), person({ invitedAt: new Date().toISOString() }));
    api.post('/lawfirms/firm-1/invitations/send-client-invite', { status: 'invited' });

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Invite to Portal' }));

    expect(
      await screen.findByText('Invitation sent to dana@example.com. They will be added when they sign up.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Invite Sent, Awaiting Signup' })).toBeDisabled();
  });

  it('disables the invite for a client with no email', async () => {
    serveClient(person({ email: '' }));

    await renderPage();

    expect(screen.getByRole('button', { name: 'Invite to Portal' })).toBeDisabled();
  });

  it('shows the server refusal as a banner and keeps the client on screen', async () => {
    serveClient(person());
    api.post('/lawfirms/firm-1/invitations/send-client-invite', {
      status: 409,
      body: { error: 'That email already belongs to a firm member' },
    });

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Invite to Portal' }));

    expect(await screen.findByText('That email already belongs to a firm member')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite to Portal' })).toBeEnabled();
  });

  it('resends an invite first sent more than a day ago, by client id', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    serveClient(person({ invitedAt: twoDaysAgo }));
    api.post('/lawfirms/firm-1/invitations/resend-client-invite', { message: 'ok' });

    await renderPage();
    const resend = screen.getByRole('button', { name: 'Invite Sent, Awaiting Signup' });
    expect(resend).toBeEnabled();
    fireEvent.click(resend);

    expect(await screen.findByText('Invitation resent to dana@example.com.')).toBeInTheDocument();
    expect(api.callsTo('/lawfirms/firm-1/invitations/resend-client-invite')[0].body).toEqual({ clientId: 'client-1' });
    await waitFor(() => expect(api.callsTo(CLIENT_URL)).toHaveLength(2));
  });

  it('holds a resend until 24 hours after the last send', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    serveClient(person({ invitedAt: oneHourAgo }));

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Invite Sent, Awaiting Signup' }));

    expect(screen.getByRole('button', { name: 'Invite Sent, Awaiting Signup' })).toBeDisabled();
    expect(api.callsTo('/lawfirms/firm-1/invitations/resend-client-invite')).toHaveLength(0);
  });

  it('revokes portal access after confirmation and re-reads the client', async () => {
    serveClient(person({ joinedAt: '2026-01-01T00:00:00Z' }), person());
    api.post(`${CLIENT_URL}/revoke-portal-access`, { message: 'revoked' });

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Revoke Portal Access/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke Access' }));

    expect(await screen.findByRole('button', { name: 'Invite to Portal' })).toBeInTheDocument();
    expect(api.callsTo(`${CLIENT_URL}/revoke-portal-access`)).toHaveLength(1);
  });

  it('keeps portal access and names the refusal when revoking fails', async () => {
    serveClient(person({ joinedAt: '2026-01-01T00:00:00Z' }));
    api.post(`${CLIENT_URL}/revoke-portal-access`, { status: 403, body: { error: 'Not allowed to revoke' } });

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Revoke Portal Access/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke Access' }));

    expect(await screen.findByText('Not allowed to revoke')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revoke Portal Access/ })).toBeInTheDocument();
  });

  it('offers no portal actions on an organization', async () => {
    serveClient(person({ clientType: 'company', name: 'Dana Client' }));

    await renderPage();

    expect(screen.getByRole('button', { name: 'Add Client' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite to Portal' })).not.toBeInTheDocument();
  });
});

describe('more actions', () => {
  it('removes the client and returns to the client list', async () => {
    serveClient(person());
    api.delete(CLIENT_URL, { message: 'removed' });

    await renderPage();
    await chooseMoreAction('Remove');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Client' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/clients'));
    expect(api.calls('DELETE')).toHaveLength(1);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/lawfirms\/firm-1\/clients\/client-1$/);
  });

  it('keeps the page and shows why when a removal is refused', async () => {
    serveClient(person());
    api.delete(CLIENT_URL, { status: 409, body: { error: 'Client still has open invoices' } });

    await renderPage();
    await chooseMoreAction('Remove');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Client' }));

    expect(await screen.findByText('Client still has open invoices')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(screen.queryByText('Client not found')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('downloads the exported data under the client id', async () => {
    serveClient(person());
    api.get(`${CLIENT_URL}/data-export`, { client: { id: 'client-1' }, notes: [] });

    await renderPage();
    await chooseMoreAction('Export Data');

    await waitFor(() => expect(mockDownloadJson).toHaveBeenCalledTimes(1));
    expect(mockDownloadJson).toHaveBeenCalledWith('paralegix-client-client-1.json', { client: { id: 'client-1' }, notes: [] });
  });

  it('shows the refusal when an export fails and downloads nothing', async () => {
    serveClient(person());
    api.get(`${CLIENT_URL}/data-export`, { status: 500, body: { error: 'Export is unavailable' } });

    await renderPage();
    await chooseMoreAction('Export Data');

    expect(await screen.findByText('Export is unavailable')).toBeInTheDocument();
    expect(mockDownloadJson).not.toHaveBeenCalled();
  });

  it('erases the client and returns to the client list', async () => {
    serveClient(person());
    api.post(`${CLIENT_URL}/erase`, { message: 'erased', clientId: 'client-1' });

    await renderPage();
    await chooseMoreAction('Erase Client');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Erase Client' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/clients'));
    expect(api.callsTo(`${CLIENT_URL}/erase`)).toHaveLength(1);
  });

  it('keeps the page when an erase is refused', async () => {
    serveClient(person());
    api.post(`${CLIENT_URL}/erase`, { status: 409, body: { error: 'Client is on a legal hold' } });

    await renderPage();
    await chooseMoreAction('Erase Client');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Erase Client' }));

    expect(await screen.findByText('Client is on a legal hold')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('permission gating', () => {
  it('a baseline member sees the client read-only, with no header actions', async () => {
    grantBaselineMember();
    serveClient(person());

    await renderPage();

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite to Portal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('a member who may only erase gets a menu holding export and erase, not remove', async () => {
    grantPermissions(['clients.view', 'clients.erase']);
    serveClient(person());

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    expect(await screen.findByRole('button', { name: 'Export Data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erase Client' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
  it('a manager without the erase permission can remove but not erase', async () => {
    grantBaselineMember(['clients.manage']);
    serveClient(person());

    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Data' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erase Client' })).not.toBeInTheDocument();
  });
});

describe('load failure', () => {
  it('shows the not-found panel when the client cannot be read', async () => {
    api.get(CLIENT_URL, { status: 404, body: { error: 'Client not found' } });

    renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);

    expect(await screen.findByText('This client may have been removed from your law firm.')).toBeInTheDocument();
  });
});
