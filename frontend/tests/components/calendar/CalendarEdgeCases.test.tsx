jest.unmock('@/services/calendarEvents.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import dayjs from 'dayjs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import Calendar from '@/components/calendarComp/Calendar';
import type { Event, Task, PaymentDate } from '@/types';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let mockTasks: Task[] = [];
let mockExternalEvents: Event[] = [];
let mockPaymentDates: PaymentDate[] = [];
let mockEvent: Event;
let mockUpdates: Record<string, unknown>;
jest.mock('@/hooks/calendarHooks/useCalendarWindowData', () => ({
  __esModule: true,
  default: () => ({ matterEvents: [], clientEvents: [], externalEvents: mockExternalEvents, tasks: mockTasks,
    paymentDates: mockPaymentDates, loading: false, fetching: false, rangeUnloaded: false, error: null, refreshTasks: jest.fn() }),
}));
jest.mock('@/hooks/calendarHooks/useNextUpTask', () => ({ __esModule: true, default: () => ({ nextUpTask: null, loading: false }) }));
let mockSyncFlags: Record<string, boolean> | null = null;
jest.mock('@/hooks/calendarHooks/useUserSyncSettings', () => ({ __esModule: true, default: () => ({ syncFlags: mockSyncFlags }) }));
/** Imported Outlook events show only while importing from Outlook is on. */
const importingFromOutlook = { loggedInWithMicrosoft: true, allowOutlookToParalegixSync: true };
jest.mock('@/hooks/useUsers', () => ({ useLawFirmUsers: () => ({ users: [], loading: false }) }));
jest.mock('@/components/calendarComp/CalendarSidePanel', () => ({
  __esModule: true,
  default: function PanelBoundary(props: any) {
    return <>
      <button onClick={() => props.onEventUpdate(mockEvent, mockUpdates)}>Save test event</button>
      <span data-testid="panel-selection">{props.panelOpen ? props.selectedItemKey : 'closed'}</span>
      <span data-testid="panel-detail-request">{props.detailRequest?.item.kind ?? 'none'}:{props.detailRequest?.item.event?.id ?? props.detailRequest?.item.task?.id ?? props.detailRequest?.item.payment?.id ?? ''}</span>
      {props.onDetailOpen && <button onClick={props.onDetailOpen}>Open mobile details</button>}
      {props.onDetailClose && <button onClick={props.onDetailClose}>Close mobile details</button>}
    </>;
  },
}));

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
  mockTasks = [];
  mockExternalEvents = [];
  mockPaymentDates = [];
  mockSyncFlags = null;
  window.localStorage.setItem('paralegix-calendar-view', 'day');
});
afterEach(() => { api.restore(); window.localStorage.removeItem('paralegix-calendar-view'); });

it('places an explicitly timed midnight task at midnight in the time grid', () => {
  mockTasks = [{ id: 'midnight', title: 'Midnight task', status: 'open', allDay: false,
    dueDateLocalInput: `${dayjs().format('YYYY-MM-DD')}T00:00` } as Task];
  renderWithProviders(<Calendar />);
  expect(screen.getByText('Midnight task').closest('[role="button"]')).toHaveStyle({ top: '0px' });
});

it.each([30, 150])('preserves a synced event duration of %i minutes when its start changes', async (minutes) => {
  mockEvent = { id: 'event-1', title: 'Meeting', source: 'external', allDay: false,
    start: '2026-09-05T16:00:00.000Z', end: dayjs('2026-09-05T16:00:00.000Z').add(minutes, 'minute').toISOString() };
  mockUpdates = { title: 'Renamed meeting', date: '2026-09-06T10:00', allDay: false,
    eventType: 'other', eventStatus: 'upcoming', notes: null, location: null };
  api.put('/calendar-events/event-1', { event: mockEvent });
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save test event' })[0]);
  await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
  const body = api.calls('PUT')[0].body as { start: string; end: string };
  expect(body.start).toBe(dayjs('2026-09-06T10:00').toISOString());
  // The server carries the stored end along with the start, keeping its length.
  expect(body).not.toHaveProperty('end');
});

