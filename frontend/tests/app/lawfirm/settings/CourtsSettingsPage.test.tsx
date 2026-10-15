/**
 * The firm's court list in settings, driven through the real courts service
 * against a faked transport.
 *
 * Three save paths are pinned here: emptying a field on edit must clear it on
 * the server, a refused delete must say why inside the confirm dialog (a page
 * banner sits behind its backdrop), and a member who cannot manage courts must
 * not trigger the list read the backend refuses them.
 */
jest.unmock('@/services/courts.service');
jest.unmock('@/services/contacts.service');
jest.unmock('@/services/requestDeduplicator');

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import CourtsPage from '@/app/lawfirm/[lawFirmId]/settings/courts/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

// tests/setup.ts pins useParams to this firm.
const LAW_FIRM_ID = 'test-law-firm-id';
const API = 'http://localhost:5001/api';
const COURTS_URL = `${API}/lawfirms/${LAW_FIRM_ID}/courts`;

const api = setupApiMock();

const COURT = {
  id: 'court-1',
  lawFirmId: LAW_FIRM_ID,
  name: 'Kings County Supreme Court',
  abbreviation: 'KCSC',
  city: 'Brooklyn',
  state: 'NY',
  address: '360 Adams St',
  courtType: 'state',
};

beforeEach(() => {
  api.get(`/lawfirms/${LAW_FIRM_ID}/contacts`, { contacts: [], totalItems: 0 });
});

afterEach(() => {
  resetPermissions();
});

describe('editing a court', () => {
  it('sends null for the fields the user emptied so the server clears them', async () => {
    grantBaselineMember(['courts.manage']);
    api.getExact(COURTS_URL, { courts: [COURT] });
    api.putExact(`${COURTS_URL}/court-1`, { message: 'Court updated successfully', mattersUpdated: 0 });

    renderWithProviders(<CourtsPage />);

    await screen.findByText('Kings County Supreme Court');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    for (const value of ['KCSC', 'Brooklyn', 'NY', '360 Adams St', 'state']) {
      await userEvent.clear(screen.getByDisplayValue(value));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.callsTo('/courts/court-1').filter((c) => c.method === 'PUT')).toHaveLength(1),
    );
    const [call] = api.callsTo('/courts/court-1').filter((c) => c.method === 'PUT');
    // `undefined` drops out of the JSON body, and the server reads a missing
    // key as "leave it alone", so the old value would survive the save.
    expect(call.body).toEqual({
      name: 'Kings County Supreme Court',
      abbreviation: null,
      city: null,
      state: null,
      address: null,
      courtType: null,
    });
  });
});

describe('deleting a court', () => {
  it('keeps the dialog open and shows the refusal inside it', async () => {
    grantBaselineMember(['courts.manage']);
    api.getExact(COURTS_URL, { courts: [COURT] });
    api.deleteExact(`${COURTS_URL}/court-1`, {
      status: 409,
      body: { error: 'Court is still in use' },
    });

    renderWithProviders(<CourtsPage />);

    await screen.findByText('Kings County Supreme Court');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Court is still in use');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('a member without courts.manage', () => {
  it('shows the permission notice without requesting the list the backend refuses', async () => {
    grantBaselineMember();
    api.allowUnhandled();

    renderWithProviders(<CourtsPage />);

    expect(await screen.findByText(/permission to create, edit, or delete courts/)).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('/contacts').length).toBeGreaterThan(0));
    expect(api.callsTo('/courts')).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // An empty list here would read as "this firm has no courts", which it may not.
    expect(screen.queryByText('No courts yet.')).not.toBeInTheDocument();
  });
});
