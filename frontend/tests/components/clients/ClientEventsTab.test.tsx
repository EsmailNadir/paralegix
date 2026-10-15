/**
 * The client Events tab, driven through the REAL client-events service.
 *
 * `tests/setup.ts` replaces `clients.service` with a Proxy whose every method
 * resolves `{}`. Rendering this tab under that default proves nothing: the
 * list is empty because the mock said so. Unmocking the service puts url
 * building, query parameters and response parsing back in the path, and
 * `installApiMock` fakes only the transport underneath it.
 *
 * This tab shares its row shape with the matter Events tab (see
 * `MatterEventsTab.test.tsx`) via the same `ListView` component. The case
 * worth pinning here that the matter tab does not have is the read-only
 * treatment of an event pulled in from a linked company: editing it would
 * 404 server-side (it belongs to a different client id), so the row must not
 * offer the controls that would let a user try.
 *
 * What the tab re-reads after a change is counted at the transport too. Every
 * mutation used to run a four-way `Promise.all` of `refetch()` calls over the
 * shared list and all three status sections. `refetch()` ignores a query's
 * `enabled` flag, so the sections the status chips had filtered OUT of view
 * were re-read as eagerly as the one on screen. The sections now share one key
 * prefix with the shared list, which is what makes a single
 * `invalidateQueries` correct here.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.unmock('@/services/courts.service');

// Record what the event modal asks the roster hook for, keeping its behaviour.
const mockUseLawFirmUsersArgs = jest.fn();
jest.mock('@/hooks/useUsers', () => {
  const actual = jest.requireActual('@/hooks/useUsers');
  return {
    __esModule: true,
    ...actual,
    useLawFirmUsers: (...args: unknown[]) => {
      mockUseLawFirmUsersArgs(...args);
      return actual.useLawFirmUsers(...args);
    },
  };
});

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import ClientEventsTab from '@/components/clientComp/ClientEventsTab';
import type { ClientEvent } from '@/types/clientEvent';
import type { MatterEventStatus } from '@/types/matterEvent';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

function makeEvent(overrides: Partial<ClientEvent> & { id: string; title: string }): ClientEvent {
  return {
    type: 'court_date',
    date: '2026-03-15T12:00:00.000Z',
    status: 'upcoming',
    source: 'client',
    clientId: CLIENT_ID,
    lawFirmId: LAW_FIRM_ID,
    createdBy: 'test-uid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Wire up every read the tab makes on mount: the unpaged list it shares with
 * `ClientDetail`'s count badge, plus one page per status section, told apart
 * by the query string the same way the matter tab's sections are.
 */
function stubEventReads(api: ApiMock, sections: Partial<Record<MatterEventStatus, ClientEvent[]>>) {
  api.get('/contacts/lookup', { contacts: [] });
  api.get('/events', (call: RecordedCall) => {
    const status = new URL(call.url, 'http://localhost').searchParams.get('status');
    if (!status) {
      const all = Object.values(sections).flat();
      return { events: all, totalEvents: all.length };
    }
    const rows = sections[status as MatterEventStatus] ?? [];
    return { events: rows, totalEvents: rows.length };
  });
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.get('/courts', { courts: [] });
});

afterEach(() => {
  api.restore();
});

describe('the order events are listed in', () => {
  it('puts upcoming events above completed ones and completed above cancelled', async () => {
    stubEventReads(api, {
      upcoming: [makeEvent({ id: 'ev-1', title: 'Intake call', dateLocalDisplay: 'Mar 2, 2026' })],
      completed: [makeEvent({ id: 'ev-2', title: 'Signed retainer', status: 'completed', dateLocalDisplay: 'Feb 2, 2026' })],
      cancelled: [makeEvent({ id: 'ev-3', title: 'Follow-up call', status: 'cancelled', dateLocalDisplay: 'Feb 9, 2026' })],
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map()}
      />,
    );

    await screen.findByText('Intake call');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Upcoming', 'Completed', 'Cancelled']);

    expect(screen.getByText('Signed retainer')).toBeInTheDocument();
    expect(screen.getByText('Follow-up call')).toBeInTheDocument();
  });
});

