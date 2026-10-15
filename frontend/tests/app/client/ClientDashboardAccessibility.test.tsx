jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');
const mockNavigate = jest.fn();
const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, usePathname: () => '/client/dashboard' }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
jest.mock('@/hooks/useSigningRealtime', () => ({ useClientSigningRealtime: jest.fn() }));
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientDashboard from '@/app/client/dashboard/page';
import { ProfileContext } from '@/contexts/ProfileContext';
import type { User } from '@/types';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const api = setupApiMock();
const firmA = { id: 'firm-a', name: 'Alpha Legal', matterCount: 2, outstandingBalanceCents: 12500, billingLocked: false };
const firmB = { id: 'firm-b', name: 'Beta Legal', matterCount: 3, outstandingBalanceCents: 0, billingLocked: false };
function renderDashboard(firms = [firmA]) {
  api.getExact('/api/client-portal/firm-summaries', { lawFirms: firms });
  return renderWithProviders(<ProfileContext value={{ profile: { userType: 'client' } as User }}><ClientDashboard /></ProfileContext>);
}
beforeEach(() => {
  mockNavigate.mockReset(); __resetDuplicateRequestGuard();
  api.getExact('/api/client-portal/unread-count', { unreadByFirm: { 'firm-a': 2 } });
  api.getExact('/api/signing/pending-for-client?limit=3', { pendingDocuments: [], totalItems: 0 });
});

it('opens the single-firm summary destinations by keyboard', async () => {
  renderDashboard();
  await screen.findByText('Alpha Legal');
  for (const [name, destination] of [
    [/Active Matters/, '/client/lawfirm/firm-a/matters'],
    [/New Messages/, '/client/messages'],
    [/Outstanding/, '/client/lawfirm/firm-a/billing'],
  ] as const) {
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', destination);
    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenLastCalledWith(destination);
  }
  expect(screen.getByRole('link', { name: /Outstanding/ })).toHaveTextContent('$125.00');
});

it('names each firm destination and leaves multi-firm summary totals informational', async () => {
  renderDashboard([firmA, firmB]);
  await screen.findByText('Beta Legal');
  expect(screen.queryByRole('link', { name: /Active Matters/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Outstanding/ })).not.toBeInTheDocument();
  for (const firm of [firmA, firmB]) {
    const link = screen.getByRole('link', { name: `My Matters at ${firm.name}` });
    expect(link).toHaveAttribute('href', `/client/lawfirm/${firm.id}/matters`);
    link.focus(); await userEvent.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenLastCalledWith(`/client/lawfirm/${firm.id}/matters`);
    expect(screen.getByRole('link', { name: `Billing at ${firm.name}` })).toHaveAttribute('href', `/client/lawfirm/${firm.id}/billing`);
    expect(screen.getByRole('link', { name: `Messages at ${firm.name}` })).toHaveAttribute('href', `/client/messages/${firm.id}`);
  }
});

it('keeps paused firm destinations unavailable', async () => {
  renderDashboard([{ ...firmA, billingLocked: true }]);
  await screen.findByText('Portal unavailable');
  expect(screen.getByText('Alpha Legal')).toBeInTheDocument();
  await userEvent.click(screen.getByText('Active Matters'));
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: /My Matters at/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Active Matters|Outstanding/ })).not.toBeInTheDocument();
});
