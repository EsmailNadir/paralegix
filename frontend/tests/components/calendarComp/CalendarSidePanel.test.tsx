/**
 * `CalendarSidePanel`: the day agenda, including the read-only detail popup's
 * "Mark as Paid" action.
 *
 * Rules that produce a wrong record or a wrong disclosure if they slip:
 *
 *   AN INSTALLMENT PAYS ITS SCHEDULED AMOUNT; A WHOLE INVOICE PAYS ITS
 *   REMAINING BALANCE (total minus paid minus written-off), never the raw
 *   invoice total - paying the raw total on a partly-paid invoice overcharges
 *   the client.
 *
 *   "MARK AS PAID" MUST NOT OFFER TO PAY AN INVOICE THAT HAS NO BALANCE LEFT
 *   or a payment-received item, which was never owed to begin with.
 *
 *   AN EXTERNAL (SYNCED) EVENT HAS NO COMPLETE/UPCOMING TOGGLE - it isn't
 *   ours to mark done.
 */
const mockUpdateInvoicePayment = jest.fn();

jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    updateInvoicePayment: (...args: unknown[]) => mockUpdateInvoicePayment(...args),
  },
}));

// A stable handle on the courts read, so a spec can count it. The global service
// mock hands out a fresh function on every property access.
const mockListCourts = jest.fn();

jest.mock("@/services/courts.service", () => ({
  __esModule: true,
  default: {
    listCourts: (...args: unknown[]) => mockListCourts(...args),
  },
}));

const mockNavigate = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({
    navigate: mockNavigate,
    isNavigating: false,
  }),
}));

import React from "react";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import dayjs from "dayjs";
import CalendarSidePanel from "@/components/calendarComp/CalendarSidePanel";
import { renderWithProviders } from "../../support/renderWithProviders";
import type { Task, Event, PaymentDate } from "@/types";
import { STATUS_VARIANTS, matterEventTypeMeta } from "@/constants/statusMeta";

function payment(overrides: Partial<PaymentDate> = {}): PaymentDate {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    billingItemType: "invoice_due_date",
    contextType: "matter",
    matterId: "matter-1",
    matterName: "Estate Plan",
    totalAmount: 1000,
    amountPaid: 0,
    dueDate: "2026-09-05",
    nextPaymentDate: null,
    ...overrides,
  } as PaymentDate;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    lawFirmId: "firm-1",
    title: "Draft motion",
    status: "open",
    priority: "medium",
    ...overrides,
  } as Task;
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "event-1",
    title: "Client meeting",
    start: "2026-09-05T14:00:00.000Z",
    eventStatus: "upcoming",
    source: "matter",
    ...overrides,
  } as Event;
}

const noop = () => {};
const asyncNoop = async () => {};

function renderPanel(props: Partial<React.ComponentProps<typeof CalendarSidePanel>>) {
  return renderWithProviders(panel(props));
}

function panel(props: Partial<React.ComponentProps<typeof CalendarSidePanel>>) {
  return (
    <CalendarSidePanel
      panelOpen
      selectedDate={dayjs("2026-09-05")}
      selectedDayTasks={[]}
      selectedDayEvents={[]}
      selectedDayPaymentDates={[]}
      lawFirmId="firm-1"
      lawFirmUsers={[]}
      syncFlags={null}
      onClose={noop}
      onTaskUpdate={jest.fn().mockResolvedValue(undefined)}
      onTaskDelete={jest.fn().mockResolvedValue(undefined)}
      onEventUpdate={jest.fn().mockResolvedValue(undefined)}
      onEventDelete={asyncNoop}
      {...props}
    />
  );
}

it("opens the existing event popup for a grid detail request", async () => {
  renderPanel({ detailRequest: { id: 1, item: { kind: 'event', event: event() } } });
  expect(await screen.findByText('Event details')).toBeInTheDocument();
  expect(screen.getByText('Client meeting')).toBeInTheDocument();
});

it("opens the existing task popup for a grid detail request", async () => {
  const { container } = renderPanel({ detailRequest: { id: 1, item: { kind: 'task', task: task() } } });
  const title = await screen.findByText('Task details');
  expect(container.contains(title)).toBe(false);
  expect(screen.getByText('Draft motion')).toBeInTheDocument();
});

