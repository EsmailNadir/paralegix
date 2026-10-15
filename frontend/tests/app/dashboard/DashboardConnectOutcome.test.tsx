/**
 * `/dashboard` as the landing page of a calendar connect.
 *
 * The API returns a connect to `/dashboard` when the page that started it is
 * unknown. A person with one firm is forwarded straight into it, so the
 * outcome has to travel with them; a person with several firms stays here, so
 * the dashboard reports it itself. Exactly one of the two reports it, never
 * both, and never neither.
 *
 * What has to break for these to go red: the single-firm forward dropping the
 * outcome, the multi-firm dashboard showing nothing, or the forward carrying
 * unrelated query parameters into the firm.
 */
jest.unmock('@/services/users.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockQuery = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/dashboard',
  useSearchParams: () => mockQuery,
}));
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: { uid: 'u1', email: 'pat@firm.test', emailVerified: true, displayName: 'Pat' }, loading: false }),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import Dashboard from '@/app/dashboard/page';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();

beforeEach(() => {
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  api.get('/users/profile', { id: 'u1', name: 'Pat' });
  api.get('/invitations/my-pending-member-invites', { invites: [] });
});

afterEach(() => window.history.replaceState(null, '', '/'));

function render(query: string) {
  mockQuery = new URLSearchParams(query);
  window.history.replaceState(null, '', query ? `/dashboard?${query}` : '/dashboard');
  return renderWithProviders(<Dashboard />);
}

describe('a person with one firm', () => {
  it('carries the connect outcome into the firm, and only the outcome', async () => {
    api.get('/my-lawfirms', { lawFirmIds: ['firm-1'] });

    render('google_error=permission_required&utm=x');

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/lawfirm/firm-1?google_error=permission_required'));
    // The firm shell reports it; the dashboard must not report it a second time.
    expect(screen.queryByText(/calendar access was not allowed/)).not.toBeInTheDocument();
  });

  it('goes straight into the firm when there is no outcome', async () => {
    api.get('/my-lawfirms', { lawFirmIds: ['firm-1'] });

    render('');

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/lawfirm/firm-1'));
  });
});

describe('a person with several firms', () => {
  it('reports the connect outcome on the dashboard', async () => {
    api.get('/my-lawfirms', { lawFirmIds: ['firm-1', 'firm-2'] });
    api.get('/lawfirms/firm-1', { lawFirm: { id: 'firm-1', name: 'Firm One' } });
    api.get('/lawfirms/firm-2', { lawFirm: { id: 'firm-2', name: 'Firm Two' } });

    render('microsoft_error=admin_consent_required');

    expect(await screen.findByText(
      "Your organization's administrator must approve Paralegix before Microsoft Calendar can be connected.",
    )).toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard', { scroll: false });
  });
});
