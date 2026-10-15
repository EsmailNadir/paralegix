/**
 * `CreateMatterModal` across opens and around a successful create.
 *
 *   OPENED FROM A CLIENT'S PAGE, EVERY OPEN STARTS WITH THAT CLIENT. The client
 *   is seeded from a lookup that is cached after the first open, so a second
 *   open must not depend on the lookup changing.
 *
 *   A NEW CLIENT WHOSE PORTAL INVITE FAILED IS REPORTED. The client is created
 *   and queued either way; the firm has to be told the email did not go out,
 *   as every other create-client form does.
 *
 *   THE WIZARD HOLDS STILL WHILE THE CALLER REFRESHES. `onAfter` runs before
 *   the modal closes (the matters list awaits a refetch there), so the form
 *   must not jump back to an empty first step during it.
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
// One array for every render, as React Query hands back for a cached lookup.
const mockResolvedClients = [{ id: 'client-7', label: 'Rosa Diaz', sublabel: 'rosa@example.test' }];
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
  useEntityByIds: (_entity: string, _firm: string, ids: string[]) => ({ items: ids.length ? mockResolvedClients : [] }),
}));
jest.mock('@/components/matterComp/matterForm/MatterPracticeAreaField', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterCourtField', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterMemberPicker', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/matterForm/MatterClientPicker', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/matterComp/ConflictCheckBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/CategoryTreeSelect', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import CreateMatterModal from '@/components/matterComp/CreateMatterModal';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('opened from a client page', () => {
  // Red if: the seeded client is only added when the lookup result changes, so
  // the second open (same cached result) starts with no client.
  it('starts every open with that client', async () => {
    const { rerender } = renderWithProviders(
      <CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} initialClientId="client-7" />,
    );
    expect(await screen.findByText('Rosa Diaz')).toBeInTheDocument();

    rerender(<CreateMatterModal open={false} onClose={jest.fn()} lawFirmId="firm-1" users={[]} initialClientId="client-7" />);
    // Past the exit animation and the reset that follows it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    rerender(<CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} initialClientId="client-7" />);

    expect(await screen.findByText('Rosa Diaz')).toBeInTheDocument();
  });
});

describe('a new client whose portal invite could not be sent', () => {
  // Red if: `portalStatus: 'invite_failed'` is ignored and the form closes as
  // though the invite went out.
  it('is still queued, and the firm is told the invite was not sent', async () => {
    const user = userEvent.setup();
    api.post('/clients', { status: 201, body: { clientId: 'client-new', portalStatus: 'invite_failed' } });
    renderWithProviders(<CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} />);

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
    await user.type(screen.getByPlaceholderText('email@example.com'), 'dana@example.test');
    await user.click(screen.getByRole('checkbox', { name: /Invite to client portal/ }));
    await user.click(screen.getByRole('button', { name: 'Save Client' }));

    expect(await screen.findByText(/portal invite email could not be sent/i)).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });
});

describe('the caller refreshing after a successful create', () => {
  // Red if: the form is reset before `onAfter`, so the last step flips back to
  // an empty first step while the caller is still refreshing.
  it('keeps the wizard where it was until the caller closes it', async () => {
    const user = userEvent.setup();
    api.post('/matters', { status: 201, body: { message: 'ok', matterId: 'matter-1' } });
    api.post('/matters/matter-1/members', { message: 'Members added' });
    let finishRefresh: () => void = () => {};
    const onAfter = jest.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    renderWithProviders(<CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} onAfter={onAfter} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByPlaceholderText('Enter a title'), 'Estate of Roe');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    await act(async () => { finishRefresh(); });
  });
});

describe('Escape while the create is in flight', () => {
  // Red if: the dialog stays dismissible during the create, so Escape abandons
  // it and a later member or client failure renders into a closed dialog.
  it('does not close the dialog until the create settles', async () => {
    const user = userEvent.setup();
    const create = holdResponse();
    api.post('/matters', create.handler);
    api.post('/matters/matter-1/members', { message: 'Members added' });
    const onClose = jest.fn();
    const onAfter = jest.fn();
    renderWithProviders(<CreateMatterModal open onClose={onClose} lawFirmId="firm-1" users={[]} onAfter={onAfter} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByPlaceholderText('Enter a title'), 'Estate of Roe');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await create.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // The caller closes this modal from `onAfter`; once the create settles the
    // dialog is dismissible again.
    await act(async () => create.release({ status: 201, body: { message: 'ok', matterId: 'matter-1' } }));
    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
