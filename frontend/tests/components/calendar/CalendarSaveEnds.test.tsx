/**
 * What the Calendar page sends when its side panel saves an event's end.
 *
 * The panel's forms hold an all-day end as the LAST day the event covers; the
 * API and the providers both take the EXCLUSIVE day after it. Calendar.tsx is
 * where that conversion happens for matter, client and imported Google/Outlook
 * events, and an off-by-one there moves a multi-day event on every calendar it
 * syncs to without anything on this screen looking wrong.
 *
 * The panel is replaced by a stub that hands its save callbacks to the spec,
 * so each case drives Calendar's real handlers and reads the service call.
 */
import React from 'react';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import dayjs from 'dayjs';
import Calendar from '@/components/calendarComp/Calendar';
import type { Event, Task } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';

const mockUpdateEvent = jest.fn();
const mockCreateEvent = jest.fn();
const mockUpdateExternalEvent = jest.fn();
let mockWindowTasks: Task[] = [];
jest.mock('@/services/matterEvents.service', () => ({
  __esModule: true,
  default: {
    updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
    createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  },
}));
jest.mock('@/services/calendarEvents.service', () => ({
  __esModule: true,
  default: { updateExternalEvent: (...args: unknown[]) => mockUpdateExternalEvent(...args) },
}));
jest.mock('@/hooks/calendarHooks/useCalendarWindowData', () => ({
  __esModule: true,
  default: () => ({ matterEvents: [], clientEvents: [], externalEvents: [], tasks: mockWindowTasks, paymentDates: [], loading: false,
    fetching: false, rangeUnloaded: false, error: null, refreshTasks: jest.fn(), refetch: jest.fn() }),
}));
jest.mock('@/hooks/calendarHooks/useNextUpTask', () => ({ __esModule: true, default: () => ({ nextUpTask: null, loading: false }) }));
jest.mock('@/hooks/calendarHooks/useUserSyncSettings', () => ({ __esModule: true, default: () => ({ syncFlags: null }) }));
jest.mock('@/hooks/useUsers', () => ({ useLawFirmUsers: () => ({ users: [], loading: false }) }));

type PanelProps = {
  onEventUpdate: (event: Event, updates: Record<string, unknown>) => Promise<void>;
  onEventCreate?: (data: Record<string, unknown>) => Promise<void>;
};
let panel: PanelProps;
jest.mock('@/components/calendarComp/CalendarSidePanel', () => ({
  __esModule: true,
  default: function PanelStub(props: PanelProps) {
    panel = props;
    return null;
  },
}));

const base = { title: 'Trial', eventType: 'trial', notes: null, location: null, eventStatus: 'upcoming' };

beforeEach(() => {
  mockWindowTasks = [];
  mockUpdateEvent.mockReset().mockResolvedValue({});
  mockCreateEvent.mockReset().mockResolvedValue({});
  mockUpdateExternalEvent.mockReset().mockResolvedValue({});
  renderWithProviders(<Calendar />);
});

it('counts one multi-day task once in calendar categories', () => {
  cleanup();
  const first = dayjs().startOf('month').add(9, 'day').format('YYYY-MM-DD');
  mockWindowTasks = [{ id: 'span', taskId: 'span', title: 'Spanning task', status: 'open', source: 'app', allDay: true,
    dueDate: `${first}T12:00:00Z`, dueDateLocalInput: `${first}T00:00`,
    endsAt: dayjs(first).add(3, 'day').format('YYYY-MM-DD') + 'T12:00:00Z' } as Task];
  renderWithProviders(<Calendar />);
  fireEvent.click(screen.getByRole('button', { name: 'Month' }));
  const row = screen.getByText('Open', { exact: true }).parentElement!.parentElement!;
  expect(within(row).getByText('1', { exact: true })).toBeInTheDocument();
});

describe('a matter event end', () => {
  it('sends an all-day last day as the exclusive day after it', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'e1', title: 'Trial', source: 'matter', matterId: 'm1', allDay: true } as Event,
      { ...base, date: '2026-09-05T00:00', endsAt: '2026-09-07', allDay: true },
    ));

    expect(mockUpdateEvent).toHaveBeenCalledWith(expect.any(String), 'm1', 'e1', expect.objectContaining({ endsAt: '2026-09-08' }));
  });

  it('sends null for a cleared end, and nothing at all when the caller sent no end', async () => {
    const event = { id: 'e1', title: 'Trial', source: 'matter', matterId: 'm1' } as Event;
    await act(() => panel.onEventUpdate(event, { ...base, date: '2026-09-05T09:00', endsAt: '', allDay: false }));
    await act(() => panel.onEventUpdate(event, { ...base, date: '2026-09-05T09:00', allDay: false }));

    expect(mockUpdateEvent.mock.calls[0][3]).toHaveProperty('endsAt', null);
    // The mark-complete toggle sends no end; the stored one must be left alone.
    expect(mockUpdateEvent.mock.calls[1][3]).not.toHaveProperty('endsAt');
  });

  it('passes the end of a new event through', async () => {
    await act(() => panel.onEventCreate!({
      title: 'Trial', date: '2026-09-05T00:00', endsAt: '2026-09-08', eventType: 'trial',
      linkType: 'matter', matterId: 'm1', allDay: true,
    }));

    expect(mockCreateEvent).toHaveBeenCalledWith(expect.any(String), 'm1', expect.objectContaining({ endsAt: '2026-09-08' }));
  });
});

