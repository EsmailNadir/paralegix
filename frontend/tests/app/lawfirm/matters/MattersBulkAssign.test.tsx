/**
 * "Assign Member" on the matters list: the bulk action and its result.
 *
 * The bulk route answers 200 even when some matters were refused, listing them
 * under `failed`. The dialog's result view is the only place that says so, so
 * the list must not close the dialog the moment the request returns: the firm
 * would be left believing every selected matter got the member.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/matters',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: jest.fn(), isNavigating: false }),
}));

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LawFirmMattersPage from '@/app/lawfirm/[lawFirmId]/matters/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';
import type { Matter } from '@/types';

const FIRM_A = 'firm-a';
const API = 'http://localhost:5001/api';
const MATTERS_URL = `${API}/lawfirms/${FIRM_A}/matters`;

const api = setupApiMock();

const ROW = {
  id: 'matter-1',
  name: 'Smith v. Jones',
  status: 'active',
  matterNumber: 'M-1001',
  clientNames: [],
  clientCount: 0,
} as unknown as Matter;

function seedList() {
  api.getExact(`${MATTERS_URL}?limit=10&page=1&sort=name:asc`, { matters: [ROW], totalItems: 1 });
  api.getExact(`${API}/lawfirms/${FIRM_A}/practice-areas`, { practiceAreas: [] });
  api.getExact(`${API}/users/lawfirm/${FIRM_A}/users`, [
    { uid: 'user-2', name: 'Bob Member', email: 'bob@example.test', userType: 'firm_member' },
  ]);
  api.getExact(`${MATTERS_URL}/categories`, { categories: [] });
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
});

afterEach(() => {
  resetPermissions();
});

// Red if: the list closes the dialog from `onAfter`, so the result view that
// reports the refused matter never stays on screen.
it('keeps the result on screen, including a matter that was refused', async () => {
  grantBaselineMember(['matters.manageMembers']);
  seedList();
  api.post('/matters/bulk-add-member/preview', { toAdd: ['matter-1'], alreadyAssigned: [], failed: [] });
  api.post('/matters/bulk-add-member', {
    added: [],
    alreadyAssigned: [],
    failed: [{ matterId: 'matter-1', error: 'You are not on this matter' }],
  });

  renderWithProviders(<LawFirmMattersPage />);
  await screen.findByText('Smith v. Jones');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select row' }));
  // The select-all toggle carries the same count; the bulk menu trigger is last.
  const triggers = await screen.findAllByRole('button', { name: '1 selected' });
  await userEvent.click(triggers[triggers.length - 1]);
  await userEvent.click(await screen.findByRole('button', { name: /Assign Member/ }));

  const dialog = await screen.findByRole('dialog', { name: 'Assign Member to Matters' });
  await userEvent.click(within(dialog).getByRole('button', { name: /Select a team member/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Bob Member' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));

  const result = await screen.findByRole('dialog', { name: 'Assignment Complete' });
  expect(within(result).getByText(/failed/)).toBeInTheDocument();
  expect(within(result).getByText('You are not on this matter')).toBeInTheDocument();
  // Still there once the list has refreshed behind it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(screen.getByRole('dialog', { name: 'Assignment Complete' })).toBeInTheDocument();
});
