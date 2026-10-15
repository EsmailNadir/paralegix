/**
 * `CalendarSidePanel` under real permission sets.
 *
 * Every write the panel offers is refused by the backend without a specific
 * code: tasks.create / tasks.update / tasks.delete (tasks.routes.ts),
 * matters.update for a matter event, clients.manage for a client event,
 * calendar.sync for an imported event (calendarEvents.routes.ts), and
 * billing.recordPayments for a payment. A control the viewer cannot use is
 * hidden, never shown and then refused: a read-only member sees the agenda as
 * a read-only agenda.
 */
import React from 'react';
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import CalendarSidePanel from '@/components/calendarComp/CalendarSidePanel';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantBaselineMember, grantReadOnly, resetPermissions } from '../../support/permissions';
import type { Event, PaymentDate, Task } from '@/types';

afterEach(() => resetPermissions());

const task = { id: 'task-1', lawFirmId: 'firm-1', title: 'Draft motion', status: 'open', priority: 'medium' } as Task;
const event = (overrides: Partial<Event>): Event => ({
  id: 'event-1', title: 'Client meeting', start: '2026-09-05T14:00:00.000Z', eventStatus: 'upcoming', source: 'matter', ...overrides,
});
const payment = {
  id: 'pay-1', invoiceId: 'inv-1', billingItemType: 'invoice_due_date', contextType: 'matter', matterId: 'matter-1',
  matterName: 'Estate Plan', totalAmount: 1000, amountPaid: 0, dueDate: '2026-09-05', nextPaymentDate: null,
} as PaymentDate;

