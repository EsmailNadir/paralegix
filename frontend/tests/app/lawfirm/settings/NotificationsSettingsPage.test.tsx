/**
 * The per-user notification preferences page.
 *
 * Guards a specific regression: this page used to show a "Lead assignments"
 * toggle ("When you're assigned to a lead") even though no part of the product
 * can ever assign a lead to anyone: no schema column, no validation field, no
 * UI control anywhere else. A user who turned it on believed they would be
 * notified; nothing ever fired. The category was removed rather than wired up
 * for real (see backend/tests/leads/leads.test.ts for the matching backend
 * characterization). This test locks the deletion in so the category cannot
 * quietly resurface as copy without a matching backend feature.
 */
jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/settings/notifications',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

import { screen, waitFor } from '@testing-library/react';

import NotificationsSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/notifications/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';

const FIRM_A = 'firm-a';

const api = setupApiMock();

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  api.get('/settings/user', { preferences: { notifications: { inApp: {}, digest: {} } } });
});

describe('the category list', () => {
  it('does not offer a lead-assignment toggle', async () => {
    renderWithProviders(<NotificationsSettingsPage />);

    // Positive control: a real, working category must still be there, so an
    // empty page (a render failure, a stuck loading state) cannot pass this
    // test by coincidence.
    await waitFor(() => expect(screen.getByText('Task assignments')).toBeInTheDocument());

    expect(screen.queryByText('Lead assignments')).not.toBeInTheDocument();
    expect(screen.queryByText(/assigned to a lead/i)).not.toBeInTheDocument();
  });
});
