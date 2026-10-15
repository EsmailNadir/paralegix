/**
 * The matter Events tab, driven through the REAL matter-events service.
 *
 * `tests/setup.ts` replaces `matterEvents.service` with a Proxy whose every
 * method resolves `{}`. Rendering this tab under that default proves nothing:
 * the list is empty because the mock said so, and no assertion about a date, an
 * order or a payload can fail. Unmocking the service puts url building, query
 * parameters, the auth header, response parsing and `ApiError` back in the path,
 * and `installApiMock` fakes only the transport underneath it. An unmatched
 * request throws and names itself, so a read this file did not anticipate is
 * loud rather than silently empty.
 *
 * THE DATE CASES ARE THE POINT. A matter event carries a court date, and the
 * failure this app has actually shipped is an all-day event drawn one day early:
 * an instant at midnight UTC is the previous evening anywhere west of Greenwich,
 * so the browser renders the day before the one the firm typed. The events are
 * anchored at NOON UTC for exactly that reason, and the server sends a
 * `dateLocalDisplay` string already resolved in the firm's zone. These tests run
 * with the process timezone pinned west of Greenwich so that risk is live rather
 * than theoretical.
 *
 * What the tab re-reads after a change is counted at the transport too. Every
 * create, edit, complete, cancel, postpone and delete used to run a five-way
 * `Promise.all` of `refetch()` calls: the shared list, all three status
 * sections and the dependency graph. `refetch()` ignores a query's `enabled`
 * flag, so the sections the viewer had filtered OUT of view were re-read as
 * eagerly as the one they were looking at: five simultaneous requests from one
 * click, against an API instance holding twelve Postgres pool connections. One
 * `invalidateQueries` on the shared key prefix refetches what is mounted and
 * marks the rest stale, the same visible result for a fraction of the
 * connections.
 */
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');
jest.unmock('@/services/files.service');

const mockNavigate = jest.fn();

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

// The time entry form is covered on its own. This stub reports a save-and-bill
// result when open, which is all the redirect cases below need from it.
jest.mock('@/components/billingComp/TimeEntryModal', () => ({
  __esModule: true,
  default: ({ open, onSuccess }: { open: boolean; onSuccess?: (result: unknown) => void }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSuccess?.({ shouldBillNow: true, draftItem: { timeEntryId: 'te-1', matterId: 'matter-1' } })
        }
      >
        Stub save and bill
      </button>
    ) : null,
}));

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import MatterEventsTab from '@/components/matterComp/MatterEventsTab';
import type { MatterEvent, MatterEventStatus } from '@/types/matterEvent';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';

// Node re-reads TZ on assignment, so this genuinely moves the formatting the
// component does. Pinned rather than inherited: on a machine already running in
// UTC every day-shift assertion below would pass no matter what the component
// did with the instant.
const ORIGINAL_TZ = process.env.TZ;

