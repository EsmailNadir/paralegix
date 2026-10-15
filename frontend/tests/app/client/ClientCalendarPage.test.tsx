jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import ClientCalendarPage from '@/app/client/lawfirm/[lawFirmId]/calendar/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let mockRecordId = 'record-a';
jest.mock('@/contexts/ClientPortalContext', () => ({
  useClientPortal: () => ({ associations: [], associationsLoading: false,
    activeAssociation: { clientRecordId: mockRecordId }, selectionRequired: false,
    setActiveClientRecordId: jest.fn() }),
}));

let api: ApiMock;
const events = (title: string) => ({ events: [{ id: title, title, matterId: 'matter-1', date: '2026-09-29T18:00:00.000Z' }], truncated: false });
beforeEach(() => { api = installApiMock(); mockRecordId = 'record-a'; api.get('/matters', { matters: [] }); });
afterEach(() => api.restore());

it('shows all-day appointments without a clock and links shared descriptions and locations', async () => {
  api.get('/events', { events: [{ id: 'all-day', title: 'Hearing', date: '2026-09-29T12:00:00Z', allDay: true,
    description: 'Join https://meet.example.test/hearing', location: 'clerk@court.gov' }] });
  renderWithProviders(<ClientCalendarPage />);
  await screen.findByText('Hearing');
  expect(screen.getByText('All day')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'https://meet.example.test/hearing' })).toHaveAttribute('href', 'https://meet.example.test/hearing');
  expect(screen.getByRole('link', { name: 'clerk@court.gov' })).toHaveAttribute('href', 'mailto:clerk@court.gov');
});

it('keeps the active client agenda when a previous record finishes loading later', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  api.get('/events', async call => {
    if (call.query.clientRecordId?.[0] === 'record-a') { await gate; return events('Old record meeting'); }
    return events('Current record meeting');
  });
  const { rerender } = renderWithProviders(<ClientCalendarPage />);
  await waitFor(() => expect(api.callsTo('/events')).toHaveLength(1));
  mockRecordId = 'record-b';
  rerender(<ClientCalendarPage />);
  await screen.findByText('Current record meeting');
  await act(async () => { finish(); await gate; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.getByText('Current record meeting')).toBeInTheDocument();
  expect(screen.queryByText('Old record meeting')).not.toBeInTheDocument();
});

it('does not display the previous client agenda when the newly selected record fails to load', async () => {
  api.get('/events', call => call.query.clientRecordId?.[0] === 'record-a'
    ? events('Old record meeting') : { status: 403, body: { error: 'Access denied' } });
  const { rerender } = renderWithProviders(<ClientCalendarPage />);
  await screen.findByText('Old record meeting');
  mockRecordId = 'record-b';
  rerender(<ClientCalendarPage />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Old record meeting')).not.toBeInTheDocument();
});

it('shows both dates for a timed appointment spanning days', async () => {
  api.get('/events', { events: [{ id: 'span', title: 'Trial', date: '2026-09-29T18:00:00.000Z', endsAt: '2026-09-30T18:00:00.000Z', allDay: false }] });
  renderWithProviders(<ClientCalendarPage />);
  await screen.findByText('Trial');
  expect(screen.getByText(/Wed, Sep 30, 2026/)).toBeInTheDocument();
});

// The suite runs in Los Angeles (jest.config.js), so that is the viewer zone.
it('labels a timed appointment set in another zone, and none in the viewer zone or on an all-day one', async () => {
  api.get('/events', { events: [
    { id: 'nz', title: 'Auckland call', matterId: 'matter-1', date: '2026-09-29T18:00:00.000Z', endsAt: '2026-09-29T19:00:00.000Z', allDay: false, timeZone: 'Pacific/Auckland' },
    { id: 'nz-open', title: 'Open-ended call', matterId: 'matter-1', date: '2026-09-30T18:00:00.000Z', allDay: false, timeZone: 'Pacific/Auckland' },
    { id: 'la', title: 'Local call', matterId: 'matter-1', date: '2026-10-01T18:00:00.000Z', allDay: false, timeZone: 'America/Los_Angeles' },
    { id: 'day', title: 'Filing day', matterId: 'matter-1', date: '2026-10-02T12:00:00.000Z', allDay: true, timeZone: 'Pacific/Auckland' },
  ] });
  renderWithProviders(<ClientCalendarPage />);
  await screen.findByText('Auckland call');
  const range = screen.getByText('(Wed 7:00 AM – 8:00 AM in Auckland)');
  expect(range).toHaveClass('text-on-surface-secondary');
  expect(range.parentElement).toHaveTextContent(/^Tue, Sep 29, 2026 · 11:00 AM – 12:00 PM PDT \(Wed 7:00 AM – 8:00 AM in Auckland\)$/);
  expect(screen.getByText('(Thu 7:00 AM in Auckland)').parentElement).toHaveTextContent(/^11:00 AM PDT \(Thu 7:00 AM in Auckland\)$/);
  expect(screen.getAllByText(/ in (Auckland|Los Angeles)\)$/)).toHaveLength(2);
});