it("hides the mobile agenda behind details and restores it when details close", async () => {
  const onDetailOpen = jest.fn();
  const onDetailClose = jest.fn();
  renderPanel({ selectedDayEvents: [event()], onDetailOpen, onDetailClose });
  fireEvent.click(screen.getByText('Client meeting').closest('[role="button"]')!);
  expect(onDetailOpen).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Event details' })).getByText('Close'));
  expect(onDetailClose).toHaveBeenCalledTimes(1);
});

beforeEach(() => {
  mockUpdateInvoicePayment.mockReset().mockResolvedValue({});
  mockListCourts.mockReset().mockResolvedValue({ courts: [{ id: "court-1", name: "Superior Court" }] });
});

// The court picker lives only in the create/edit task modals, so the day agenda
// must not load the firm's courts until one of them opens.
describe("court picker data", () => {
  it("loads no courts until the create-task modal opens, then loads them once", async () => {
    renderPanel({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockListCourts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Create New Task/ }));

    await waitFor(() => expect(mockListCourts).toHaveBeenCalledTimes(1));
    expect(mockListCourts).toHaveBeenCalledWith("firm-1");
  });
});

function openPaymentDetail(label: string) {
  fireEvent.click(screen.getByText(label));
}

describe("mark-as-paid amount", () => {
  it("pays the scheduled amount for an installment, carrying its index", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          id: "pay-installment",
          billingItemType: "installment",
          installmentIndex: 2,
          scheduledAmount: 250,
          totalAmount: 1000,
          amountPaid: 250,
        }),
      ],
    });

    openPaymentDetail("Payment Plan Installment");
    fireEvent.click(screen.getByRole("button", { name: "Mark as Paid" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));

    await waitFor(() => expect(mockUpdateInvoicePayment).toHaveBeenCalledTimes(1));
    const [, invoiceId, body] = mockUpdateInvoicePayment.mock.calls[0];
    expect(invoiceId).toBe("inv-1");
    expect(body.paymentAmount).toBe(250);
    expect(body.installmentIndex).toBe(2);
  });

  it("pays the remaining balance for a whole invoice, not the raw total", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          billingItemType: "invoice_due_date",
          totalAmount: 1000,
          amountPaid: 300,
          totalWrittenOff: 100,
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    fireEvent.click(screen.getByRole("button", { name: "Mark as Paid" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));

    await waitFor(() => expect(mockUpdateInvoicePayment).toHaveBeenCalledTimes(1));
    const [, , body] = mockUpdateInvoicePayment.mock.calls[0];
    expect(body.paymentAmount).toBe(600); // 1000 - 300 - 100
    expect(body.installmentIndex).toBeUndefined();
  });

  it("pays the remaining balance in whole cents, not a float-dollar residue", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          billingItemType: "invoice_due_date",
          totalAmount: 1000.07,
          amountPaid: 500.03,
          totalWrittenOff: 0.01,
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    fireEvent.click(screen.getByRole("button", { name: "Mark as Paid" }));
    expect(screen.getByText(/Record payment of \$500\.03 for this invoice\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));

    await waitFor(() => expect(mockUpdateInvoicePayment).toHaveBeenCalledTimes(1));
    const [, , body] = mockUpdateInvoicePayment.mock.calls[0];
    // In float dollars 1000.07 - 500.03 - 0.01 is 500.0300000000001.
    expect(body.paymentAmount).toBe(500.03);
  });

  it("routes the payment to the client, not the matter, when the item is client-scoped", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          contextType: "client",
          clientId: "client-9",
          matterId: "matter-should-not-be-used",
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    fireEvent.click(screen.getByRole("button", { name: "Mark as Paid" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));

    await waitFor(() => expect(mockUpdateInvoicePayment).toHaveBeenCalledTimes(1));
    const [context] = mockUpdateInvoicePayment.mock.calls[0];
    expect(context.type).toBe("client");
    expect(context.entityId).toBe("client-9");
  });

  it("does not record payment when confirmation modal is canceled", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          billingItemType: "invoice_due_date",
          totalAmount: 1000,
          amountPaid: 300,
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    fireEvent.click(screen.getByRole("button", { name: "Mark as Paid" }));
    expect(screen.getByRole("dialog", { name: "Mark payment as paid" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Mark payment as paid" })).not.toBeInTheDocument();
    });
    expect(mockUpdateInvoicePayment).not.toHaveBeenCalled();
  });
});