function setTimezone(tz: string): void {
  process.env.TZ = tz;
}

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function makeEvent(overrides: Partial<MatterEvent> & { id: string; title: string }): MatterEvent {
  return {
    type: 'court_date',
    date: '2026-03-15T12:00:00.000Z',
    status: 'upcoming',
    matterId: MATTER_ID,
    lawFirmId: LAW_FIRM_ID,
    createdBy: 'test-uid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Wire up every read the tab makes on mount.
 *
 * The tab issues four GETs against the same `/events` path: one unpaged list
 * (no `status` parameter) that it publishes to the parent, plus one page per
 * status section. They are told apart by the query string, which is also what
 * proves the sections ask the SERVER for their rows rather than filtering one
 * download in the browser.
 */
function stubEventReads(
  api: ApiMock,
  sections: Partial<Record<MatterEventStatus, MatterEvent[]>>,
  options: { unpaged?: { status: number; body?: unknown } } = {},
) {
  api.get('/events/graph', { events: [] });
  api.get('/users', []);
  api.get('/contacts/lookup', { contacts: [] });
  api.get('/events', (call: RecordedCall) => {
    const status = new URL(call.url, 'http://localhost').searchParams.get('status');
    if (!status) {
      if (options.unpaged) return options.unpaged;
      const all = Object.values(sections).flat();
      return { events: all, totalEvents: all.length };
    }
    const rows = sections[status as MatterEventStatus] ?? [];
    return { events: rows, totalEvents: rows.length };
  });
}

let api: ApiMock;

beforeEach(() => {
  setTimezone('America/Los_Angeles');
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('the day an event is drawn on', () => {
  it('shows the day the firm entered for an all-day event, and would show the day before if it were anchored at midnight', async () => {
    // Both events are the same calendar day as far as the firm is concerned.
    // The first is stored the way this app stores an all-day event, at noon UTC;
    // the second is the mistake that anchoring exists to prevent. Neither
    // carries `dateLocalDisplay`, so the component formats the instant itself,
    // which is the code path where the day slips.
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-noon', title: 'Anchored at noon', allDay: true, date: '2026-03-15T12:00:00.000Z', dateLocalDisplay: null }),
        makeEvent({ id: 'ev-midnight', title: 'Anchored at midnight', allDay: true, date: '2026-03-15T00:00:00.000Z', dateLocalDisplay: null }),
      ],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    // Both rows are on screen before any date is read off them, so the dates
    // below are the component's output rather than an empty list.
    await screen.findByText('Anchored at noon');
    expect(screen.getByText('Anchored at midnight')).toBeInTheDocument();

    // The noon-anchored event reads as March 15 in Los Angeles.
    expect(screen.getAllByText(/^3\/15\/2026/)).toHaveLength(1);
    // And the midnight-anchored one reads as March 14, which is both the bug
    // this anchoring prevents and the proof that the timezone override above
    // actually took effect. If this line ever reads 3/15 the test is running in
    // UTC and the assertion above has stopped meaning anything.
    expect(screen.getAllByText(/^3\/14\/2026/)).toHaveLength(1);
  });

  it('prefers the server-resolved local day over re-deriving it from the instant', async () => {
    // The firm works in Los Angeles; the instant falls on the 16th in UTC. The
    // server already resolved the day in the firm's zone, so that string is what
    // the reader must see. Re-deriving it in the browser puts a hearing on the
    // wrong date for anyone whose machine is set to a different zone from the
    // firm's.
    setTimezone('UTC');
    stubEventReads(api, {
      upcoming: [
        makeEvent({
          id: 'ev-1',
          title: 'Motion to Dismiss Hearing',
          date: '2026-03-16T02:00:00.000Z',
          dateLocalDisplay: 'Mar 15, 2026, 6:00 PM',
        }),
      ],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Motion to Dismiss Hearing');
    expect(screen.getByText('Mar 15, 2026, 6:00 PM')).toBeInTheDocument();
    // The browser's own reading of the same instant is March 16. Seeing it here
    // would mean the server's resolution was discarded.
    expect(screen.queryByText(/3\/16\/2026/)).not.toBeInTheDocument();
  });
});

describe('the order events are listed in', () => {
  it('draws each section in the order the server returned it', async () => {
    // The sections are server pages. Re-sorting them here would reorder only the
    // rows already downloaded, so page 2 of a matter would be sorted against
    // itself and read as though it belonged before page 1.
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-1', title: 'Filing deadline', dateLocalDisplay: 'Mar 2, 2026' }),
        makeEvent({ id: 'ev-2', title: 'Deposition', dateLocalDisplay: 'Mar 9, 2026' }),
        makeEvent({ id: 'ev-3', title: 'Trial', dateLocalDisplay: 'Mar 16, 2026' }),
      ],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Filing deadline');
    const titles = screen.getAllByText(/^(Filing deadline|Deposition|Trial)$/).map((n) => n.textContent);
    expect(titles).toEqual(['Filing deadline', 'Deposition', 'Trial']);
  });

  it('puts upcoming events above completed ones and completed above cancelled', async () => {
    stubEventReads(api, {
      upcoming: [makeEvent({ id: 'ev-1', title: 'Pretrial conference', dateLocalDisplay: 'Mar 2, 2026' })],
      completed: [makeEvent({ id: 'ev-2', title: 'Answer filed', status: 'completed', dateLocalDisplay: 'Feb 2, 2026' })],
      cancelled: [makeEvent({ id: 'ev-3', title: 'Settlement conference', status: 'cancelled', dateLocalDisplay: 'Feb 9, 2026' })],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Pretrial conference');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Upcoming', 'Completed', 'Cancelled']);

    // The headings alone would still pass if a section were rendering the wrong
    // rows, so check each event sits under its own.
    expect(screen.getByText('Answer filed')).toBeInTheDocument();
    expect(screen.getByText('Settlement conference')).toBeInTheDocument();
  });
});

describe('adding an event', () => {
  it('sends the optional client description separately from internal notes', async () => {
    const user = userEvent.setup();
    // The 15th of the month now showing. A day cell's only text is its number,
    // and a six-week grid can only spill into the next month as far as the 14th,
    // so "15" is unambiguous within the open calendar.
    const targetDay = `${dayjs().format('YYYY-MM')}-15`;

    const created = makeEvent({
      id: 'ev-new',
      title: 'Status conference',
      allDay: true,
      dateLocalDisplay: dayjs(targetDay).format('MMM D, YYYY'),
    });
    let saved = false;
    stubEventReads(api, { get upcoming() { return saved ? [created] : []; } } as never);
    api.post('/events', () => {
      saved = true;
      return { status: 201, body: { message: 'ok', eventId: 'ev-new', event: created } };
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText(/No events yet/i);
    await user.click(screen.getByRole('button', { name: /Add Event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Add Matter Event/i });
    await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Status conference');
    await user.type(within(dialog).getByLabelText('Notes'), 'Internal strategy');
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: /Select date/i }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '15' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const visibility = within(dialog).getByRole('checkbox', { name: 'Visible to client portal' });
    expect(visibility).not.toBeChecked();
    await user.click(visibility);
    await user.type(within(dialog).getByLabelText('Client-facing description'), 'Bring identification');
    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.notes).toBe('Internal strategy');
    expect(body.clientDescription).toBe('Bring identification');
    expect(body.clientVisible).toBe(true);
    expect(body.title).toBe('Status conference');
    expect(body.allDay).toBe(true);
    // A local wall clock string, NOT an instant. Converting it here would hand
    // the server midnight UTC, which is the previous day for this firm, and the
    // event would come back drawn a day early.
    expect(body.date).toBe(`${targetDay}T00:00`);

    // And the reader sees the event, not just a request that left the browser.
    expect(await screen.findByText('Status conference')).toBeInTheDocument();
  });

  it('keeps a new event off the client portal, with no client description, unless sharing is turned on', async () => {
    const user = userEvent.setup();
    const targetDay = `${dayjs().format('YYYY-MM')}-15`;
    stubEventReads(api, {});
    api.post('/events', {
      status: 201,
      body: { message: 'ok', eventId: 'ev-new', event: makeEvent({ id: 'ev-new', title: 'Private review' }) },
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText(/No events yet/i);
    await user.click(screen.getByRole('button', { name: /Add Event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add Matter Event/i });
    await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Private review');
    await user.type(within(dialog).getByLabelText('Notes'), 'Internal strategy');
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: /Select date/i }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '15' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(within(dialog).getByRole('checkbox', { name: 'Visible to client portal' })).not.toBeChecked();
    expect(within(dialog).queryByLabelText('Client-facing description')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.date).toBe(`${targetDay}T00:00`);
    expect(body.notes).toBe('Internal strategy');
    expect(body.clientVisible).toBe(false);
    expect(body).not.toHaveProperty('clientDescription');
  });

  it('sends an all-day date as a local wall clock time and the list then shows it', async () => {
    const user = userEvent.setup();
    // The 15th of the month now showing. A day cell's only text is its number,
    // and a six-week grid can only spill into the next month as far as the 14th,
    // so "15" is unambiguous within the open calendar.
    const targetDay = `${dayjs().format('YYYY-MM')}-15`;

    const created = makeEvent({
      id: 'ev-new',
      title: 'Status conference',
      allDay: true,
      dateLocalDisplay: dayjs(targetDay).format('MMM D, YYYY'),
    });
    let saved = false;
    stubEventReads(api, { get upcoming() { return saved ? [created] : []; } } as never);
    api.post('/events', () => {
      saved = true;
      return { status: 201, body: { message: 'ok', eventId: 'ev-new', event: created } };
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText(/No events yet/i);
    await user.click(screen.getByRole('button', { name: /Add Event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Add Matter Event/i });
    await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Status conference');
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: /Select date/i }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '15' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.title).toBe('Status conference');
    expect(body.allDay).toBe(true);
    // A local wall clock string, NOT an instant. Converting it here would hand
    // the server midnight UTC, which is the previous day for this firm, and the
    // event would come back drawn a day early.
    expect(body.date).toBe(`${targetDay}T00:00`);

    // And the reader sees the event, not just a request that left the browser.
    expect(await screen.findByText('Status conference')).toBeInTheDocument();
  });

  it('withholds save until the event has both a title and a date', async () => {
    // An event with no date is a deadline nobody can be warned about, and an
    // untitled one is a row in the list that says nothing. The form refuses both
    // by keeping the button unavailable rather than by failing after the click,
    // so the reader can see the requirement before spending the attempt.
    const user = userEvent.setup();
    stubEventReads(api, {});

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText(/No events yet/i);
    await user.click(screen.getByRole('button', { name: /Add Event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add Matter Event/i });
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });

    expect(continueButton).toBeDisabled();

    await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Status conference');
    // A title alone is not enough; the date is still missing.
    expect(continueButton).toBeDisabled();

    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: /Select date/i }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '15' }));

    await waitFor(() => expect(continueButton).toBeEnabled());
    // Nothing was sent while the form was incomplete.
    expect(api.calls('POST')).toHaveLength(0);
  });
});

describe('editing an event', () => {
  it('does not expose create-only recurrence controls during the edit dialog exit animation', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {
      upcoming: [makeEvent({ id: 'ev-1', title: 'Hearing', dateLocalInput: '2026-03-15T10:00' })],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Hearing');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    expect(within(dialog).queryByText('Repeat')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // The parent has already cleared the record, but Modal keeps the dialog in
    // the DOM for its exit animation. It must remain an edit form throughout.
    expect(within(screen.getByRole('dialog', { name: /Edit Event/i })).queryByText('Repeat')).not.toBeInTheDocument();
  });

  it('PUTs the changed title to the event and the list then shows it', async () => {
    const user = userEvent.setup();
    const original = makeEvent({
      id: 'ev-1',
      title: 'Hearing',
      allDay: true,
      dateLocalInput: '2026-03-15T00:00',
      dateLocalDisplay: 'Mar 15, 2026',
    });
    const renamed = { ...original, title: 'Hearing (rescheduled)' };
    let updated = false;
    stubEventReads(api, { get upcoming() { return [updated ? renamed : original]; } } as never);
    api.put('/events/ev-1', () => {
      updated = true;
      return { message: 'ok', event: renamed };
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Hearing');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    const titleField = within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i);
    await user.clear(titleField);
    await user.type(titleField, 'Hearing (rescheduled)');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/events\/ev-1$/);
    const body = call.body as Record<string, unknown>;
    expect(body.title).toBe('Hearing (rescheduled)');
    // An all-day event stays all-day through an edit. A title edit sends
    // neither the flag nor the date, so the server keeps both as stored.
    expect(body).not.toHaveProperty('allDay');
    expect(body).not.toHaveProperty('date');

    expect(await screen.findByText('Hearing (rescheduled)')).toBeInTheDocument();
  });

  it('opens the edit form on the day the firm entered, not on today', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {
      upcoming: [
        makeEvent({
          id: 'ev-1',
          title: 'Hearing',
          allDay: true,
          dateLocalInput: '2026-03-15T00:00',
          dateLocalDisplay: 'Mar 15, 2026',
        }),
      ],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText('Hearing');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    // The all-day toggle is on, so the field is the date-only picker, and its
    // trigger reads the stored day back.
    expect(within(dialog).getByRole('switch', { name: 'All day' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('button', { name: /Mar 15, 2026/ })).toBeInTheDocument();
  });
});

/**
 * An event's optional end. An all-day end is stored as the EXCLUSIVE day after
 * the last day, the way Google and Outlook take it, while the form asks for the
 * last day itself. A conversion missing on either side moves a multi-day event
 * by a day on every calendar it syncs to, and nothing on this screen would look
 * wrong. Days 16 to 22 are used because the open month grid cannot spill into
 * them from either neighbouring month, so each day label is unambiguous.
 */
describe('the end of an event', () => {
  const thisMonth = (day: number) => `${dayjs().format('YYYY-MM')}-${String(day).padStart(2, '0')}`;

  async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText(/No events yet/i);
    await user.click(screen.getByRole('button', { name: /Add Event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add Matter Event/i });
    await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Trial');
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    return dialog;
  }

  async function pickDay(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, day: number) {
    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: String(day) }));
  }

  it('sends an all-day last day as the exclusive day after it', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {});
    api.post('/events', () => ({ status: 201, body: { message: 'ok', eventId: 'ev-new', event: makeEvent({ id: 'ev-new', title: 'Trial' }) } }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openAddForm(user);
    await pickDay(user, within(dialog).getByRole('button', { name: /Select date/i }), 18);
    await pickDay(user, within(dialog).getByRole('button', { name: /^End (?!time)/ }), 20);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.date).toBe(`${thisMonth(18)}T00:00`);
    // The 18th through the 20th: the server stores the 21st.
    expect(body.endsAt).toBe(thisMonth(21));
  });

  it('sends no end at all when none was picked', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {});
    api.post('/events', () => ({ status: 201, body: { message: 'ok', eventId: 'ev-new', event: makeEvent({ id: 'ev-new', title: 'Trial' }) } }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openAddForm(user);
    await pickDay(user, within(dialog).getByRole('button', { name: /Select date/i }), 18);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).not.toHaveProperty('endsAt');
  });

  it('withholds Continue while the last day is before the first, and says why', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {});

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openAddForm(user);
    await pickDay(user, within(dialog).getByRole('button', { name: /Select date/i }), 20);
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(continueButton).toBeEnabled());

    await pickDay(user, within(dialog).getByRole('button', { name: /^End (?!time)/ }), 16);

    expect(continueButton).toBeDisabled();
    expect(within(dialog).getByText('The last day cannot be before the first day.')).toBeInTheDocument();
  });

  it('opens an edit on the last day and saves the same exclusive end back unchanged', async () => {
    const user = userEvent.setup();
    const trial = makeEvent({
      id: 'ev-1',
      title: 'Trial',
      allDay: true,
      date: '2026-03-16T12:00:00.000Z',
      endsAt: '2026-03-19T12:00:00.000Z',
      dateLocalInput: '2026-03-16T00:00',
      dateLocalDisplay: 'Mar 16, 2026',
      endsAtLocalDisplay: 'Mar 19, 2026',
    });
    stubEventReads(api, { upcoming: [trial] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: trial }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    // The list shows the days the event covers, the 16th to the 18th.
    expect(await screen.findByText(/Mon, Mar 16, 2026 – Wed, Mar 18, 2026 · All day/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    expect(within(dialog).getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent('Mar 18, 2026');

    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    // Read back as the 18th and left unsent: the round trip moves nothing.
    expect(api.calls('PUT')[0].body).not.toHaveProperty('endsAt');
  });

  // The form may have opened from a cached list older than a change made in
  // Google and polled in since; resending its schedule would undo that change.
  it('sends no date, end or all-day flag when only the title changes', async () => {
    const user = userEvent.setup();
    const trial = makeEvent({
      id: 'ev-1', title: 'Trial', allDay: true,
      date: '2026-03-16T12:00:00.000Z', endsAt: '2026-03-19T12:00:00.000Z',
      dateLocalInput: '2026-03-16T00:00', dateLocalDisplay: 'Mar 16, 2026', endsAtLocalDisplay: 'Mar 19, 2026',
    });
    stubEventReads(api, { upcoming: [trial] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: trial }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Trial');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    const titleField = dialog.querySelector('input[id$="-title"]') as HTMLInputElement;
    await user.clear(titleField);
    await user.type(titleField, 'Jury trial');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.title).toBe('Jury trial');
    expect(body).not.toHaveProperty('date');
    expect(body).not.toHaveProperty('endsAt');
    expect(body).not.toHaveProperty('allDay');
  });

  // The server carries the stored end along with a moved start, keeping a
  // length the form's cached copy may not know about.
  it('sends the moved start without the end that only followed it', async () => {
    const user = userEvent.setup();
    const trial = makeEvent({
      id: 'ev-1', title: 'Trial', allDay: true,
      date: '2026-03-16T12:00:00.000Z', endsAt: '2026-03-19T12:00:00.000Z',
      dateLocalInput: '2026-03-16T00:00', dateLocalDisplay: 'Mar 16, 2026', endsAtLocalDisplay: 'Mar 19, 2026',
    });
    stubEventReads(api, { upcoming: [trial] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: trial }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Trial');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    await pickDay(user, within(dialog).getByRole('button', { name: /^Start/ }), 20);
    expect(within(dialog).getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent('Mar 22, 2026');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.date).toBe('2026-03-20T00:00');
    expect(body).not.toHaveProperty('endsAt');
  });

  it('removes the end on save when it was cleared', async () => {
    const user = userEvent.setup();
    const hearing = makeEvent({
      id: 'ev-1',
      title: 'Hearing',
      allDay: true,
      date: '2026-03-16T12:00:00.000Z',
      endsAt: '2026-03-18T12:00:00.000Z',
      dateLocalInput: '2026-03-16T00:00',
      dateLocalDisplay: 'Mar 16, 2026',
    });
    stubEventReads(api, { upcoming: [hearing] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: hearing }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Hearing');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });

    await user.click(within(dialog).getByRole('button', { name: /^End (?!time)/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    // Null, not absent: an absent end leaves the stored one in place.
    expect((api.calls('PUT')[0].body as Record<string, unknown>).endsAt).toBeNull();
  });
});

describe('postponing an event', () => {
  async function openPostpone(user: ReturnType<typeof userEvent.setup>, title: string) {
    await screen.findByText(title);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Postpone event/i }));
    return screen.findByRole('dialog', { name: /Postpone Event/i });
  }

  it('offers only a day for an all-day event, and sends the day picked', async () => {
    const user = userEvent.setup();
    const hearing = makeEvent({
      id: 'ev-1', title: 'Status conference', allDay: true,
      dateLocalInput: '2026-03-16T00:00', dateLocalDisplay: 'Mar 16, 2026',
    });
    stubEventReads(api, { upcoming: [hearing] });
    api.post('/events/ev-1/postpone', () => ({ message: 'ok', event: hearing }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openPostpone(user, 'Status conference');

    expect(within(dialog).queryByRole('button', { name: 'New start time' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^New start \*/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
    await user.click(within(dialog).getByRole('button', { name: 'Postpone' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect((api.calls('POST')[0].body as Record<string, unknown>).newDate).toBe('2026-03-20T00:00');
  });

  it('keeps the time of a timed event when only its day changes, and says the end moves with it', async () => {
    const user = userEvent.setup();
    const hearing = makeEvent({
      id: 'ev-1', title: 'Motion hearing', allDay: false,
      date: '2026-03-16T17:00:00.000Z', endsAt: '2026-03-16T19:00:00.000Z',
      dateLocalInput: '2026-03-16T10:00', dateLocalDisplay: 'Mar 16, 2026, 10:00 AM',
    });
    stubEventReads(api, { upcoming: [hearing] });
    api.post('/events/ev-1/postpone', () => ({ message: 'ok', event: hearing }));

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openPostpone(user, 'Motion hearing');

    expect(within(dialog).getByText(/end moves with it/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^New start \*/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
    await user.click(within(dialog).getByRole('button', { name: 'Postpone' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect((api.calls('POST')[0].body as Record<string, unknown>).newDate).toBe('2026-03-20T10:00');
  });
});

describe('closing the cancel and postpone dialogs while the request is in flight', () => {
  // The tab owns each dialog's open flag, so a close shows as the dialog
  // unmounting once its 100ms exit animation finishes. Each spec waits past it.
  const pastExitAnimation = () =>
    act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

  async function openFromMenu(user: ReturnType<typeof userEvent.setup>, title: string, item: RegExp, dialogName: RegExp) {
    await screen.findByText(title);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
    return screen.findByRole('dialog', { name: dialogName });
  }

  // Red if: the Postpone dialog stays dismissible during the request (no
  // `dismissible={!submitting}`) or its Cancel stays enabled, so Escape closes
  // it mid-save and a later failure renders into a closed dialog.
  it('keeps the postpone dialog open until the postpone settles', async () => {
    const user = userEvent.setup();
    const hearing = makeEvent({
      id: 'ev-1', title: 'Motion hearing', allDay: false,
      date: '2026-03-16T17:00:00.000Z',
      dateLocalInput: '2026-03-16T10:00', dateLocalDisplay: 'Mar 16, 2026, 10:00 AM',
    });
    stubEventReads(api, { upcoming: [hearing] });
    const post = holdResponse();
    api.post('/events/ev-1/postpone', post.handler);

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openFromMenu(user, 'Motion hearing', /Postpone event/i, /Postpone Event/i);
    await user.click(within(dialog).getByRole('button', { name: 'Postpone' }));
    await post.untilRequested();

    fireEvent.keyDown(document, { key: 'Escape' });
    await pastExitAnimation();
    expect(screen.getByRole('dialog', { name: /Postpone Event/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ message: 'ok', event: hearing }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Postpone Event/i })).not.toBeInTheDocument());
  });

  // Red if: the Cancel Event dialog stays dismissible during the request (no
  // `dismissible={!submitting}`) or Keep Event stays enabled, so Escape closes
  // it mid-save and a later failure renders into a closed dialog.
  it('keeps the cancel dialog open until the cancellation settles', async () => {
    const user = userEvent.setup();
    const hearing = makeEvent({ id: 'ev-1', title: 'Motion hearing' });
    stubEventReads(api, { upcoming: [hearing] });
    const post = holdResponse();
    api.post('/events/ev-1/cancel', post.handler);

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    const dialog = await openFromMenu(user, 'Motion hearing', /Cancel event/i, /Cancel Event/i);
    await user.type(within(dialog).getByLabelText(/Reason/), 'Court closed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Event' }));
    await post.untilRequested();

    fireEvent.keyDown(document, { key: 'Escape' });
    await pastExitAnimation();
    expect(screen.getByRole('dialog', { name: /Cancel Event/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep Event' })).toBeDisabled();

    await act(async () => post.release({ message: 'ok', event: { ...hearing, status: 'cancelled' } }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Cancel Event/i })).not.toBeInTheDocument());
  });
});

describe('a linked file on an event', () => {
  it('opens the shared preview modal instead of a new tab', async () => {
    const user = userEvent.setup();
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    stubEventReads(api, {
      upcoming: [
        makeEvent({
          id: 'ev-1',
          title: 'Strategy meeting',
          dateLocalDisplay: 'Mar 15, 2026',
          linkedFiles: [
            {
              fileId: 'file-1',
              name: 'photo.png',
              size: 1024,
              contentType: 'image/png',
              scope: 'matter',
              linkedBy: 'test-uid',
              linkedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      ],
    });
    api.get('/refresh-url', { signedUrl: 'https://example.test/photo.png' });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await user.click(await screen.findByRole('button', { name: 'photo.png' }));

    // The shared FilePreviewModal renders a Download button once open; a new
    // tab would show neither this nor any DOM change in the page at all.
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});

describe('which rows open a details panel', () => {
  /** The disclosure panel a row controls, or null when the row has none. */
  const detailsPanel = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`#event-details-${id}`);

  it('gives a row with no contacts a panel for its notes or its cancellation reason, and none to a bare row', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-notes', title: 'Prep session', contacts: [], notes: 'Bring the exhibit binder' }),
        makeEvent({ id: 'ev-bare', title: 'Status call', contacts: [] }),
      ],
      cancelled: [
        makeEvent({ id: 'ev-cancel', title: 'Site visit', status: 'cancelled', contacts: [], cancellationReason: 'Court closed' }),
      ],
    });

    const { container } = renderWithProviders(
      <MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />,
    );
    await screen.findByText('Site visit');

    expect(detailsPanel(container, 'ev-notes')).toHaveTextContent('Bring the exhibit binder');
    expect(detailsPanel(container, 'ev-cancel')).toHaveTextContent('Reason: Court closed');
    expect(detailsPanel(container, 'ev-bare')).toBeNull();
  });
});

describe('while loading, and when a read fails', () => {
  it('draws the list skeleton until the first page arrives', async () => {
    stubEventReads(api, { upcoming: [makeEvent({ id: 'ev-1', title: 'Trial', dateLocalDisplay: 'Mar 16, 2026' })] });
    // Re-registered so the paged reads land after the assertion below.
    api.get('/events', (call: RecordedCall) => {
      const status = new URL(call.url, 'http://localhost').searchParams.get('status');
      const rows = status === 'upcoming' ? [makeEvent({ id: 'ev-1', title: 'Trial', dateLocalDisplay: 'Mar 16, 2026' })] : [];
      return { delayMs: 40, body: { events: rows, totalEvents: rows.length } };
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    expect(await screen.findByRole('status', { name: 'Loading events' })).toBeInTheDocument();
    // "No events yet" during the wait would tell a reader the matter has no
    // court dates, which is a different and much worse statement than "loading".
    expect(screen.queryByText(/No events yet/i)).not.toBeInTheDocument();

    expect(await screen.findByText('Trial')).toBeInTheDocument();
  });

  it('tells the reader when the events read failed instead of reporting an empty matter', async () => {
    stubEventReads(api, {}, { unpaged: { status: 500, body: { error: 'Events are unavailable right now' } } });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Events are unavailable right now/i);
  });
});

describe('picker data for the closed modals', () => {
  it('loads no firm users until the add-event modal opens', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {});
    const usersPath = `/users/lawfirm/${LAW_FIRM_ID}/users`;

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await screen.findByText(/No events yet/i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo(usersPath)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Add Event/i }));
    await screen.findByRole('dialog', { name: /Add Matter Event/i });

    await waitFor(() => expect(api.callsTo(usersPath)).toHaveLength(1));
  });
});

describe('completing an event that is still blocked', () => {
  it('keeps the unresolved dependencies listed while the review dialog animates closed', async () => {
    const user = userEvent.setup();
    const dependency = makeEvent({ id: 'ev-dep', title: 'Discovery cutoff', dependsOn: [] });
    const blocked = makeEvent({ id: 'ev-blocked', title: 'Filing deadline', dependsOn: ['ev-dep'] });
    stubEventReads(api, { upcoming: [dependency, blocked] });
    // Registered after `stubEventReads` so it replaces that helper's empty graph:
    // blocking is resolved against the graph, not the list rows.
    api.get('/events/graph', {
      events: [dependency, blocked].map(({ id, type, title, status, date, dependsOn }) => ({
        id, type, title, status, date, dateLocalDisplay: null, dependsOn: dependsOn ?? [],
      })),
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await user.click(
      await screen.findByRole('button', { name: 'Mark as completed with unresolved dependencies' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Complete Blocked Event?' });
    expect(within(dialog).getByText('Discovery cutoff')).toBeInTheDocument();

    // Cancel clears the event under review, which is what fed the list.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(dialog).toHaveClass('overlay-card-exit');
    expect(within(dialog).getByText('Discovery cutoff')).toBeInTheDocument();
  });

  // The same review opens from inside the event form, so it is a stacked
  // dialog: raised above z-50 and portalled out of the tab's DOM.
  it('opens the review as a stacked dialog', async () => {
    const user = userEvent.setup();
    const dependency = makeEvent({ id: 'ev-dep', title: 'Discovery cutoff', dependsOn: [] });
    const blocked = makeEvent({ id: 'ev-blocked', title: 'Filing deadline', dependsOn: ['ev-dep'] });
    stubEventReads(api, { upcoming: [dependency, blocked] });
    api.get('/events/graph', {
      events: [dependency, blocked].map(({ id, type, title, status, date, dependsOn }) => ({
        id, type, title, status, date, dateLocalDisplay: null, dependsOn: dependsOn ?? [],
      })),
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    await user.click(
      await screen.findByRole('button', { name: 'Mark as completed with unresolved dependencies' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Complete Blocked Event?' });
    const overlay = dialog.parentElement?.parentElement as HTMLElement;
    expect(overlay).toHaveClass('z-[60]');
    expect(overlay.parentElement).toBe(document.body);
  });
});

describe('re-reading after a change', () => {
  /** Server-side truth the fake routes read, so a mutation actually changes it. */
  let events: MatterEvent[];

  /** The status section a recorded read belongs to, or undefined for the shared list. */
  const sectionOf = (call: RecordedCall) => call.query.status?.[0];

  const eventReads = (calls: RecordedCall[]) =>
    calls.filter((call) => call.method === 'GET' && call.pathname.endsWith(`/matters/${MATTER_ID}/events`));

  beforeEach(() => {
    events = [
      makeEvent({ id: 'evt-upcoming', title: 'Preliminary Hearing' }),
      makeEvent({ id: 'evt-completed', title: 'Closing Argument', status: 'completed' }),
      makeEvent({ id: 'evt-cancelled', title: 'Vacated Status Conference', status: 'cancelled' }),
    ];
    api.get(`/matters/${MATTER_ID}/events/graph`, () => ({
      events: events.map(({ id, title, status, date, dependsOn }) => ({ id, title, status, date, dependsOn })),
    }));
    api.get(`/matters/${MATTER_ID}/events`, (call) => {
      const status = sectionOf(call) as MatterEventStatus | undefined;
      const rows = status ? events.filter((e) => e.status === status) : events;
      return { events: rows, totalEvents: rows.length };
    });
    api.put(`/matters/${MATTER_ID}/events/evt-upcoming`, (call) => {
      const patch = call.body as { status?: MatterEventStatus };
      events = events.map((e) => (e.id === 'evt-upcoming' ? { ...e, status: patch.status ?? e.status } : e));
      return { message: 'ok', event: events.find((e) => e.id === 'evt-upcoming') };
    });
  });

  it('re-reads only the sections on screen, never the ones the viewer filtered out', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    expect(await screen.findByText('Preliminary Hearing')).toBeInTheDocument();
    // Narrow the tab to one section, so two of the three pagers are disabled.
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    await waitFor(() => expect(screen.queryByText('Closing Argument')).not.toBeInTheDocument());

    const before = api.calls().length;
    await user.click(screen.getByRole('button', { name: 'Mark as completed' }));

    // The event left the Upcoming section, which is the whole visible result of
    // the change.
    await waitFor(() => expect(screen.queryByText('Preliminary Hearing')).not.toBeInTheDocument());

    const after = api.calls().slice(before);
    // The shared list, the one mounted section, and the dependency graph. The
    // five-way refetch added the completed and cancelled sections on top,
    // although neither is rendered.
    expect(eventReads(after).filter((call) => sectionOf(call) === 'completed')).toHaveLength(0);
    expect(eventReads(after).filter((call) => sectionOf(call) === 'cancelled')).toHaveLength(0);
    expect(after.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  it('still shows the change in every section that IS on screen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);

    expect(await screen.findByText('Preliminary Hearing')).toBeInTheDocument();
    expect(screen.getByText('Closing Argument')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark as completed' }));

    // With no filter applied, the completed section is mounted, so it must pick
    // the event up rather than merely being marked stale behind the scenes.
    await waitFor(() => {
      const completedSection = screen.getByRole('heading', { name: 'Completed' }).parentElement;
      expect(completedSection).toHaveTextContent('Preliminary Hearing');
    });
  });
});

describe('save-and-bill from a logged event', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  afterEach(() => {
    resetPermissions();
  });

  async function logTimeAndBill() {
    const user = userEvent.setup();
    stubEventReads(api, { upcoming: [makeEvent({ id: 'ev-1', title: 'Pretrial conference', dateLocalDisplay: 'Mar 2, 2026' })] });
    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage={false} />);
    await screen.findByText('Pretrial conference');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Log time' }));
    await user.click(await screen.findByRole('button', { name: 'Stub save and bill' }));
  }

  it('does not open the composer for a member without billing.manageInvoices', async () => {
    grantPermissions(['billing.manageTimeEntries']);
    await logTimeAndBill();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the matter composer when billing.manageInvoices is held', async () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    await logTimeAndBill();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toContain(`/lawfirm/${LAW_FIRM_ID}/matters/matter-1/generate-invoice`);
  });
});

describe('the zone an event was scheduled in', () => {
  // The suite runs in Los Angeles (jest.config.js), so that is the viewer zone.
  it('labels a timed event set in another zone, and no event in the viewer zone or any all-day one', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-nz', title: 'Auckland call', date: '2026-03-15T21:00:00.000Z', dateLocalDisplay: 'Mar 15, 2026, 2:00 PM', timeZone: 'Pacific/Auckland' }),
        makeEvent({ id: 'ev-la', title: 'Local call', dateLocalDisplay: 'Mar 16, 2026, 9:00 AM', timeZone: 'America/Los_Angeles' }),
        makeEvent({ id: 'ev-day', title: 'Filing day', allDay: true, dateLocalDisplay: 'Mar 17, 2026', timeZone: 'Pacific/Auckland' }),
      ],
    });

    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Auckland call');

    const zone = screen.getByText('(Mon 10:00 AM in Auckland)');
    // The row's meta line is already muted, so the event's own time keeps its tone.
    expect(zone).not.toHaveClass('text-on-surface-secondary');
    expect(zone.parentElement).toHaveTextContent(/^Mar 15, 2026, 2:00 PM PDT \(Mon 10:00 AM in Auckland\)$/);
    expect(screen.getByText('Mar 16, 2026, 9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Mar 17, 2026')).toBeInTheDocument();
    expect(screen.getAllByText(/ in (Auckland|Los Angeles)\)$/)).toHaveLength(1);
  });
});

describe('the court an event is held at', () => {
  const detailsPanel = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`#event-details-${id}`);

  it('shows the court in the details panel, once when the location repeats it', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-court', title: 'Motion hearing', contacts: [], courtName: 'Superior Court of Alameda', locationName: 'Dept. 12' }),
        makeEvent({ id: 'ev-court-only', title: 'Calendar call', contacts: [], courtName: 'District Court' }),
        makeEvent({ id: 'ev-court-same', title: 'Arraignment', contacts: [], courtName: 'County Court', locationName: 'county court' }),
      ],
    });

    const { container } = renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Motion hearing');

    expect(detailsPanel(container, 'ev-court')).toHaveTextContent('Superior Court of Alameda');
    expect(detailsPanel(container, 'ev-court')).toHaveTextContent('Dept. 12');
    expect(detailsPanel(container, 'ev-court-only')).toHaveTextContent('District Court');
    expect(within(detailsPanel(container, 'ev-court-same')!).getAllByText(/county court/i)).toHaveLength(1);
  });

  it('shows no matter court on an event that is not held at or filed with the court', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-depo', type: 'deposition', title: 'Expert deposition', contacts: [], courtName: 'Superior Court of Alameda', locationName: 'Counsel office' }),
      ],
    });

    const { container } = renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Expert deposition');

    expect(detailsPanel(container, 'ev-depo')).toHaveTextContent('Counsel office');
    expect(detailsPanel(container, 'ev-depo')).not.toHaveTextContent('Superior Court of Alameda');
  });
});

describe('safe event detail links', () => {
  it('links notes and venue while preserving the rendered event', async () => {
    stubEventReads(api, { upcoming: [makeEvent({ id: 'ev-links', title: 'Linked meeting', notes: 'Email counsel@example.com', location: 'https://example.com/venue' })] });
    renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
    await screen.findByText('Linked meeting');
    expect(screen.getByRole('link', { name: 'counsel@example.com' })).toHaveAttribute('href', 'mailto:counsel@example.com');
    expect(screen.getByRole('link', { name: 'https://example.com/venue' })).toHaveAttribute('href', 'https://example.com/venue');
  });
});

it.each(['count', 'blank'])('validates recurring event %s before saving', async (mode) => {
  const user = userEvent.setup();
  stubEventReads(api, { upcoming: [] });
  api.post('/events', { status: 201, body: { eventId: 'ev-series' } });
  renderWithProviders(<MatterEventsTab lawFirmId={LAW_FIRM_ID} matterId={MATTER_ID} canManage />);
  await screen.findByText(/No events yet/i);
  await user.click(screen.getByRole('button', { name: /Add Event/i }));
  const dialog = screen.getByRole('dialog', { name: /Add Matter Event/i });
  await user.type(within(dialog).getByPlaceholderText(/Motion to Dismiss Hearing/i), 'Weekly hearing');
  await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
  await user.click(within(dialog).getByRole('button', { name: /Select date/i }));
  await user.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '15' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Repeat' }));
  if (mode === 'count') {
    await user.click(within(dialog).getByRole('button', { name: /On date/ }));
    await user.click(screen.getByRole('option', { name: /After/ }));
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '60' } });
    expect(within(dialog).getByText('Will create 60 events total (including the first)')).toBeInTheDocument();
  }
  await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
  await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));
  if (mode === 'blank') {
    expect(await within(dialog).findByText('Select a recurrence end date')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  } else {
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toMatchObject({ recurrence: { endCount: 60 } });
  }
});
