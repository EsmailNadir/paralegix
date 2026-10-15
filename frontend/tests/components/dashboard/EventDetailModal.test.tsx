/**
 * The dashboard's event detail dialog: the day and time it reports.
 *
 * An all-day event carries a calendar day, not a moment. Its stored instant
 * (noon UTC for a matter event, midnight UTC for some provider labels) falls on
 * another day once read in a zone far enough from UTC: noon UTC is already the
 * next morning in Auckland, and midnight UTC is the previous afternoon here.
 * jest.config.js pins every worker to Los Angeles, so the midnight case is the
 * one that makes the shift live in this suite.
 */
import React from 'react';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import EventDetailModal from '@/components/dashboardComp/EventDetailModal';
import type { CalendarWidgetEvent } from '@/components/dashboardComp/DashboardCalendarWidget';

function widgetEvent(overrides: Partial<CalendarWidgetEvent>): CalendarWidgetEvent {
  return {
    key: 'matter-ev-1', id: 'ev-1', title: 'Hearing', iso: '2026-10-05T12:00:00.000Z', dayKey: '2026-10-05',
    hasTime: false, type: 'court_date', source: 'matter', matterId: 'matter-1', matterName: 'Smith v. Jones',
    clientName: null, locationName: null, ...overrides,
  };
}

function renderWhen(event: CalendarWidgetEvent) {
  renderWithProviders(<EventDetailModal event={event} open onClose={jest.fn()} lawFirmId="firm-1" />);
  const dialog = screen.getByRole('dialog', { name: event.title });
  return within(dialog).getByText('When').closest('div')!.querySelector('dd')!;
}

describe('the dashboard event dialog', () => {
  it('names the stored calendar day for an all-day event, not the day its instant falls on locally', () => {
    // Read as an instant this is Sun Oct 4 at 5:00 PM in Los Angeles.
    const when = renderWhen(widgetEvent({ allDay: true, iso: '2026-10-05T00:00:00.000Z' }));
    expect(when).toHaveTextContent(/^Mon, Oct 5, 2026 · All day$/);
  });

  it('shows the full range of a multi-day all-day event, its end being exclusive', () => {
    const when = renderWhen(widgetEvent({ allDay: true, iso: '2026-10-05T12:00:00.000Z', end: '2026-10-08T12:00:00.000Z' }));
    expect(when).toHaveTextContent(/^Mon, Oct 5, 2026 – Wed, Oct 7, 2026 · All day$/);
  });

  it('shows the start and end time of a timed event in the viewer zone', () => {
    const when = renderWhen(widgetEvent({
      allDay: false, hasTime: true, iso: '2026-10-05T21:00:00.000Z', end: '2026-10-05T22:30:00.000Z',
    }));
    expect(when).toHaveTextContent(/^Mon, Oct 5, 2026 · 2:00 PM – 3:30 PM$/);
  });

  it('dates the end too when a timed event runs into another day', () => {
    const when = renderWhen(widgetEvent({
      allDay: false, hasTime: true, iso: '2026-10-05T21:00:00.000Z', end: '2026-10-07T01:00:00.000Z',
    }));
    expect(when).toHaveTextContent(/^Mon, Oct 5, 2026 · 2:00 PM – Tue, Oct 6, 2026 · 6:00 PM$/);
  });

  it('uses the server-formatted local times when the API sent them', () => {
    const when = renderWhen(widgetEvent({
      allDay: false, hasTime: true, iso: '2026-10-05T21:00:00.000Z', end: '2026-10-05T22:30:00.000Z',
      startLocalDisplay: 'Oct 5, 2026, 5:00 PM', endLocalDisplay: 'Oct 5, 2026, 6:30 PM',
    }));
    expect(when).toHaveTextContent(/^Oct 5, 2026, 5:00 PM – Oct 5, 2026, 6:30 PM$/);
  });
});
