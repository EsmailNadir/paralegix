jest.unmock('@/services/subscription.service');
jest.unmock('@/services/requestDeduplicator');
const mockRefetchLawFirm = jest.fn();
jest.mock('@/contexts/LawFirmContext', () => ({
  useLawFirm: () => ({
    subscriptionStatusLoaded: true,
    subscriptionStatus: null,
    refetchLawFirm: (...args: unknown[]) => mockRefetchLawFirm(...args),
  }),
}));
jest.mock('next/navigation', () => ({
  useParams: () => ({ lawFirmId: 'firm-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/billing/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

const api = setupApiMock();
afterEach(resetPermissions);

it('shows contact-admin guidance without billing controls to an ordinary member', async () => {
  grantBaselineMember();
  api.get('/subscriptions/status', { planId: 'starter', billingStatus: 'inactive', usage: { matters: { current: 0, limit: 10 }, members: { current: 1, limit: 2, pendingInvites: 0 }, storage: { currentBytes: 0, limitBytes: 1024 } }, limits: {} });
  renderWithProviders(<BillingSettingsPage />);
  expect(await screen.findByText(/contact.*administrator/i)).toBeInTheDocument();
  expect(screen.queryByText('Choose a Plan')).not.toBeInTheDocument();
  expect(screen.queryByText('Change Plan')).not.toBeInTheDocument();
  expect(screen.queryByText(/Manage your firm.*plan/i)).not.toBeInTheDocument();
});

it('keeps subscription management available to an authorized member', async () => {
  grantBaselineMember(['settings.manageFirm']);
  api.get('/subscriptions/status', { planId: 'starter', billingStatus: 'inactive', usage: { matters: { current: 0, limit: 10 }, members: { current: 1, limit: 2, pendingInvites: 0 }, storage: { currentBytes: 0, limitBytes: 1024 } }, limits: {} });
  renderWithProviders(<BillingSettingsPage />);
  expect(await screen.findByText('Choose a Plan')).toBeInTheDocument();
});

describe('after a subscription change', () => {
  // The firm record carries the plan the sidebar and feature gates read. Left
  // stale, the old plan's features stay on screen until a reload.
  const USAGE = { matters: { current: 0, limit: 10 }, members: { current: 1, limit: 2, pendingInvites: 0 }, storage: { currentBytes: 0, limitBytes: 1024 } };
  const ACTIVE = {
    planId: 'professional', billingStatus: 'active', stripeSubscriptionId: 'sub_1',
    currentPeriodEnd: '2026-11-01T00:00:00Z', usage: USAGE, limits: {},
  };

  beforeEach(() => {
    mockRefetchLawFirm.mockReset().mockResolvedValue(undefined);
  });

  it('refreshes the shared firm record once a cancellation is saved', async () => {
    grantBaselineMember(['settings.manageFirm']);
    api.get('/subscriptions/status', ACTIVE);
    api.post('/subscriptions/cancel', { message: 'ok' });
    renderWithProviders(<BillingSettingsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Cancel Plan/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel Subscription' }));

    await waitFor(() => expect(mockRefetchLawFirm).toHaveBeenCalledTimes(1));
  });

  it('refreshes the shared firm record once a reactivation is saved', async () => {
    grantBaselineMember(['settings.manageFirm']);
    api.get('/subscriptions/status', { ...ACTIVE, cancelAtPeriodEnd: true });
    api.post('/subscriptions/reactivate', { message: 'ok' });
    renderWithProviders(<BillingSettingsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Reactivate/ }));

    await waitFor(() => expect(mockRefetchLawFirm).toHaveBeenCalledTimes(1));
  });

  it('leaves the firm record alone when the cancellation is refused', async () => {
    grantBaselineMember(['settings.manageFirm']);
    api.get('/subscriptions/status', ACTIVE);
    api.post('/subscriptions/cancel', { status: 502, body: { error: 'Stripe unavailable' } });
    renderWithProviders(<BillingSettingsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Cancel Plan/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel Subscription' }));

    expect(await screen.findByText('Stripe unavailable')).toBeInTheDocument();
    expect(mockRefetchLawFirm).not.toHaveBeenCalled();
  });
});