function renderPanel(props: Partial<React.ComponentProps<typeof CalendarSidePanel>> = {}) {
  return renderWithProviders(
    <CalendarSidePanel
      panelOpen
      selectedDate={dayjs('2026-09-05')}
      selectedDayTasks={[]}
      selectedDayEvents={[]}
      selectedDayPaymentDates={[]}
      lawFirmId="firm-1"
      lawFirmUsers={[]}
      syncFlags={null}
      onClose={() => {}}
      onTaskUpdate={jest.fn().mockResolvedValue(undefined)}
      onTaskDelete={jest.fn().mockResolvedValue(undefined)}
      onEventUpdate={jest.fn().mockResolvedValue(undefined)}
      onEventDelete={jest.fn().mockResolvedValue(undefined)}
      onEventCreate={jest.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

describe('a read-only member', () => {
  it('asks an organizer to confirm notification before saving an imported meeting', async () => {
    grantBaselineMember(['calendar.sync']);
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ source: 'external', provider: 'google', meeting: {
      isOrganizer: true, attendees: [{ email: 'guest@example.test' }],
    } })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(update).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('dialog', { name: 'Notify meeting attendees' });
    expect(confirmation).toHaveTextContent('1 attendee will be notified');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Save and notify' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ confirmNotifyAttendees: true })));
  });
  it('shows imported meeting details and provider links while keeping a guest read-only', () => {
    grantBaselineMember(['calendar.sync']);
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', startTimeZone: 'Pacific/Auckland', meeting: {
      organizer: { email: 'organizer@example.test' }, attendees: [{ email: 'guest@example.test', responseStatus: 'needsAction' }],
      responseStatus: 'needsAction', isOrganizer: false, isPrivate: true, status: 'tentative',
      providerUrl: 'https://calendar.google.com/calendar/event?eid=abc', joinUrl: 'https://meet.google.com/abc',
    } })] });
    expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = screen.getByRole('dialog', { name: 'Event details' });
    expect(within(dialog).getByText('(Sun 2:00 AM in Auckland)')).toBeInTheDocument();
    expect(within(dialog).getByText('Tentative')).toBeInTheDocument();
    expect(within(dialog).getByText('Awaiting your response')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open in Google' })).toHaveAttribute('href', 'https://calendar.google.com/calendar/event?eid=abc');
    expect(within(dialog).getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://meet.google.com/abc');
  });
  it('sees the day agenda with no create, edit, delete or status controls', () => {
    grantReadOnly();
    renderPanel({ selectedDayTasks: [task], selectedDayEvents: [event({})] });

    // The agenda itself is still there.
    expect(screen.getByText('Draft motion')).toBeInTheDocument();
    expect(screen.getByText('Client meeting')).toBeInTheDocument();
    for (const name of ['Create New Task', 'Create New Event', 'Edit task', 'Delete task', 'Edit event', 'Delete event']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('can open a task detail popup but is not offered Mark complete', () => {
    grantReadOnly();
    renderPanel({ selectedDayTasks: [task] });
    fireEvent.click(screen.getByText('Draft motion'));
    const dialog = screen.getByRole('dialog', { name: 'Task details' });
    expect(within(dialog).getByRole('button', { name: 'Open task' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
  });

  it('is not offered Mark completed on an event', () => {
    grantReadOnly();
    renderPanel({ selectedDayEvents: [event({})] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = screen.getByRole('dialog', { name: 'Event details' });
    expect(within(dialog).queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument();
  });
});

describe('task controls follow each task code separately', () => {
  it('offers Create New Task with tasks.create alone', () => {
    grantBaselineMember(['tasks.create']);
    renderPanel({ selectedDayTasks: [task] });
    expect(screen.getByRole('button', { name: /Create New Task/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('offers Edit task and Mark complete with tasks.update, but not Delete', () => {
    grantBaselineMember(['tasks.update']);
    renderPanel({ selectedDayTasks: [task] });
    expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create New Task/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Draft motion'));
    expect(within(screen.getByRole('dialog', { name: 'Task details' })).getByRole('button', { name: 'Mark complete' })).toBeInTheDocument();
  });

  it('offers Delete task with tasks.delete alone', () => {
    grantBaselineMember(['tasks.delete']);
    renderPanel({ selectedDayTasks: [task] });
    expect(screen.getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit task' })).not.toBeInTheDocument();
  });
});

describe('event controls follow the permission of the event source', () => {
  it.each([
    ['matter', 'matters.update'],
    ['client', 'clients.manage'],
    ['external', 'calendar.sync'],
  ] as const)('a %s event is editable with %s', (source, code) => {
    grantBaselineMember([code]);
    renderPanel({ selectedDayEvents: [event({ source })] });
    expect(screen.getByRole('button', { name: 'Edit event' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete event' })).toBeInTheDocument();
  });

  it.each([
    ['matter', 'clients.manage'],
    ['client', 'matters.update'],
    ['external', 'matters.update'],
  ] as const)('a %s event is not editable with only %s', (source, code) => {
    grantBaselineMember([code]);
    renderPanel({ selectedDayEvents: [event({ source })] });
    expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument();
  });

  it('offers Mark completed on a client event only with clients.manage', () => {
    grantBaselineMember(['matters.update']);
    renderPanel({ selectedDayEvents: [event({ source: 'client' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    expect(within(screen.getByRole('dialog', { name: 'Event details' })).queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument();
  });
});

describe('creating an event', () => {
  it('is offered with matters.update, linking only to a matter', () => {
    grantBaselineMember(['matters.update']);
    renderPanel({ initialDueDate: '2026-09-05T12:00' });
    fireEvent.click(screen.getByRole('button', { name: /Create New Event/ }));
    fireEvent.change(screen.getByPlaceholderText('Event title'), { target: { value: 'Hearing' } });
    // Step 2 holds the link target. Only the matter link is offered.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Link To *')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Matter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Client' })).not.toBeInTheDocument();
  });

  it('is offered with clients.manage alone', () => {
    grantBaselineMember(['clients.manage']);
    renderPanel();
    expect(screen.getByRole('button', { name: /Create New Event/ })).toBeInTheDocument();
  });

  it('is not offered with neither code', () => {
    grantBaselineMember(['tasks.create']);
    renderPanel();
    expect(screen.queryByRole('button', { name: /Create New Event/ })).not.toBeInTheDocument();
  });
});

describe('Mark as Paid', () => {
  it('needs billing.recordPayments, not just a read of the invoice', () => {
    grantBaselineMember(['billing.viewInvoices']);
    renderPanel({ selectedDayPaymentDates: [payment] });
    fireEvent.click(screen.getByText('Payment Due'));
    const dialog = screen.getByRole('dialog', { name: 'Payment details' });
    expect(within(dialog).getByRole('button', { name: 'View invoice' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Mark as Paid' })).not.toBeInTheDocument();
  });

  it('is offered with billing.recordPayments', () => {
    grantBaselineMember(['billing.recordPayments', 'billing.viewInvoices']);
    renderPanel({ selectedDayPaymentDates: [payment] });
    fireEvent.click(screen.getByText('Payment Due'));
    expect(within(screen.getByRole('dialog', { name: 'Payment details' })).getByRole('button', { name: 'Mark as Paid' })).toBeInTheDocument();
  });
});

test('offers whole-series deletion for a recurring matter event', async () => {
  grantBaselineMember(['matters.update']);
  const selected = event({ matterId: 'matter-1', recurrenceGroupId: 'series-1' });
  const remove = jest.fn().mockResolvedValue(undefined);
  renderPanel({ selectedDayEvents: [selected], onEventDelete: remove });
  fireEvent.click(screen.getByRole('button', { name: 'Delete event' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Delete the whole series' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete event' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(selected, true));
});
