/**
 * What the matter detail page tells the Add Client dialog about the clients
 * already on the matter.
 *
 * The dialog hides attached clients from its search by comparing against the
 * firm client lookup, which is keyed by `clients.id`, and reads each attached
 * client's roster by that same id. A client with a portal account also carries
 * a `userId` (a Firebase uid); handing the dialog that instead of the client id
 * offers the attached client again and reads the roster of a client that does
 * not exist.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('isomorphic-dompurify', () => require('dompurify'));

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/matters/matter-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: jest.fn(), isNavigating: false }),
}));

// Stands in for the dialog: it shows what the page passed as attached ids.
jest.mock('@/components/matterComp/AddClientModal', () => ({
  __esModule: true,
  default: ({ open, existingMatterClientIds }: { open: boolean; existingMatterClientIds?: string[] }) =>
    open ? <p data-testid="attached-ids">{(existingMatterClientIds ?? []).join(',')}</p> : null,
}));

import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ViewMatterPage from '@/app/lawfirm/[lawFirmId]/matters/[matterId]/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';
import type { Matter } from '@/types';

const FIRM_A = 'firm-a';
const MATTER_1 = 'matter-1';
const API = 'http://localhost:5001/api';
const MATTER_URL = `${API}/lawfirms/${FIRM_A}/matters/${MATTER_1}`;

const api = setupApiMock();

const PORTAL_CLIENT = {
  id: 'client-dana',
  userId: 'firebase-uid-dana',
  name: 'Dana Client',
  email: 'dana@example.test',
  clientType: 'person',
};

function seedMatterWithPortalClient() {
  api.getExact(MATTER_URL, {
    id: MATTER_1,
    name: 'Smith v. Jones',
    status: 'active',
    billingMethod: 'hourly',
    createdAt: '2025-01-01T00:00:00.000Z',
    members: [],
    totalNotes: 0,
  } as unknown as Matter);
  api.get(`/tasks/matter/${MATTER_1}`, { tasks: [] });
  api.getExact(`${MATTER_URL}/clients`, { clients: [PORTAL_CLIENT] });
  // The page's profile merge looks each client up by client id; not the
  // subject here, but a real request.
  api.getExact(`${API}/lawfirms/${FIRM_A}/clients?ids=client-dana`, { clients: [] });
  api.getExact(`${API}/users/lawfirm/${FIRM_A}/users`, []);
  api.get('/matter-stage-pipelines', { pipelines: [] });
  api.get('/matter-field-defs', { fieldDefs: [] });
  api.get(`/matters/${MATTER_1}/activity`, { activity: [], totalItems: 0 });
  api.get('/matters/lookup', { items: [], hasMore: false });
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, matterId: MATTER_1 });
});

afterEach(() => {
  resetPermissions();
});

// Red if: the page passes a portal client's `userId` rather than its client id.
it('hands the Add Client dialog the attached clients by client id, even for a portal client', async () => {
  grantBaselineMember(['matters.manageClients']);
  seedMatterWithPortalClient();

  renderWithProviders(<ViewMatterPage />);
  await screen.findByRole('heading', { name: /Smith v\. Jones/ });
  await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));
  await screen.findByRole('button', { name: 'Remove Dana Client' });
  await userEvent.click(screen.getByRole('button', { name: 'Add Client' }));

  expect(await screen.findByTestId('attached-ids')).toHaveTextContent(/^client-dana$/);
});