it('honors switching a synced all-day event to a timed event', async () => {
  mockEvent = { id: 'event-1', title: 'Meeting', source: 'external', allDay: true,
    start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T00:00:00.000Z' };
  mockUpdates = { title: 'Meeting', date: '2026-09-06T10:00', allDay: false,
    eventType: 'other', eventStatus: 'upcoming', notes: null, location: null };
  api.put('/calendar-events/event-1', { event: mockEvent });
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save test event' })[0]);
  await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
  expect(api.calls('PUT')[0].body).toMatchObject({ allDay: false,
    start: dayjs('2026-09-06T10:00').toISOString(), end: dayjs('2026-09-06T11:00').toISOString() });
});

it('moves the exclusive end along with a rescheduled multi-day all-day event', async () => {
  mockEvent = { id: 'event-1', title: 'Conference', source: 'external', allDay: true,
    start: '2026-09-05T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' };
  mockUpdates = { title: 'Conference', date: '2026-09-12T00:00', allDay: true,
    eventType: 'other', eventStatus: 'upcoming', notes: null, location: null };
  api.put('/calendar-events/event-1', { event: mockEvent });
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save test event' })[0]);
  await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
  const body = api.calls('PUT')[0].body as { start: string; end: string; allDay: boolean };
  expect(body).toMatchObject({ allDay: true, start: '2026-09-12' });
  expect(body).not.toHaveProperty('end');
});


it('shows a synced all-day event on its calendar date without a timezone shift', () => {
  mockSyncFlags = importingFromOutlook;
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'all-day', title: 'All-day appointment', source: 'external', provider: 'outlook',
    allDay: true, start: `${today}T00:00:00.000Z` }];
  renderWithProviders(<Calendar />);
  expect(screen.getByText('All-day appointment')).toBeInTheDocument();
});

it('shows continuing all-day events but excludes their exclusive end date', () => {
  mockSyncFlags = importingFromOutlook;
  const today = dayjs().format('YYYY-MM-DD');
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
  mockExternalEvents = [
    { id: 'continuing', title: 'Continuing conference', source: 'external', provider: 'outlook', allDay: true,
      start: `${yesterday}T00:00:00.000Z`, end: `${tomorrow}T00:00:00.000Z` },
    { id: 'ended', title: 'Ended conference', source: 'external', provider: 'outlook', allDay: true,
      start: `${yesterday}T00:00:00.000Z`, end: `${today}T00:00:00.000Z` },
  ];
  renderWithProviders(<Calendar />);
  expect(screen.getByText('Continuing conference')).toBeInTheDocument();
  expect(screen.queryByText('Ended conference')).not.toBeInTheDocument();
});

it('opens the selected day panel on one click without requesting event details', () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'meeting-1', title: 'Timed meeting', source: 'external',
    start: `${today}T14:00:00`, end: `${today}T15:00:00`, allDay: false }];
  renderWithProviders(<Calendar />);
  const block = screen.getByText('Timed meeting').closest('[role="button"]')!;

  fireEvent.click(block);
  expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-meeting-1');
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'none:']);

});

it('opens the overlay panel after a brief single-click delay', () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'overlay-1', title: 'Overlay meeting', source: 'external', allDay: false,
    start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
  renderWithProviders(<Calendar />);
  const block = screen.getByText('Overlay meeting').closest('[role="button"]')!;
  jest.useFakeTimers();
  try {
    fireEvent.click(block, { detail: 1, clientX: 100, clientY: 100 });
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('closed');
    act(() => { jest.advanceTimersByTime(179); });
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('closed');
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-overlay-1');
  } finally {
    jest.useRealTimers();
  }
});

it('opens details when the second mouse click lands on the overlay panel', async () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'double-1', title: 'Double meeting', source: 'external', allDay: false,
    start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
  renderWithProviders(<Calendar />);
  const block = screen.getByText('Double meeting').closest('[role="button"]')!;
  fireEvent.click(block, { detail: 1, clientX: 100, clientY: 100 });
  await waitFor(() => expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-double-1'));
  fireEvent.click(document.querySelector('aside[role="dialog"]')!, { detail: 2, clientX: 100, clientY: 100 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'event:double-1']);
  expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('closed');
});

it('opens details when the second click lands on the panel backdrop', async () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'backdrop-1', title: 'Backdrop meeting', source: 'external', allDay: false,
    start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getByText('Backdrop meeting').closest('[role="button"]')!, { detail: 1, clientX: 100, clientY: 100 });
  await waitFor(() => expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-backdrop-1'));
  fireEvent.click(document.querySelector('div.fixed.inset-0[aria-hidden="true"]')!, { detail: 2, clientX: 100, clientY: 100 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'event:backdrop-1']);
});

it('does not treat a tap elsewhere on the open panel as a second grid tap', async () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'elsewhere-1', title: 'Elsewhere meeting', source: 'external', allDay: false,
    start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getByText('Elsewhere meeting').closest('[role="button"]')!, { detail: 1, clientX: 100, clientY: 100 });
  await waitFor(() => expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-elsewhere-1'));
  fireEvent.click(document.querySelector('aside[role="dialog"]')!, { detail: 1, clientX: 200, clientY: 200 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'none:']);
  expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-elsewhere-1');
});

