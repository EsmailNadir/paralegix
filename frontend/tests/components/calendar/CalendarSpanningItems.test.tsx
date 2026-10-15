/**
 * Calendar items that run past midnight, as the grid draws them.
 *
 * A timed event that crosses midnight is drawn on each day it covers. On the
 * days after its first, its block sits at the top of the day, and its time
 * line has to say when it ends: repeating the start ("11:30 PM") on the next
 * day reads as a second event that night.
 *
 * An older Google or Outlook item stored as a task is rebuilt into an event
 * for the grid; without its end, it shrinks to its start and drops off every
 * day after the first.
 */
import React from 'react';
import dayjs from 'dayjs';
import { screen } from '@testing-library/react';
import Calendar from '@/components/calendarComp/Calendar';
import type { Event, Task } from '@/types';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let mockTasks: Task[] = [];
let mockExternalEvents: Event[] = [];
jest.mock('@/hooks/calendarHooks/useCalendarWindowData', () => ({
  __esModule: true,
  default: () => ({ matterEvents: [], clientEvents: [], externalEvents: mockExternalEvents, tasks: mockTasks,
    paymentDates: [], loading: false, fetching: false, rangeUnloaded: false, error: null, refreshTasks: jest.fn() }),
}));
jest.mock('@/hooks/calendarHooks/useNextUpTask', () => ({ __esModule: true, default: () => ({ nextUpTask: null, loading: false }) }));
let mockSyncFlags: Record<string, boolean> | null = null;
jest.mock('@/hooks/calendarHooks/useUserSyncSettings', () => ({ __esModule: true, default: () => ({ syncFlags: mockSyncFlags }) }));
jest.mock('@/hooks/useUsers', () => ({ useLawFirmUsers: () => ({ users: [], loading: false }) }));
let mockPanelEvents: Event[] = [];
jest.mock('@/components/calendarComp/CalendarSidePanel', () => ({
  __esModule: true,
  default: function PanelStub(props: { selectedDayEvents: Event[] }) {
    mockPanelEvents = props.selectedDayEvents;
    return null;
  },
}));

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
  mockTasks = [];
  mockExternalEvents = [];
  mockPanelEvents = [];
  mockSyncFlags = null;
  window.localStorage.setItem('paralegix-calendar-view', 'day');
});
afterEach(() => { api.restore(); window.localStorage.removeItem('paralegix-calendar-view'); });

const today = dayjs().format('YYYY-MM-DD');
const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

it('labels an event that started the night before by when it ends', () => {
  mockSyncFlags = { loggedInWithMicrosoft: true, allowOutlookToParalegixSync: true };
  mockExternalEvents = [{ id: 'late', title: 'Late call', source: 'external', provider: 'outlook', allDay: false,
    start: dayjs(`${yesterday}T23:30`).toISOString(), end: dayjs(`${today}T01:00`).toISOString() } as Event];
  renderWithProviders(<Calendar />);

  const block = screen.getByText('Late call').closest('[role="button"]') as HTMLElement;
  expect(block).toHaveTextContent('until 1:00 AM');
  expect(block).not.toHaveTextContent('11:30 PM');
});

it('still labels an event by its start on the day it starts', () => {
  mockSyncFlags = { loggedInWithMicrosoft: true, allowOutlookToParalegixSync: true };
  mockExternalEvents = [{ id: 'late', title: 'Late call', source: 'external', provider: 'outlook', allDay: false,
    start: dayjs(`${today}T23:30`).toISOString(), end: dayjs(today).add(1, 'day').hour(1).toISOString() } as Event];
  renderWithProviders(<Calendar />);

  expect(screen.getByText('Late call').closest('[role="button"]')).toHaveTextContent('11:30 PM');
});

it('keeps the end of an older Google item stored as a task', () => {
  mockSyncFlags = { loggedInWithGoogle: true, allowGoogleToParalegixSync: true };
  const endsAt = dayjs(`${today}T15:30`).toISOString();
  mockTasks = [{ id: 'g1', taskId: 'g1', title: 'Imported deposition', status: 'open', source: 'google_calendar',
    googleEventId: 'google-1', allDay: false, dueDate: dayjs(`${today}T13:00`).toISOString(),
    dueDateLocalInput: `${today}T13:00`, endsAt } as unknown as Task];
  renderWithProviders(<Calendar />);

  const rebuilt = mockPanelEvents.find((e) => e.id === 'g1');
  expect(rebuilt?.source).toBe('external');
  expect(rebuilt?.end).toBe(endsAt);
});
