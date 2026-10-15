jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
const mockNavigate = jest.fn();
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Calendar from '@/app/client/lawfirm/[lawFirmId]/calendar/page';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
const api = setupApiMock();

it('structures the dated agenda and opens its matter with a keyboard', async () => {
  api.getExact('/api/client-portal/lawfirm/firm-a/events?clientRecordId=record-a', { events: [{
    id: 'event-a', matterId: 'matter-a', title: 'Review appointment', date: '2026-10-04T18:00:00Z', location: 'Office',
  }], truncated: false });
  api.getExact('/api/client-portal/lawfirm/firm-a/matters?clientRecordId=record-a', { matters: [{ id: 'matter-a', title: 'Estate Planning' }] });
  renderWithProviders(<Calendar />);
  expect(await screen.findByRole('heading', { level: 2, name: /Sunday, October 4/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: 'Review appointment' })).toBeInTheDocument();
  expect(screen.getByText('11:00 AM')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Estate Planning' });
  expect(link).toHaveAttribute('href', '/client/lawfirm/firm-a/matters/matter-a');
  link.focus();
  await userEvent.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/client/lawfirm/firm-a/matters/matter-a');
});

it('names the replacement account picker page and selects distinct Organization records by keyboard', async () => {
  const onSelect = jest.fn();
  renderWithProviders(<ClientRecordPicker associations={[
    { clientRecordId: 'record-person', clientType: 'individual', clientName: 'Pat', role: 'self' },
    { clientRecordId: 'record-org', clientType: 'company', clientName: 'Pat', role: 'member' },
  ] as never} onSelect={onSelect} />);
  expect(screen.getByRole('heading', { level: 1, name: 'Choose an account' })).toBeInTheDocument();
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Pat Personal account' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Pat Organization' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledWith('record-org');
  expect(api.calls()).toHaveLength(0);
});

it('returns focus to portal content when selecting an account replaces the picker', async () => {
  function Portal() {
    const [selected, setSelected] = React.useState(false);
    return <main id="main-content" tabIndex={-1}>{selected ? <h1>Portal settings</h1> : <ClientRecordPicker associations={[
      { clientRecordId: 'record-org', clientType: 'company', clientName: 'Pat', role: 'member' },
    ] as never} onSelect={() => setSelected(true)} />}</main>;
  }
  renderWithProviders(<Portal />);
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('heading', { name: 'Portal settings' })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveFocus();
});
