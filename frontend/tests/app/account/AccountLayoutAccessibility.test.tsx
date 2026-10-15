jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');
const mockRouter = { replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountLayout from '@/app/account/AccountLayoutClient';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();
it('moves keyboard focus past the account skip link to the main content', async () => {
  api.getExact('/api/users/profile', { name: 'Client Person', userType: 'client' });
  renderWithProviders(<AccountLayout><h1>Account</h1><button>Export My Data</button></AccountLayout>);
  await screen.findByRole('button', { name: 'Export My Data' });
  await userEvent.tab();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('main')).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Export My Data' })).toHaveFocus();
  expect(api.calls('GET')).toHaveLength(1);
});