describe("mark-as-paid visibility", () => {
  it("offers no Mark as Paid button once an invoice's balance is fully paid", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({ billingItemType: "invoice_due_date", totalAmount: 500, amountPaid: 500 }),
      ],
    });

    openPaymentDetail("Payment Due");
    expect(screen.queryByRole("button", { name: "Mark as Paid" })).not.toBeInTheDocument();
  });

  it("offers no Mark as Paid button for a payment-received item", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({ billingItemType: "payment_received", amountPaid: 500, paidAmount: 500 }),
      ],
    });

    openPaymentDetail("Payment Received");
    expect(screen.queryByRole("button", { name: "Mark as Paid" })).not.toBeInTheDocument();
  });

  it("offers no Mark as Paid button when payments and credits settle the invoice to the cent", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        // 1.1 - 1 - 0.1 is 8.3e-17 in float dollars, which used to read as still owed.
        payment({ billingItemType: "invoice_due_date", totalAmount: 1.1, amountPaid: 1, totalWrittenOff: 0.1 }),
      ],
    });

    openPaymentDetail("Payment Due");
    expect(screen.getByRole("dialog", { name: "Payment details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as Paid" })).not.toBeInTheDocument();
  });

  it("displays amount due with inline context for partial payments and no minus signs", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          billingItemType: "invoice_due_date",
          totalAmount: 7869,
          amountPaid: 3000,
          totalWrittenOff: 869,
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    const dialog = screen.getByRole("dialog", { name: "Payment details" });
    expect(within(dialog).getByText("$4,000")).toBeInTheDocument();
    expect(
      within(dialog).getByText("$3,000 paid of $7,869 invoice total · $869 credit")
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("−$3,000")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/−\$869/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Remaining balance")).not.toBeInTheDocument();
  });

  it("routes View invoice to client invoice URL when item is client-scoped", async () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          contextType: "client",
          clientId: "client-123",
          matterId: "matter-456",
          invoiceId: "inv-999",
        }),
      ],
    });

    openPaymentDetail("Payment Due");
    fireEvent.click(screen.getByRole("button", { name: "View invoice" }));
    expect(mockNavigate).toHaveBeenCalledWith("/lawfirm/firm-1/clients/client-123/invoices/inv-999");
  });

  it("subtracts write-offs from balance on the day agenda payment card", () => {
    renderPanel({
      selectedDayPaymentDates: [
        payment({
          billingItemType: "invoice_due_date",
          totalAmount: 1000,
          amountPaid: 300,
          totalWrittenOff: 200,
        }),
      ],
    });

    expect(screen.getByText("$500")).toBeInTheDocument();
    expect(screen.getByText("$500 remaining")).toBeInTheDocument();

    openPaymentDetail("Payment Due");
    const dialog = screen.getByRole("dialog", { name: "Payment details" });
    expect(
      within(dialog).getByText("$300 paid of $1,000 invoice total · $200 credit")
    ).toBeInTheDocument();
  });
});

describe("event completion toggle", () => {
  it("hides the complete/upcoming toggle for an external synced event", async () => {
    renderPanel({ selectedDayEvents: [event({ source: "external", title: "Synced meeting" })] });

    fireEvent.click(screen.getByText("Synced meeting"));
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).queryByRole("button", { name: /Mark completed|Mark upcoming/ })).not.toBeInTheDocument();
  });

  it("offers the toggle for a firm-owned event", async () => {
    renderPanel({ selectedDayEvents: [event({ source: "matter", title: "Firm meeting" })] });

    fireEvent.click(screen.getByText("Firm meeting"));
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(within(dialog).getByRole("button", { name: "Mark completed" })).toBeInTheDocument();
  });
});

// An event's client names sit in the meta row beside its time, as a task's do.
// Placed in the title row they claim a fixed width and crush a long title.
describe("event card client names", () => {
  it("lists the client names in the meta row, not beside the title", () => {
    const start = "2026-09-05T14:00:00.000Z";
    renderPanel({
      selectedDayEvents: [event({ title: "Deposition prep with opposing counsel", start, clientNames: ["Jane Doe"] })],
    });

    const heading = screen.getByRole("heading", { name: "Deposition prep with opposing counsel" });
    const clientLabel = screen.getByText("Jane Doe");
    expect(heading.parentElement).not.toContainElement(clientLabel);
    expect(clientLabel.parentElement).toHaveTextContent(dayjs(start).format("h:mm A"));
  });

  // The type is a coloured badge, as on a matter's events tab and beside a
  // task's status, not plain meta text.
  it("shows the event type as a badge in its type colour", () => {
    renderPanel({ selectedDayEvents: [event({ eventType: "filing_deadline" })] });

    const typeLabel = screen.getByText("Filing Deadline");
    const { text } = STATUS_VARIANTS[matterEventTypeMeta("filing_deadline").variant];
    expect(typeLabel.className.split(" ")).toEqual(expect.arrayContaining(text.split(" ")));
  });
});

