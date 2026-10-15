jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
const mockNavigate = jest.fn();
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientMatters from '@/app/client/lawfirm/[lawFirmId]/matters/page';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
beforeEach(() => {
  mockNavigate.mockReset();
  __resetDuplicateRequestGuard();
  api.getExact('/api/client-portal/lawfirm/firm-a/matters?clientRecordId=record-a', { matters: [
    { id: 'matter-a', title: 'Estate Planning', status: 'active', matterNumber: 'MAT-101' },
    { id: 'matter-b', title: 'Property Purchase', status: 'active', matterNumber: 'MAT-102' },
  ] });
  api.getExact('/api/client-portal/lawfirm/firm-a/events?clientRecordId=record-a', { events: [] });
  api.getExact('/api/client-portal/lawfirm/firm-a/billing?clientRecordId=record-a', { invoices: [] });
});
it('opens the named matter by keyboard with its firm and record-scoped data intact', async () => {
  renderWithProviders(<ClientMatters />);
  await screen.findByText('Estate Planning');
  const link = screen.getByRole('link', { name: 'Estate Planning' });
  expect(link).toHaveAttribute('href', '/client/lawfirm/firm-a/matters/matter-a');
  expect(screen.getByText('MAT-101')).toBeInTheDocument();
  link.focus();
  await userEvent.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/client/lawfirm/firm-a/matters/matter-a');
  expect(api.callsTo('/matters')[0].url).toContain('clientRecordId=record-a');
});
it('labels search, announces its result count and filters the actual matter cards', async () => {
  const { container } = renderWithProviders(<ClientMatters />);
  await screen.findByText('Estate Planning');
  const search = screen.getByRole('textbox', { name: 'Search matters' });
  await userEvent.type(search, 'Estate');
  expect(search).toHaveFocus();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 matter found'));
  expect(screen.getByRole('link', { name: 'Estate Planning' })).toBeInTheDocument();
  expect(screen.queryByText('Property Purchase')).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
  await userEvent.clear(search);
  await userEvent.type(search, 'no match');
  expect(screen.getByRole('status')).toHaveTextContent('0 matters found');
  await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveFocus();
  expect(screen.getByRole('link', { name: 'Property Purchase' })).toBeInTheDocument();
});
