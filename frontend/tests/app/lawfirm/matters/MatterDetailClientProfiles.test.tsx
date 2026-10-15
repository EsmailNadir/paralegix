/**
 * The matter detail page overlays each attached client with the firm's own
 * client record (the batch `clients?ids=` read), which is where portal status,
 * joined date and the latest contact details come from.
 *
 * That batch read is keyed by `clients.id`. A client with a portal login also
 * carries a `userId` (a Firebase uid); looking the client up by that instead
 * finds nothing, so a portal client never received its firm record.
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

function seedMatter() {
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

// Red if: the page looks a portal client's firm record up by its `userId`.
it('overlays a portal client with its firm record, looked up by client id', async () => {
  grantBaselineMember(['matters.manageClients']);
  seedMatter();
  // Only the firm record carries the organization, so it shows on the row only
  // when the overlay found this client.
  api.getExact(`${API}/lawfirms/${FIRM_A}/clients?ids=client-dana`, {
    clients: [{
      ...PORTAL_CLIENT,
      organization: 'Delgado Freight LLC',
      status: 'active',
      joinedAt: '2025-02-01T00:00:00.000Z',
    }],
  });

  renderWithProviders(<ViewMatterPage />);
  await screen.findByRole('heading', { name: /Smith v\. Jones/ });
  await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));
  await screen.findByRole('button', { name: 'Remove Dana Client' });

  expect(await screen.findByText(/Delgado Freight LLC/)).toBeInTheDocument();
  const firmClientReads = api.calls('GET').filter((c) => c.pathname === `/api/lawfirms/${FIRM_A}/clients`);
  expect(firmClientReads.map((c) => c.query.ids)).toEqual([['client-dana']]);
});
