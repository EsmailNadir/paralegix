/**
 * What the create-matter wizard says when a write behind it is refused, through
 * the REAL matters and clients transports.
 *
 * Two failures used to read as nothing at all. A refused new client showed a
 * fixed "Failed to save client" in place of the server's reason (a duplicate
 * email, a validation message), and a team that could not be added after the
 * matter was created was dropped silently, so the firm believed everyone it had
 * picked had access.
 *
 * The pickers and lookups are stubbed: they are not what is under test and each
 * would need its own request faked. The writes are not stubbed.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/practiceHooks/usePracticeAreas', () => ({
  __esModule: true,
  default: () => ({ practiceAreas: [], loading: false, error: null, createPracticeArea: jest.fn() }),
}));
jest.mock('@/hooks/courtHooks/useCourts', () => ({
  __esModule: true,
  default: () => ({ courts: [], loading: false, createCourt: jest.fn() }),
}));
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
  useEntityByIds: () => ({ items: [] }),
}));
jest.mock('@/components/matterComp/matterForm/MatterPracticeAreaField', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterCourtField', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterMemberPicker', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterClientPicker', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/ConflictCheckBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/CategoryTreeSelect', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import CreateMatterModal from '@/components/matterComp/CreateMatterModal';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const renderModal = (onAfter = jest.fn()) =>
  renderWithProviders(
    <CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} onAfter={onAfter} />,
  );

describe('saving a new client from the create-matter wizard', () => {
  it('autocompletes an organization and sends its exact name when saving the client', async () => {
    const user = userEvent.setup();
    api.get('/clients/lookup', { items: [{ id: 'org-1', label: 'Delgado Freight LLC' }], hasMore: false });
    api.post('/clients', { status: 201, body: { clientId: 'client-new' } });
    renderModal();

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.type(screen.getByRole('combobox', { name: 'Organization' }), 'delgado');
    await user.click(await screen.findByRole('option', { name: 'Delgado Freight LLC' }));
    await user.click(screen.getByRole('button', { name: 'Save Client' }));

    await waitFor(() => expect(api.callsTo('/clients')).toHaveLength(1));
    expect(api.callsTo('/clients')[0].body).toEqual(expect.objectContaining({ organization: 'Delgado Freight LLC' }));
  });

  // Red if: "None" goes out as undefined, which the server stores as 'email'.
  it('sends null for the contact method when None is left chosen', async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 201, body: { clientId: 'client-new' } });
    renderModal();

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.click(screen.getByRole('button', { name: 'Save Client' }));

    await waitFor(() => expect(api.callsTo('/clients')).toHaveLength(1));
    expect(api.callsTo('/clients')[0].body).toHaveProperty('preferredContactMethod', null);
  });

  it("shows the server's reason when the client is refused", async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 409, body: { error: 'A client with this email already exists' } });
    renderModal();

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.click(screen.getByRole('button', { name: 'Save Client' }));

    // The fixed sentence told the user to try again, which cannot work for a
    // duplicate: the reason is the only thing that says what to change.
    expect(await screen.findByText('A client with this email already exists')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to save client\. Please try again/)).not.toBeInTheDocument();
  });

  it("shows the service's own sentence when the server gave no reason", async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 500, body: {} });
    renderModal();

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.click(screen.getByRole('button', { name: 'Save Client' }));

    expect(await screen.findByText('Failed to create client')).toBeInTheDocument();
  });
});

describe('creating the matter when its team cannot be added', () => {
  async function createMatter(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByPlaceholderText('Enter a title'), 'Estate of Roe');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
  }

  it('still finishes, and tells the firm the team was not added', async () => {
    const user = userEvent.setup();
    api.post('/matters', { status: 201, body: { message: 'ok', matterId: 'matter-1' } });
    api.post('/matters/matter-1/members', { status: 403, body: { error: 'You cannot add members to this matter' } });
    const onAfter = jest.fn();
    renderModal(onAfter);

    await createMatter(user);

    // The matter exists, so the wizard completes; staying open would invite a
    // second create. What it must not do is finish as though the team was added.
    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/matter was created, but its team could not be added/i)).toBeInTheDocument();
    expect(screen.getByText(/You cannot add members to this matter/)).toBeInTheDocument();
  });

  it('shows no warning when the team was added', async () => {
    const user = userEvent.setup();
    api.post('/matters', { status: 201, body: { message: 'ok', matterId: 'matter-1' } });
    api.post('/matters/matter-1/members', { message: 'Members added' });
    const onAfter = jest.fn();
    renderModal(onAfter);

    await createMatter(user);

    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
    expect(api.callsTo('/matters/matter-1/members')).toHaveLength(1);
    expect(screen.queryByText(/could not be added/i)).not.toBeInTheDocument();
  });
});
