import React from 'react';
import dayjs from 'dayjs';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import DashboardCalendarWidget from '@/components/dashboardComp/DashboardCalendarWidget';

let mockSpanning = false;
jest.mock('@/hooks/calendarHooks/useMatterEvents', () => ({ __esModule: true, default: () => ({ loading: false, matterEvents: [{ id: 'all-day', title: 'All-day hearing', date: (mockSpanning ? dayjs().subtract(1, 'day') : dayjs()).format('YYYY-MM-DD') + 'T12:00:00Z', endsAt: mockSpanning ? dayjs().add(1, 'day').format('YYYY-MM-DD') + 'T12:00:00Z' : null, dateLocalInput: dayjs().format('YYYY-MM-DD') + 'T00:00', allDay: true, matterId: 'matter-1' }] }) }));
jest.mock('@/hooks/calendarHooks/useStandaloneClientEvents', () => ({ __esModule: true, default: () => ({ loading: false, clientEvents: [{ id: 'timed-midnight', title: 'Midnight call', date: dayjs().startOf('day').toISOString(), allDay: false }] }) }));
jest.mock('@/components/dashboardComp/EventDetailModal', () => ({ __esModule: true, default: () => null }));

test('labels explicit all-day events and keeps timed midnight appointments timed', async () => {
  renderWithProviders(<DashboardCalendarWidget lawFirmId="firm-1" compact={false} onNavigate={jest.fn()} />);
  await screen.findByText('All-day hearing');
  const allDay = screen.getByText('All-day hearing').closest('button');
  const midnight = screen.getByText('Midnight call').closest('button');
  expect(allDay).toHaveTextContent('All day');
  expect(midnight).toHaveTextContent('12:00 AM');
});

test('shows a continuing event on today even when it started yesterday', async () => {
  mockSpanning = true;
  try {
    renderWithProviders(<DashboardCalendarWidget lawFirmId="firm-1" compact={false} onNavigate={jest.fn()} />);
    expect(await screen.findByText('All-day hearing')).toBeInTheDocument();
  } finally { mockSpanning = false; }
});