it.each(['day', 'week'])('requests task details from a timed task in %s view', (view) => {
  window.localStorage.setItem('paralegix-calendar-view', view);
  mockTasks = [{ id: 'task-1', title: 'Timed filing', status: 'open', allDay: false,
    dueDateLocalInput: `${dayjs().format('YYYY-MM-DD')}T10:00` } as Task];
  renderWithProviders(<Calendar />);
  const block = screen.getByText('Timed filing').closest('[role="button"]')!;
  fireEvent.click(block, { detail: 1 });
  fireEvent.click(block, { detail: 2 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'task:task-1']);
});

it('requests event details from an all-day chip in week view', () => {
  window.localStorage.setItem('paralegix-calendar-view', 'week');
  const today = dayjs().format('YYYY-MM-DD');
  mockExternalEvents = [{ id: 'all-day-1', title: 'All-day meeting', source: 'external', allDay: true,
    start: `${today}T00:00:00.000Z`, end: `${dayjs().add(1, 'day').format('YYYY-MM-DD')}T00:00:00.000Z` }];
  renderWithProviders(<Calendar />);
  const chip = screen.getByText('All-day meeting').closest('[role="button"]')!;
  fireEvent.click(chip, { detail: 1 });
  fireEvent.click(chip, { detail: 2 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'event:all-day-1']);
});

it('requests payment details from an all-day payment chip', () => {
  const today = dayjs().format('YYYY-MM-DD');
  mockPaymentDates = [{ id: 'payment-1', invoiceId: 'invoice-1', billingItemType: 'invoice_due_date',
    contextType: 'matter', matterId: 'matter-1', matterName: 'Lease matter', totalAmount: 1000,
    amountPaid: 0, dueDate: today, nextPaymentDate: null } as PaymentDate];
  renderWithProviders(<Calendar />);
  const chip = screen.getByText('$1,000').closest('[role="button"]')!;
  fireEvent.click(chip, { detail: 1 });
  fireEvent.click(chip, { detail: 2 });
  expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'payment:payment-1']);
});

it('routes a wide-screen double click only to the docked panel', () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ ...originalMatchMedia(query), matches: query === '(min-width: 1280px)' });
  try {
    const today = dayjs().format('YYYY-MM-DD');
    mockExternalEvents = [{ id: 'desktop-1', title: 'Desktop meeting', source: 'external', allDay: false,
      start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
    renderWithProviders(<Calendar />);
    fireEvent.doubleClick(screen.getByText('Desktop meeting').closest('[role="button"]')!);
    expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['event:desktop-1', 'none:']);
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

it('lets a touch double tap open details after the panel appears', async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ ...originalMatchMedia(query), matches: query === '(pointer: coarse)' });
  try {
    const today = dayjs().format('YYYY-MM-DD');
    mockExternalEvents = [{ id: 'touch-1', title: 'Touch meeting', source: 'external', allDay: false,
      start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
    renderWithProviders(<Calendar />);
    const block = screen.getByText('Touch meeting').closest('[role="button"]')!;
    fireEvent.click(block, { detail: 1, clientX: 100, clientY: 100 });
    await waitFor(() => expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-touch-1'));
    fireEvent.click(document.querySelector('aside[role="dialog"]')!, { detail: 2, clientX: 100, clientY: 100 });
    expect(screen.getAllByTestId('panel-detail-request').map(node => node.textContent)).toEqual(['none:', 'event:touch-1']);
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('closed');
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

it('opens the mobile agenda after one touch tap and hides it while details are open', async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ ...originalMatchMedia(query), matches: query === '(pointer: coarse)' });
  try {
    const today = dayjs().format('YYYY-MM-DD');
    mockExternalEvents = [{ id: 'single-touch', title: 'Single touch meeting', source: 'external', allDay: false,
      start: `${today}T14:00:00`, end: `${today}T15:00:00` }];
    renderWithProviders(<Calendar />);
    fireEvent.click(screen.getByText('Single touch meeting').closest('[role="button"]')!, { detail: 1 });
    await waitFor(() => expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-single-touch'));
    fireEvent.click(screen.getByRole('button', { name: 'Open mobile details' }));
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('closed');
    fireEvent.click(screen.getByRole('button', { name: 'Close mobile details' }));
    expect(screen.getAllByTestId('panel-selection').map(node => node.textContent)).toContain('event-single-touch');
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});