describe('an imported Google or Outlook event end', () => {
  it('sends an all-day last day as the provider\'s exclusive end date', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Trial', source: 'external', allDay: true, start: '2026-09-05', end: '2026-09-06' } as Event,
      { ...base, date: '2026-09-05T00:00', endsAt: '2026-09-07', allDay: true },
    ));

    expect(mockUpdateExternalEvent).toHaveBeenCalledWith(expect.any(String), 'x1', expect.objectContaining({
      start: '2026-09-05', end: '2026-09-08', allDay: true,
    }));
  });

  it('sends a picked timed end as an instant', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Call', source: 'external', start: dayjs('2026-09-05T13:00').toISOString(), end: dayjs('2026-09-05T14:00').toISOString() } as Event,
      { ...base, date: '2026-09-05T13:00', endsAt: '2026-09-05T15:30', allDay: false },
    ));

    expect(mockUpdateExternalEvent.mock.calls[0][2].end).toBe(dayjs('2026-09-05T15:30').toISOString());
  });

  it('keeps the event\'s length when no end was picked', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Call', source: 'external', start: dayjs('2026-09-05T13:00').toISOString(), end: dayjs('2026-09-05T14:30').toISOString() } as Event,
      { ...base, date: '2026-09-06T09:00', endsAt: '', allDay: false },
    ));

    expect(mockUpdateExternalEvent.mock.calls[0][2].start).toBe(dayjs('2026-09-06T09:00').toISOString());
    expect(mockUpdateExternalEvent.mock.calls[0][2]).not.toHaveProperty('end');
  });
});

// The side panel sends a schedule field only when the user changed it. One it
// leaves out must stay out, or the stored value is overwritten by the form's
// cached copy (or, for a provider event, by a recomputed 1-hour block).
describe('an edit that leaves the schedule alone', () => {
  const titleOnly = { title: 'Renamed', eventType: 'trial', notes: null, location: null, eventStatus: 'upcoming' };

  it('sends a matter event no date, end or all-day flag', async () => {
    await act(() => panel.onEventUpdate({ id: 'e1', title: 'Trial', source: 'matter', matterId: 'm1', allDay: true } as Event, titleOnly));

    const sent = mockUpdateEvent.mock.calls[0][3];
    expect(sent.title).toBe('Renamed');
    expect(sent).not.toHaveProperty('date');
    expect(sent).not.toHaveProperty('endsAt');
    expect(sent).not.toHaveProperty('allDay');
  });

  it('sends a provider event no start, end or all-day flag', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Call', source: 'external', start: dayjs('2026-09-05T13:00').toISOString() } as Event,
      titleOnly,
    ));

    const sent = mockUpdateExternalEvent.mock.calls[0][2];
    expect(sent.title).toBe('Renamed');
    expect(sent).not.toHaveProperty('start');
    expect(sent).not.toHaveProperty('end');
    expect(sent).not.toHaveProperty('allDay');
  });

  // The cached end may be older than the stored one (a resize polled in since),
  // so the server, which carries its stored end along, keeps the length.
  it('sends a provider event only its new start when only the start moved', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Call', source: 'external', start: dayjs('2026-09-05T13:00').toISOString() } as Event,
      { ...titleOnly, date: '2026-09-06T09:00' },
    ));

    const sent = mockUpdateExternalEvent.mock.calls[0][2];
    expect(sent.start).toBe(dayjs('2026-09-06T09:00').toISOString());
    expect(sent).not.toHaveProperty('end');
    expect(sent).not.toHaveProperty('allDay');
  });

  // Flipping all-day with no end makes the server drop the end, which Google
  // and Outlook do not accept, so the update still brings one of its own.
  it('still sends a provider event an end when it is switched to all-day', async () => {
    await act(() => panel.onEventUpdate(
      { id: 'x1', title: 'Call', source: 'external', start: dayjs('2026-09-05T13:00').toISOString(), end: dayjs('2026-09-05T14:30').toISOString() } as Event,
      { ...titleOnly, allDay: true },
    ));

    expect(mockUpdateExternalEvent.mock.calls[0][2]).toMatchObject({ start: '2026-09-05', end: '2026-09-06', allDay: true });
  });
});