describe("task completion toggle", () => {
  it("sends the flipped status and closes the popup", async () => {
    const onTaskUpdate = jest.fn().mockResolvedValue(undefined);
    renderPanel({ selectedDayTasks: [task({ status: "open", title: "Draft motion" })], onTaskUpdate });

    fireEvent.click(screen.getByText("Draft motion"));
    fireEvent.click(screen.getByRole("button", { name: "Mark complete" }));

    await waitFor(() => expect(onTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task details" })).not.toBeInTheDocument());
  });
});

describe('midnight and all-day labels', () => {
  it.each(['task', 'event'] as const)('shows midnight as a time for an explicitly timed %s', (kind) => {
    renderPanel({
      selectedDayTasks: kind === 'task' ? [task({ allDay: false, dueDateLocalInput: '2026-09-05T00:00' })] : [],
      selectedDayEvents: kind === 'event' ? [event({ allDay: false, start: '2026-09-05T00:00' })] : [],
    });
    expect(screen.getByText('12:00 AM')).toBeInTheDocument();
  });

  it('keeps an explicitly all-day task all-day when only its serialized date is available', () => {
    renderPanel({ selectedDayTasks: [task({ allDay: true, dueDate: '2026-09-05T12:00:00.000Z' })] });
    expect(screen.getByText('All day')).toBeInTheDocument();
  });
});


it('keeps a synced all-day date unchanged in its detail popup', () => {
  renderPanel({ selectedDayEvents: [event({ source: 'external', allDay: true, start: '2026-09-05T00:00:00.000Z' })] });
  fireEvent.click(screen.getByText('Client meeting'));
  expect(screen.getByText('Sat, Sep 5, 2026 · All day')).toBeInTheDocument();
});

// "When" in the event popup is the whole span: a meeting that runs 2 to 3:30
// must not read as a 2 o'clock appointment of unknown length.
describe('event popup: when', () => {
  function openEvent(overrides: Partial<Event>) {
    renderPanel({ selectedDayEvents: [event({ source: 'external', ...overrides })] });
    fireEvent.click(screen.getByText('Client meeting'));
    return within(screen.getByRole('dialog', { name: 'Event details' }));
  }

  it('shows the start and end of a timed event on one day', () => {
    const dialog = openEvent({ allDay: false, start: '2026-09-05T14:00', end: '2026-09-05T15:30' });
    expect(dialog.getByText('Sat, Sep 5, 2026 · 2:00 PM – 3:30 PM')).toBeInTheDocument();
  });

  it('dates both ends of a timed event that runs past midnight', () => {
    const dialog = openEvent({ allDay: false, start: '2026-09-05T22:00', end: '2026-09-06T01:00' });
    expect(dialog.getByText('Sat, Sep 5, 2026 · 10:00 PM – Sun, Sep 6, 2026 · 1:00 AM')).toBeInTheDocument();
  });

  it('prefers the server-formatted start and end when the API sends them', () => {
    const dialog = openEvent({
      allDay: false, start: '2026-09-05T14:00', end: '2026-09-05T15:00',
      startLocalDisplay: 'Sep 5, 2026, 2:00 PM', endLocalDisplay: 'Sep 5, 2026, 3:00 PM',
    });
    expect(dialog.getByText('Sep 5, 2026, 2:00 PM – Sep 5, 2026, 3:00 PM')).toBeInTheDocument();
  });

  it('shows the last day of a multi-day all-day event, not its exclusive end', () => {
    const dialog = openEvent({ allDay: true, start: '2026-09-05T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' });
    expect(dialog.getByText('Sat, Sep 5, 2026 – Mon, Sep 7, 2026 · All day')).toBeInTheDocument();
  });
});

// The suite runs in Los Angeles (jest.config.js), so that is the viewer zone.
describe('event popup: time zone', () => {
  function openEvent(overrides: Partial<Event>) {
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', ...overrides })] });
    fireEvent.click(screen.getByText('Client meeting'));
    return within(screen.getByRole('dialog', { name: 'Event details' }));
  }

  it('gives a timed event set outside the viewer zone its time where it was set', () => {
    const dialog = openEvent({ startTimeZone: 'Europe/London' });
    const zone = dialog.getByText('(3:00 PM in London)');
    expect(zone).toHaveClass('text-on-surface-secondary');
    expect(dialog.getByText('When').nextElementSibling).toHaveTextContent(/^Sat, Sep 5, 2026 · 7:00 AM PDT \(3:00 PM in London\)$/);
  });

  it('leaves the zone out for an event in the viewer zone', () => {
    const dialog = openEvent({ startTimeZone: 'America/Los_Angeles' });
    expect(dialog.getByText('When').nextElementSibling).toHaveTextContent(/^Sat, Sep 5, 2026 · 7:00 AM$/);
  });

  it('leaves the zone out for an all-day event', () => {
    const dialog = openEvent({ allDay: true, start: '2026-09-05', startTimeZone: 'Europe/London' });
    expect(dialog.getByText('When').nextElementSibling).toHaveTextContent(/^Sat, Sep 5, 2026 · All day$/);
  });
});

describe('event popup: imported meeting details', () => {
  function openEvent(overrides: Partial<Event>) {
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', ...overrides })] });
    fireEvent.click(screen.getByText('Client meeting'));
    return within(screen.getByRole('dialog', { name: 'Event details' }));
  }

  it('marks a private meeting as Private', () => {
    const dialog = openEvent({ meeting: { attendees: [], organizer: { email: 'organizer@example.test' }, isPrivate: true } });
    expect(dialog.getByText('organizer@example.test')).toBeInTheDocument();
    expect(dialog.getByText('Visibility')).toBeInTheDocument();
    expect(dialog.getByText('Private')).toBeInTheDocument();
  });

  it('says nothing about visibility for a meeting that is not private', () => {
    const dialog = openEvent({ meeting: { attendees: [], organizer: { email: 'organizer@example.test' }, isPrivate: false } });
    expect(dialog.getByText('organizer@example.test')).toBeInTheDocument();
    expect(dialog.queryByText('Private')).not.toBeInTheDocument();
    expect(dialog.queryByText('Visibility')).not.toBeInTheDocument();
  });

  it('shows an imported event with no meeting details, and still offers to edit it', () => {
    const dialog = openEvent({ meeting: null, start: '2026-09-05T14:00', end: '2026-09-05T15:00' });
    expect(dialog.getByText('Sat, Sep 5, 2026 · 2:00 PM – 3:00 PM')).toBeInTheDocument();
    expect(dialog.queryByText('Organizer')).not.toBeInTheDocument();
    expect(dialog.queryByText('Attendees')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit event' })).toBeInTheDocument();
  });
});

// Notes and a meeting location often carry a dial-in or video link. In the
// popup they are links; anything but http(s), mailto and tel stays text.
describe('event popup: links', () => {
  it('links a URL in the notes and keeps the line breaks', () => {
    renderPanel({ selectedDayEvents: [event({ notes: 'Agenda attached.\nJoin: https://zoom.us/j/123' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = within(screen.getByRole('dialog', { name: 'Event details' }));
    const link = dialog.getByRole('link', { name: 'https://zoom.us/j/123' });
    expect(link).toHaveAttribute('href', 'https://zoom.us/j/123');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.parentElement).toHaveClass('whitespace-pre-wrap');
  });

  it('links a location that is a URL', () => {
    renderPanel({ selectedDayEvents: [event({ location: 'https://meet.google.com/abc-defg-hij' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = within(screen.getByRole('dialog', { name: 'Event details' }));
    expect(dialog.getByRole('link', { name: 'https://meet.google.com/abc-defg-hij' }))
      .toHaveAttribute('target', '_blank');
  });

  it('leaves a javascript: URL in the notes as text', () => {
    renderPanel({ selectedDayEvents: [event({ notes: 'javascript:alert(1)' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = screen.getByRole('dialog', { name: 'Event details' });
    expect(within(dialog).getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(dialog.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

// A firm event's location name, address and court are three fields. The panel
// shows the joined location, but its edit form edits the address alone: saving
// the joined string back would write the location name (and once the court)
// into the address.
describe('event venue', () => {
  const venue = {
    location: 'Dept. 12 · 1 Main St',
    locationName: 'Dept. 12',
    locationAddress: '1 Main St',
    court: 'Superior Court',
  };

  it('shows the court as its own field beside the location', () => {
    renderPanel({ selectedDayEvents: [event(venue)] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = within(screen.getByRole('dialog', { name: 'Event details' }));
    expect(dialog.getByText('Court').nextElementSibling).toHaveTextContent('Superior Court');
    expect(dialog.getByText('Location').nextElementSibling).toHaveTextContent('Dept. 12 · 1 Main St');
  });

  it('has no court field for an event without one', () => {
    renderPanel({ selectedDayEvents: [event({ ...venue, court: null })] });
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = within(screen.getByRole('dialog', { name: 'Event details' }));
    expect(dialog.getByText('Location')).toBeInTheDocument();
    expect(dialog.queryByText('Court')).not.toBeInTheDocument();
  });

  it('edits the address alone and saves it unchanged when it was not touched', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event(venue)] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Address')).toHaveValue('1 Main St');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1].location).toBe('1 Main St');
  });

  it('keeps the address when an event is marked completed from its popup', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event(venue)] });
    fireEvent.click(screen.getByText('Client meeting'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ eventStatus: 'completed', location: '1 Main St' });
  });

  it('edits an imported event\'s location, which is a single field', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ source: 'external', provider: 'google', location: 'Room 4, 5th floor' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Location')).toHaveValue('Room 4, 5th floor');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1].location).toBe('Room 4, 5th floor');
  });
});


describe('event end in the edit form', () => {
  it('can save a valid range across the repeated DST hour without changing its instants', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ allDay: false,
      start: '2026-11-01T08:30:00.000Z', end: '2026-11-01T09:15:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty('date');
    expect(update.mock.calls[0][1]).not.toHaveProperty('endsAt');
  });
  // The form holds a timed end as the browser's wall clock, like the start, and
  // an all-day end as the last day, one before the exclusive end the event
  // carries. Calendar.tsx converts the form value for the API.
  it('prefills a timed end and hands the edited value to the save', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const end = '2026-09-05T15:30:00.000Z';
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ end })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));

    expect(screen.getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent(dayjs(end).format('MMM D, YYYY'));
    expect(screen.getByRole('button', { name: 'End time' })).toHaveTextContent(dayjs(end).format('h:mm A'));

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty('endsAt');
  });

  it('drops the end when the start is cleared, so a later start can still be saved', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));

    fireEvent.click(screen.getByRole('button', { name: /^Start \*? ?(?!time)/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: /^End No end/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Start \*? ?(?!time)/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
    expect(screen.queryByText('The end must be after the start.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // The picker reopens on the current month once the start is empty.
    expect(update.mock.calls[0][1].date.slice(8, 10)).toBe('20');
    expect(update.mock.calls[0][1].endsAt).toBe('');
  });

  // Google and Outlook events always have an end, and the external update keeps
  // the stored one when none is sent, so "No end" would silently do nothing.
  it('does not let a provider event be saved with no end', () => {
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    expect(screen.getByText('End *')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^End \*/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));

    expect(screen.queryByRole('button', { name: /No end/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('says why a provider event with no end cannot be saved', () => {
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^End \*/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Google and Outlook events need an end time.');
  });

  // The form may have opened from a cached list older than a resize made in
  // Google and polled in since; resending its end would shrink the event back.
  it('sends no start, end or all-day flag when only the title changes', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ source: 'external', provider: 'google', end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Renamed meeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const sent = update.mock.calls[0][1];
    expect(sent.title).toBe('Renamed meeting');
    expect(sent).not.toHaveProperty('date');
    expect(sent).not.toHaveProperty('endsAt');
    expect(sent).not.toHaveProperty('allDay');
  });

  // The end follows a moved start in the form; the server moves its stored end
  // the same way, keeping a length the cached copy may not know about.
  it('sends only the start when the start moves and the end just follows it', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({
      source: 'external', provider: 'google', start: dayjs('2026-09-05T14:00').toISOString(), end: dayjs('2026-09-05T15:30').toISOString(),
    })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.click(screen.getByRole('button', { name: /^Start \*? ?(?!time)/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
    expect(screen.getByRole('button', { name: /^End \*/ })).toHaveTextContent('Sep 20, 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1].date).toBe('2026-09-20T14:00');
    expect(update.mock.calls[0][1]).not.toHaveProperty('endsAt');
  });

  it('sends no start or all-day flag when an event is only marked completed', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ eventStatus: 'completed' });
    expect(update.mock.calls[0][1]).not.toHaveProperty('date');
    expect(update.mock.calls[0][1]).not.toHaveProperty('allDay');
  });

  it('opens a provider event that has no stored end with the end it would be saved with', () => {
    const start = '2026-09-05T14:00:00.000Z';
    renderPanel({ selectedDayEvents: [event({ source: 'external', provider: 'google', start, end: undefined })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));

    // One default block after the start, which is what the update sends for it today.
    expect(screen.getByRole('button', { name: 'End time' })).toHaveTextContent(dayjs(start).add(1, 'hour').format('h:mm A'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('still offers No end on a firm event', () => {
    renderPanel({ selectedDayEvents: [event({ end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.click(screen.getByRole('button', { name: /^End (?!time)/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));

    expect(screen.getByRole('button', { name: /^End No end/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('prefills an all-day end as the last day the event covers', () => {
    renderPanel({ selectedDayEvents: [event({ allDay: true, start: '2026-09-05T12:00:00.000Z', end: '2026-09-08T12:00:00.000Z' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));

    // The 5th to the 7th: the exclusive 8th is never shown.
    expect(screen.getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent('Sep 7, 2026');
  });

  it('keeps the day of a timed end when the event is switched to all-day, and back', () => {
    const end = '2026-09-07T15:30:00.000Z';
    renderPanel({ selectedDayEvents: [event({ end })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    const continueButton = screen.getByRole('button', { name: 'Continue' });

    // Into all-day, the end's own day becomes the last day.
    fireEvent.click(screen.getByRole('switch', { name: 'All day' }));
    expect(screen.getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent(dayjs(end).format('MMM D, YYYY'));
    expect(continueButton).toBeEnabled();

    // And back out, the same day takes a time again.
    fireEvent.click(screen.getByRole('switch', { name: 'All day' }));
    expect(screen.getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent(dayjs(end).format('MMM D, YYYY'));
    expect(screen.getByRole('button', { name: 'End time' })).not.toHaveTextContent('Time');
    expect(continueButton).toBeEnabled();
  });

  it('sends no end when an event is only marked completed, so its stored end is left alone', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    renderPanel({ onEventUpdate: update, selectedDayEvents: [event({ end: '2026-09-05T15:30:00.000Z' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty('endsAt');
  });
});

describe('event and task times on the day agenda', () => {
  it('shows the last day of a multi-day all-day task', () => {
    renderPanel({ selectedDayTasks: [task({
      allDay: true,
      dueDate: '2026-09-05T12:00:00.000Z',
      dueDateLocalInput: '2026-09-05T00:00',
      endsAt: '2026-09-08T12:00:00.000Z',
    })] });

    expect(screen.getByText('All day – Sep 7, 2026')).toBeInTheDocument();
  });

  it('shows the end of a timed event, as a task card does', () => {
    renderPanel({ selectedDayEvents: [event({
      start: dayjs('2026-09-05T14:00').toISOString(),
      end: dayjs('2026-09-05T15:30').toISOString(),
    })] });

    expect(screen.getByText('2:00 PM – 3:30 PM')).toBeInTheDocument();
  });

  it('shows the last day of a multi-day all-day event', () => {
    renderPanel({ selectedDayEvents: [event({ allDay: true, start: '2026-09-05', end: '2026-09-08' })] });

    expect(screen.getByText('All day – Sep 7, 2026')).toBeInTheDocument();
  });

  it('shows when an event that started the night before ends, not its start', () => {
    renderPanel({
      selectedDate: dayjs('2026-09-06'),
      selectedDayEvents: [event({
        start: dayjs('2026-09-05T23:30').toISOString(),
        end: dayjs('2026-09-06T01:00').toISOString(),
      })],
    });

    expect(screen.getByText('until 1:00 AM')).toBeInTheDocument();
    expect(screen.queryByText(/11:30 PM/)).not.toBeInTheDocument();
  });
});

// A create form closed without saving used to keep everything it held, and
// only re-seeded its date when the calendar selection changed. Reopening on the
// same day brought back the abandoned draft and its old date.
describe('a task with an end on the day agenda', () => {
  it('shows the span on the card and in its details', () => {
    const due = dayjs('2026-09-05T13:00');
    const end = dayjs('2026-09-05T15:30');
    renderPanel({ selectedDayTasks: [task({
      allDay: false,
      dueDate: due.toISOString(),
      dueDateLocalInput: '2026-09-05T13:00',
      endsAt: end.toISOString(),
    })] });

    expect(screen.getByText('1:00 PM – 3:30 PM')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Draft motion'));
    expect(within(screen.getByRole('dialog', { name: 'Task details' })).getByText(/Sat, Sep 5, 2026 · 1:00 PM – 3:30 PM/))
      .toBeInTheDocument();
  });
});

describe('the create forms open fresh', () => {
  const pickDay = (trigger: HTMLElement, day: number) => {
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: String(day) }));
  };

  it('drops an abandoned New Event draft and reopens on the selected day', () => {
    renderPanel({ onEventCreate: jest.fn(), initialDueDate: '2026-09-05T09:00' });
    fireEvent.click(screen.getByRole('button', { name: /Create New Event/ }));
    fireEvent.change(screen.getByPlaceholderText('Event title'), { target: { value: 'Draft hearing' } });
    pickDay(screen.getByRole('button', { name: /^Start \*/ }), 12);
    expect(screen.getByRole('button', { name: /^Start \* Sep 12, 2026/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: /Create New Event/ }));

    expect(screen.getByPlaceholderText('Event title')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^Start \* Sep 5, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start time' })).toHaveTextContent('9:00 AM');
  });

  it('opens New Event on a slot selected after the form was last closed', () => {
    const { rerender } = renderPanel({ onEventCreate: jest.fn(), initialDueDate: '2026-09-05T09:00' });
    fireEvent.click(screen.getByRole('button', { name: /Create New Event/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    rerender(panel({ onEventCreate: jest.fn(), initialDueDate: '2026-09-18T14:00' }));
    fireEvent.click(screen.getByRole('button', { name: /Create New Event/ }));

    expect(screen.getByRole('button', { name: /^Start \* Sep 18, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start time' })).toHaveTextContent('2:00 PM');
  });

  it('drops an abandoned New Task draft and reopens due on the selected day', () => {
    renderPanel({ initialDueDate: '2026-09-05T09:00' });
    fireEvent.click(screen.getByRole('button', { name: /Create New Task/ }));
    fireEvent.change(screen.getByPlaceholderText('Enter task title'), { target: { value: 'Draft motion' } });
    pickDay(screen.getByRole('button', { name: /^Due (?!time)/ }), 12);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: /Create New Task/ }));

    expect(screen.getByPlaceholderText('Enter task title')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^Due Sep 5, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Due time' })).toHaveTextContent('9:00 AM');
  });
});

describe('empty calendar notes from older syncs', () => {
  it.each(['()', ' (  ) ', '(\n)'])('hides %j in both the event card and its details', (notes) => {
    renderPanel({ selectedDayEvents: [event({ notes })] });
    expect(screen.getByText('Client meeting')).toBeInTheDocument();
    expect(screen.queryByText(/^\(\s*\)$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Client meeting'));
    const dialog = within(screen.getByRole('dialog', { name: 'Event details' }));
    expect(dialog.getByText('Client meeting')).toBeInTheDocument();
    expect(dialog.queryByText('Notes')).not.toBeInTheDocument();
  });

  it('hides empty parentheses in a synced task description', () => {
    renderPanel({ selectedDayTasks: [task({ description: '()' })] });
    expect(screen.getByText('Draft motion')).toBeInTheDocument();
    expect(screen.queryByText('()')).not.toBeInTheDocument();
  });

  it('keeps parentheses within real notes', () => {
    renderPanel({ selectedDayEvents: [event({ notes: 'Bring exhibits (A, B). Leave () blank.' })] });
    fireEvent.click(screen.getByText('Client meeting'));
    expect(within(screen.getByRole('dialog', { name: 'Event details' }))
      .getByText('Bring exhibits (A, B). Leave () blank.')).toBeInTheDocument();
  });
});
