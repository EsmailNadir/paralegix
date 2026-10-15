/**
 * Creating a client from inside the attach modal, through the REAL clients
 * transport.
 *
 * `AttachClientModal.test.tsx` mocks `clients.service`, but `tests/setup.ts`
 * installs its own mock for that module and wins, so the component there talks
 * to a Proxy that resolves `{}` to every call. A request body can never be
 * asserted that way. This file unmocks the service and fakes only `fetch`, so
 * the body that reaches the server is the thing under test.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="org-autocomplete" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import AttachClientModal, { type AttachClientTarget } from '@/components/clientComp/AttachClientModal';
import { useEntityLookup, useDuplicateNameCheck } from '@/hooks/useEntityLookup';

let api: ApiMock;
let target: AttachClientTarget;
let attach: jest.Mock;

beforeEach(() => {
  api = installApiMock();
  attach = jest.fn().mockResolvedValue(undefined);
  target = { label: 'Matter', attachedClientIds: [], attach, invalidateKeys: [] };
  (useEntityLookup as jest.Mock).mockReturnValue({ items: [], hasMore: false, loading: false });
  (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
  // The roster-cleanup read only runs for attached clients; none here.
  api.post('/clients', { status: 201, body: { message: 'ok', clientId: 'client-new' } });
});

afterEach(() => {
  api.restore();
});

async function createPerson(
  user: ReturnType<typeof userEvent.setup>,
  { email, invite }: { email: string; invite: boolean },
) {
  await user.click(screen.getByRole('button', { name: /Create New Client/ }));
  await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
  if (email) await user.type(screen.getByPlaceholderText('email@example.com'), email);
  if (invite) await user.click(screen.getByRole('checkbox', { name: /Invite to client portal/ }));
  await user.click(screen.getByRole('button', { name: 'Create & Add' }));
}

const renderModal = (onClose = jest.fn()) =>
  renderWithProviders(<AttachClientModal open onClose={onClose} lawFirmId="firm-1" target={target} />);

describe('inviting a new client to the portal from the attach modal', () => {
  // The checkbox was drawn and stored but never read, so a firm that ticked it
  // got a client with no invite and no hint that nothing had been sent.
  it('asks the server to invite the client when the box is ticked', async () => {
    const user = userEvent.setup();
    renderModal();

    await createPerson(user, { email: 'dana@example.com', invite: true });

    await waitFor(() => expect(api.callsTo('/clients')).toHaveLength(1));
    expect(api.callsTo('/clients')[0].body).toEqual(
      expect.objectContaining({ name: 'Dana Whitfield', email: 'dana@example.com', portalInvitePending: true }),
    );
  });

  it('sends no invite request when the box is left unticked', async () => {
    const user = userEvent.setup();
    renderModal();

    await createPerson(user, { email: 'dana@example.com', invite: false });

    await waitFor(() => expect(api.callsTo('/clients')).toHaveLength(1));
    expect((api.callsTo('/clients')[0].body as Record<string, unknown>).portalInvitePending).toBe(false);
  });

  it('keeps the modal open and says so when the client was created but the invite email failed', async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 201, body: { message: 'ok', clientId: 'client-new', portalStatus: 'invite_failed' } });
    const onClose = jest.fn();
    renderModal(onClose);

    await createPerson(user, { email: 'dana@example.com', invite: true });

    // The client row exists and is attached, so the firm is told to resend from
    // the client page. Closing silently would read as a clean success.
    expect(await screen.findByText(/invite email could not be sent/i)).toBeInTheDocument();
    expect(attach).toHaveBeenCalledWith({ clientId: 'client-new', name: 'Dana Whitfield' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes as before when the invite went out', async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 201, body: { message: 'ok', clientId: 'client-new', portalStatus: 'invited' } });
    const onClose = jest.fn();
    renderModal(onClose);

    await createPerson(user, { email: 'dana@example.com', invite: true });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('editing a client from the attach modal', () => {
  // Saving an edit sends no invite, so offering the box there promised an email
  // that the save never sent.
  it('does not offer the portal invite, since saving an edit sends none', async () => {
    const user = userEvent.setup();
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [{ id: 'client-1', label: 'Alice Smith', sublabel: 'alice@example.com', clientType: 'person' }],
      hasMore: false,
      loading: false,
    });
    api.get('/clients/client-1', {
      id: 'client-1', name: 'Alice Smith', email: 'alice@example.com', clientType: 'person',
    });
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Edit Client' }));

    // The form is up (the Save button is its footer), so the absence below is
    // not a form that never opened.
    expect(await screen.findByRole('button', { name: 'Save & Add' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Invite to client portal/ })).not.toBeInTheDocument();
  });
});

describe('the preferred contact method of a new client', () => {
  // Red if: "None" goes out as undefined, which the server stores as 'email'.
  it('sends null when None is left chosen', async () => {
    const user = userEvent.setup();
    renderModal();

    await createPerson(user, { email: '', invite: false });

    await waitFor(() => expect(api.callsTo('/clients')).toHaveLength(1));
    expect(api.callsTo('/clients')[0].body).toHaveProperty('preferredContactMethod', null);
  });
});

describe('linking a new person to the organization typed for them', () => {
  async function createWithOrganization(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /Create New Client/ }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.type(screen.getByTestId('org-autocomplete'), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Create & Add' }));
  }

  // Red if: a refused link is only logged, and the modal closes as a clean success.
  it('says the link failed and stays open when the organization refuses the contact', async () => {
    const user = userEvent.setup();
    api.get('/clients/lookup', { items: [{ id: 'company-1', label: 'Acme Corp', clientType: 'company' }], hasMore: false });
    api.post('/clients/company-1/contacts', { status: 403, body: { error: 'You do not have permission to manage contacts' } });
    const onClose = jest.fn();
    renderModal(onClose);

    await createWithOrganization(user);

    expect(await screen.findByText(/Dana Whitfield was added, but linking them to Acme Corp failed: You do not have permission to manage contacts/))
      .toBeInTheDocument();
    expect(attach).toHaveBeenCalledWith({ clientId: 'client-new', name: 'Dana Whitfield' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes as before when the link is made', async () => {
    const user = userEvent.setup();
    api.get('/clients/lookup', { items: [{ id: 'company-1', label: 'Acme Corp', clientType: 'company' }], hasMore: false });
    api.post('/clients/company-1/contacts', { status: 201, body: { message: 'ok' } });
    const onClose = jest.fn();
    renderModal(onClose);

    await createWithOrganization(user);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.callsTo('/clients/company-1/contacts')).toHaveLength(1);
  });
});

describe('linking an edited person to their organization', () => {
  async function saveEditWithOrganization(user: ReturnType<typeof userEvent.setup>, onClose: jest.Mock) {
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [{ id: 'client-1', label: 'Alice Smith', sublabel: 'alice@example.com', clientType: 'person' }],
      hasMore: false,
      loading: false,
    });
    api.get('/clients/client-1', {
      id: 'client-1', name: 'Alice Smith', email: 'alice@example.com', clientType: 'person', organization: 'Acme Corp',
    });
    api.put('/clients/client-1', { message: 'ok' });
    api.get('/clients/lookup', { items: [{ id: 'company-1', label: 'Acme Corp', clientType: 'company' }], hasMore: false });
    renderModal(onClose);

    await user.click(screen.getByRole('button', { name: 'Edit Client' }));
    await waitFor(() => expect(screen.getByTestId('org-autocomplete')).toHaveValue('Acme Corp'));
    await user.click(await screen.findByRole('button', { name: 'Save & Add' }));
  }

  // Red if: the edit path swallows a refused link.
  it('says the link failed and stays open', async () => {
    const user = userEvent.setup();
    api.post('/clients/company-1/contacts', { status: 403, body: { error: 'You do not have permission to manage contacts' } });
    const onClose = jest.fn();

    await saveEditWithOrganization(user, onClose);

    expect(await screen.findByText(/Alice Smith was saved, but linking them to Acme Corp failed/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Red if: a person already on the roster reads as a failure on every save.
  it('treats an existing link as done and closes', async () => {
    const user = userEvent.setup();
    api.post('/clients/company-1/contacts', { status: 409, body: { error: 'That client is already linked to this company.' } });
    const onClose = jest.fn();

    await saveEditWithOrganization(user, onClose);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.callsTo('/clients/company-1/contacts')).toHaveLength(1);
  });
});
