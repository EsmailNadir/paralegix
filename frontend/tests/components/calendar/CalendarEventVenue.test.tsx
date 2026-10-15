/**
 * How `Calendar` hands a firm event's venue to the day panel.
 *
 * The court is its own field. Folding it into the location used to hide the
 * event's own location name whenever the event had a court, and the panel's
 * edit form then saved that joined string back as the address.
 */
import React from 'react';
import dayjs from 'dayjs';
import { screen } from '@testing-library/react';
import Calendar from '@/components/calendarComp/Calendar';
import type { Event } from '@/types';
import type { MatterEvent } from '@/types/matterEvent';
import type { ClientEvent } from '@/types/clientEvent';
import { renderWithProviders } from '../../support/renderWithProviders';

const today = dayjs().hour(10).minute(0).second(0).millisecond(0).toISOString();

let mockMatterEvents: Partial<MatterEvent>[] = [];
let mockClientEvents: Partial<ClientEvent>[] = [];
jest.mock('@/hooks/calendarHooks/useCalendarWindowData', () => ({
  __esModule: true,
  default: () => ({ matterEvents: mockMatterEvents, clientEvents: mockClientEvents, externalEvents: [], tasks: [],
    paymentDates: [], loading: false, fetching: false, rangeUnloaded: false, error: null, refreshTasks: jest.fn() }),
}));
jest.mock('@/hooks/calendarHooks/useNextUpTask', () => ({ __esModule: true, default: () => ({ nextUpTask: null, loading: false }) }));
jest.mock('@/hooks/calendarHooks/useUserSyncSettings', () => ({ __esModule: true, default: () => ({ syncFlags: null }) }));
jest.mock('@/hooks/useUsers', () => ({ useLawFirmUsers: () => ({ users: [], loading: false }) }));
// The panel is replaced by a dump of the events it is handed, so the spec reads
// exactly what Calendar built for each one.
jest.mock('@/components/calendarComp/CalendarSidePanel', () => ({
  __esModule: true,
  default: function PanelDump(props: { selectedDayEvents: Event[] }) {
    return (
      <ul>
        {props.selectedDayEvents.map((e) => (
          <li key={e.id} data-testid={`venue-${e.id}`}>
            {JSON.stringify({ location: e.location ?? null, court: e.court ?? null, locationName: e.locationName ?? null, locationAddress: e.locationAddress ?? null })}
          </li>
        ))}
      </ul>
    );
  },
}));

beforeEach(() => {
  mockMatterEvents = [];
  mockClientEvents = [];
  window.localStorage.setItem('paralegix-calendar-view', 'day');
});
afterEach(() => window.localStorage.removeItem('paralegix-calendar-view'));

/** The venue fields of one event, read from the first panel (desktop) that rendered it. */
function venueOf(id: string) {
  return JSON.parse(screen.getAllByTestId(`venue-${id}`)[0].textContent || '{}');
}

it('keeps a matter hearing\'s location name and shows its court separately', () => {
  mockMatterEvents = [{ id: 'hearing', title: 'Motion hearing', type: 'hearing', status: 'upcoming', matterId: 'matter-1',
    date: today, courtName: 'Superior Court', locationName: 'Dept. 12', location: '1 Main St' }];
  renderWithProviders(<Calendar />);
  expect(venueOf('hearing')).toEqual({
    location: 'Dept. 12 · 1 Main St', court: 'Superior Court', locationName: 'Dept. 12', locationAddress: '1 Main St',
  });
});

it('shows no court on a matter event that is not held at the court', () => {
  mockMatterEvents = [{ id: 'depo', title: 'Deposition', type: 'deposition', status: 'upcoming', matterId: 'matter-1',
    date: today, courtName: 'Superior Court', locationName: 'Opposing counsel office', location: '9 Elm St' }];
  renderWithProviders(<Calendar />);
  expect(venueOf('depo')).toEqual({
    location: 'Opposing counsel office · 9 Elm St', court: null, locationName: 'Opposing counsel office', locationAddress: '9 Elm St',
  });
});

it('keeps a client event\'s location name beside the court it was given', () => {
  mockClientEvents = [{ id: 'client-ev', title: 'Prep meeting', type: 'meeting', status: 'upcoming', source: 'client', clientId: 'client-1',
    date: today, courtName: 'District Court', locationName: 'Conference room B', location: '2 Oak Ave' }];
  renderWithProviders(<Calendar />);
  expect(venueOf('client-ev')).toEqual({
    location: 'Conference room B · 2 Oak Ave', court: 'District Court', locationName: 'Conference room B', locationAddress: '2 Oak Ave',
  });
});