describe('an event pulled in from a linked company', () => {
  it('offers no mark-complete or edit/delete controls, unlike the client’s own event', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-own', title: 'Client-owned meeting' }),
        makeEvent({ id: 'ev-company', title: 'Company deposition', clientId: 'company-1' }),
      ],
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map([['company-1', 'Acme Corp']])}
      />,
    );

    await screen.findByText('Client-owned meeting');
    await screen.findByText('Company deposition');

    // The company badge names why the row is here at all.
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();

    // Exactly one row offers actions: the client's own event.
    expect(screen.getAllByRole('button', { name: 'Mark as completed' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
  });
});

describe('a matter event shown on the client tab', () => {
  /**
   * A matter-sourced event carries no client id: it is scoped by its matter,
   * not by the client this tab reads for. It is still the firm's own record, so
   * it keeps every row control, and it never inherits a linked company's badge
   * or that company's read-only treatment.
   */
  const matterEvent = () =>
    makeEvent({
      id: 'ev-matter',
      title: 'Matter hearing',
      source: 'matter',
      clientId: null,
      matterId: 'matter-1',
      matterName: 'Meridian Freight',
    });

  it('keeps full row actions for a member who can manage, while the company event gets none', async () => {
    stubEventReads(api, {
      upcoming: [
        matterEvent(),
        makeEvent({ id: 'ev-company', title: 'Company deposition', clientId: 'company-1' }),
      ],
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        canUpdateMatters
        companyNames={new Map([['company-1', 'Acme Corp']])}
      />,
    );

    await screen.findByText('Matter hearing');
    await screen.findByText('Company deposition');

    // The matter badge names the matter; only the company row is badged as the company's.
    expect(screen.getByRole('button', { name: 'Meridian Freight' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp')).toHaveLength(1);

    // One row of two offers controls, and the company row is the one that cannot.
    expect(screen.getAllByRole('button', { name: 'Mark as completed' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
  });

  it('offers no row actions to a member who cannot manage events', async () => {
    stubEventReads(api, { upcoming: [matterEvent()] });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage={false}
        companyNames={new Map()}
      />,
    );

    await screen.findByText('Matter hearing');
    expect(screen.queryByRole('button', { name: 'Mark as completed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });
});

describe('the mark-complete button', () => {
  /**
   * THE DEFECT THIS PINS. On a completed row the same green check button
   * turned into "Mark as upcoming", so the icon that completes an event also
   * silently reopened one. The matter tab offers the button only on events that
   * are still open, and reopening is done from Edit on both tabs.
   */
  it('is offered only on an open event, not on a completed or cancelled one', async () => {
    stubEventReads(api, {
      upcoming: [makeEvent({ id: 'ev-open', title: 'Intake call' })],
      completed: [makeEvent({ id: 'ev-done', title: 'Signed retainer', status: 'completed' })],
      cancelled: [makeEvent({ id: 'ev-off', title: 'Follow-up call', status: 'cancelled' })],
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map()}
      />,
    );

    // All three rows are on screen, each still offering its menu.
    await screen.findByText('Signed retainer');
    expect(screen.getByText('Follow-up call')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(3);

    expect(screen.getAllByRole('button', { name: 'Mark as completed' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Mark as upcoming' })).not.toBeInTheDocument();
  });
});

describe('editing an event', () => {
  it('does not expose create-only matter linking while an edit dialog fades out', async () => {
    const user = userEvent.setup();
    stubEventReads(api, {
      upcoming: [makeEvent({ id: 'ev-1', title: 'Consultation', dateLocalInput: '2026-03-15T10:00' })],
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[{ id: 'matter-1', name: 'Meridian Freight' }]}
        canManage
        companyNames={new Map()}
      />,
    );

    await screen.findByText('Consultation');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).queryByText('Link to Matter')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(within(screen.getByRole('dialog', { name: /Edit Event/i })).queryByText('Link to Matter')).not.toBeInTheDocument();
  });

  it('PUTs the changed title to the event and the list then shows it', async () => {
    const user = userEvent.setup();
    const original = makeEvent({ id: 'ev-1', title: 'Consultation', dateLocalDisplay: 'Mar 15, 2026', dateLocalInput: '2026-03-15T10:00' });
    const renamed = { ...original, title: 'Consultation (rescheduled)' };
    let updated = false;
    stubEventReads(api, { get upcoming() { return [updated ? renamed : original]; } } as never);
    api.put('/events/ev-1', () => {
      updated = true;
      return { message: 'ok', event: renamed };
    });

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map()}
      />,
    );

    await screen.findByText('Consultation');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));

    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    const titleField = dialog.querySelector('input[id$="-title"]') as HTMLInputElement;
    await user.clear(titleField);
    await user.type(titleField, 'Consultation (rescheduled)');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Consultation (rescheduled)')).toBeInTheDocument();
    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/events\/ev-1$/);
    expect((call.body as Record<string, unknown>).title).toBe('Consultation (rescheduled)');
  });
});

describe('the end of a client event', () => {
  // The client tab builds its own payload around the shared form, so its end
  // wiring is separate code from the matter tab's and needs its own proof.
  it('shows a timed span in the list, prefills the end, and saves it back as the local wall clock', async () => {
    const user = userEvent.setup();
    const meeting = makeEvent({
      id: 'ev-1',
      title: 'Consultation',
      allDay: false,
      date: '2026-03-15T14:00:00.000Z',
      endsAt: '2026-03-15T15:30:00.000Z',
      dateLocalInput: '2026-03-15T10:00',
      dateLocalDisplay: 'Mar 15, 2026, 10:00 AM',
      endsAtLocalInput: '2026-03-15T11:30',
      endsAtLocalDisplay: 'Mar 15, 2026, 11:30 AM',
    });
    stubEventReads(api, { upcoming: [meeting] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: meeting }));

    renderWithProviders(
      <ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} canManage companyNames={new Map()} />,
    );

    expect(await screen.findByText(/Mar 15, 2026, 10:00 AM – Mar 15, 2026, 11:30 AM/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    expect(within(dialog).getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent('Mar 15, 2026');
    expect(within(dialog).getByRole('button', { name: 'End time' })).toHaveTextContent('11:30 AM');

    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).not.toHaveProperty('endsAt');
  });

  // The server carries the stored end along with a moved start, keeping a
  // length the form's cached copy may not know about.
  it('sends the moved start without the end that only followed it', async () => {
    const user = userEvent.setup();
    const meeting = makeEvent({
      id: 'ev-1', title: 'Consultation', allDay: false,
      date: '2026-03-15T14:00:00.000Z', endsAt: '2026-03-15T15:30:00.000Z',
      dateLocalInput: '2026-03-15T10:00', dateLocalDisplay: 'Mar 15, 2026, 10:00 AM',
      endsAtLocalInput: '2026-03-15T11:30', endsAtLocalDisplay: 'Mar 15, 2026, 11:30 AM',
    });
    stubEventReads(api, { upcoming: [meeting] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: meeting }));

    renderWithProviders(
      <ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} canManage companyNames={new Map()} />,
    );
    await screen.findByText('Consultation');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    await user.click(within(dialog).getByRole('button', { name: /^Start \*? ?(?!time)/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
    expect(within(dialog).getByRole('button', { name: /^End (?!time)/ })).toHaveTextContent('Mar 20, 2026');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.date).toBe('2026-03-20T10:00');
    expect(body).not.toHaveProperty('endsAt');
  });

  // The form may have opened from a cached list older than a change made in
  // Google and polled in since; resending its schedule would undo that change.
  it('sends no date, end or all-day flag when only the title changes', async () => {
    const user = userEvent.setup();
    const meeting = makeEvent({
      id: 'ev-1', title: 'Consultation', allDay: false,
      date: '2026-03-15T14:00:00.000Z', endsAt: '2026-03-15T15:30:00.000Z',
      dateLocalInput: '2026-03-15T10:00', dateLocalDisplay: 'Mar 15, 2026, 10:00 AM',
      endsAtLocalInput: '2026-03-15T11:30', endsAtLocalDisplay: 'Mar 15, 2026, 11:30 AM',
    });
    stubEventReads(api, { upcoming: [meeting] });
    api.put('/events/ev-1', () => ({ message: 'ok', event: meeting }));

    renderWithProviders(
      <ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} canManage companyNames={new Map()} />,
    );
    await screen.findByText('Consultation');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    const titleField = dialog.querySelector('input[id$="-title"]') as HTMLInputElement;
    await user.clear(titleField);
    await user.type(titleField, 'Intake call');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.title).toBe('Intake call');
    expect(body).not.toHaveProperty('date');
    expect(body).not.toHaveProperty('endsAt');
    expect(body).not.toHaveProperty('allDay');
  });
});

describe('editing a matter event from the client tab', () => {
  it('leaves its location name empty rather than saving the matter\'s court into it', async () => {
    // Red when: the edit form falls back to `courtName` for a matter event, whose
    // court is the MATTER's, so saving any edit stamps it on as the location.
    const user = userEvent.setup();
    const original = makeEvent({
      id: 'ev-m1', source: 'matter', matterId: 'matter-1', type: 'hearing', title: 'Status hearing',
      courtName: 'Superior Court', dateLocalDisplay: 'Mar 15, 2026', dateLocalInput: '2026-03-15T10:00',
    });
    stubEventReads(api, { upcoming: [original] });
    api.get('/courts', { courts: [{ id: 'court-1', name: 'Superior Court', address: '123 Court St' }] });
    api.put('/events/ev-m1', () => ({ message: 'ok', event: { ...original, title: 'Status hearing (moved)' } }));

    renderWithProviders(
      <ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} canManage canUpdateMatters companyNames={new Map()} />,
    );

    await screen.findByText('Status hearing');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    const titleField = dialog.querySelector('input[id$="-title"]') as HTMLInputElement;
    await user.clear(titleField);
    await user.type(titleField, 'Status hearing (moved)');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.title).toBe('Status hearing (moved)');
    expect(body.locationName).not.toBe('Superior Court');
    expect(body.location).toBeNull();
  });
});

describe('the event modal\'s assignee roster', () => {
  it('is not asked for while the modal is closed', async () => {
    stubEventReads(api, {});
    mockUseLawFirmUsersArgs.mockClear();

    renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map()}
      />,
    );
    await screen.findByRole('button', { name: /Add Event/i });

    expect(mockUseLawFirmUsersArgs).toHaveBeenCalled();
    expect(mockUseLawFirmUsersArgs.mock.calls.every((call) => call[1] === false)).toBe(true);
  });
});

describe('re-reading after a change', () => {
  /** Server-side truth the fake routes read, so a mutation actually changes it. */
  let events: ClientEvent[];

  /** The status section a recorded read belongs to, or undefined for the shared list. */
  const sectionOf = (call: RecordedCall) => call.query.status?.[0];

  beforeEach(() => {
    events = [
      makeEvent({ id: 'evt-upcoming', title: 'Intake Interview' }),
      makeEvent({ id: 'evt-completed', title: 'Settlement Review', status: 'completed' }),
      makeEvent({ id: 'evt-cancelled', title: 'Vacated Call', status: 'cancelled' }),
    ];
    api.get(`/clients/${CLIENT_ID}/events`, (call) => {
      const status = sectionOf(call) as MatterEventStatus | undefined;
      const rows = status ? events.filter((e) => e.status === status) : events;
      return { events: rows, totalEvents: rows.length };
    });
    api.put(`/clients/${CLIENT_ID}/events/evt-upcoming`, (call) => {
      const patch = call.body as { status?: MatterEventStatus };
      events = events.map((e) => (e.id === 'evt-upcoming' ? { ...e, status: patch.status ?? e.status } : e));
      return { message: 'ok', event: events.find((e) => e.id === 'evt-upcoming') };
    });
  });

  function renderTab() {
    return renderWithProviders(
      <ClientEventsTab
        lawFirmId={LAW_FIRM_ID}
        clientId={CLIENT_ID}
        clientMatters={[]}
        canManage
        companyNames={new Map()}
      />,
    );
  }

  it('re-reads only the sections on screen, never the ones the viewer filtered out', async () => {
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByText('Intake Interview')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    await waitFor(() => expect(screen.queryByText('Settlement Review')).not.toBeInTheDocument());

    const before = api.calls().length;
    await user.click(screen.getByRole('button', { name: 'Mark as completed' }));

    // The event left the Upcoming section, which is the whole visible result of
    // the change.
    await waitFor(() => expect(screen.queryByText('Intake Interview')).not.toBeInTheDocument());

    const after = api.calls().slice(before);
    expect(after.filter((call) => sectionOf(call) === 'completed')).toHaveLength(0);
    expect(after.filter((call) => sectionOf(call) === 'cancelled')).toHaveLength(0);
    // The shared list and the one mounted section. The four-way refetch added
    // the two hidden sections on top.
    expect(after.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('still shows the change in every section that IS on screen', async () => {
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByText('Intake Interview')).toBeInTheDocument();
    expect(screen.getByText('Settlement Review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark as completed' }));

    await waitFor(() => {
      const completedSection = screen.getByRole('heading', { name: 'Completed' }).parentElement;
      expect(completedSection).toHaveTextContent('Intake Interview');
    });
  });
});

describe('safe event detail links', () => {
  it('links notes and venue while preserving the rendered event', async () => {
    stubEventReads(api, { upcoming: [makeEvent({ id: 'ev-links', title: 'Linked meeting', notes: 'Email counsel@example.com', location: 'https://example.com/venue' })] });
    renderWithProviders(<ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} companyNames={new Map()} canManage={false} />);
    await screen.findByText('Linked meeting');
    expect(screen.getByRole('link', { name: 'counsel@example.com' })).toHaveAttribute('href', 'mailto:counsel@example.com');
    expect(screen.getByRole('link', { name: 'https://example.com/venue' })).toHaveAttribute('href', 'https://example.com/venue');
  });
});

describe('the court an event is held at', () => {
  it('shows a client event\'s location name beside the court it was given', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-court', type: 'meeting', title: 'Prep meeting', courtName: 'District Court', locationName: 'Conference room B', location: '2 Oak Ave' }),
      ],
    });
    const { container } = renderWithProviders(<ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} companyNames={new Map()} canManage={false} />);
    await screen.findByText('Prep meeting');

    expect(container.querySelector('#client-event-details-ev-court')).toHaveTextContent('District Court · Conference room B · 2 Oak Ave');
  });

  it('shows no matter court on a matter event that is not held at the court', async () => {
    stubEventReads(api, {
      upcoming: [
        makeEvent({ id: 'ev-depo', source: 'matter', matterId: 'matter-1', type: 'deposition', title: 'Expert deposition', courtName: 'Superior Court', locationName: 'Counsel office' }),
      ],
    });
    const { container } = renderWithProviders(<ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} companyNames={new Map()} canManage={false} />);
    await screen.findByText('Expert deposition');

    const details = container.querySelector('#client-event-details-ev-depo');
    expect(details).toHaveTextContent('Counsel office');
    expect(details).not.toHaveTextContent('Superior Court');
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
    renderWithProviders(<ClientEventsTab lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientMatters={[]} companyNames={new Map()} canManage={false} />);
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
