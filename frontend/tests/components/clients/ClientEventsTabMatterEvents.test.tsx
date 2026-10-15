/**
 * Matter-sourced events on the client Events tab.
 *
 * The client tab lists the events of every matter the client is on beside the
 * client's own. A matter event is still the MATTER's record: the backend's
 * client-events routes require `matters.update` on top of `clients.manage` to
 * change one, completing it should warn about its unfinished dependencies the
 * way the matter tab does, an edit has to reach the matter's own cached events,
 * and its assignees must be members of that matter.
 *
 * The client, matter, matter-events and users services all run for real against
 * a faked transport.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/courts.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import ClientEventsTab from '@/components/clientComp/ClientEventsTab';
import type { ClientEvent } from '@/types/clientEvent';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';
const MATTER_ID = 'matter-1';
const API = 'http://localhost:5001/api';

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

const matterEvent = (overrides: Partial<ClientEvent> = {}) => makeEvent({
  id: 'ev-matter',
  title: 'Matter hearing',
  source: 'matter',
  clientId: null,
  matterId: MATTER_ID,
  matterName: 'Meridian Freight',
  dateLocalInput: '2026-03-15T10:00',
  ...overrides,
});

/** Every upcoming read (the shared list and the Upcoming section) answers these rows. */
function stubEvents(api: ApiMock, events: ClientEvent[]) {
  api.get('/contacts/lookup', { contacts: [] });
  api.get(`/clients/${CLIENT_ID}/events`, (call) => {
    const status = call.query.status?.[0];
    const rows = status ? events.filter((e) => e.status === status) : events;
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

function renderTab(props: { canUpdateMatters?: boolean } = {}) {
  return renderWithProviders(
    <ClientEventsTab
      lawFirmId={LAW_FIRM_ID}
      clientId={CLIENT_ID}
      clientMatters={[{ id: MATTER_ID, name: 'Meridian Freight' }]}
      canManage
      canUpdateMatters={props.canUpdateMatters ?? true}
      companyNames={new Map()}
    />,
  );
}

it.each([true, false])('offers linking a new event to a matter only with matter update permission (%s)', async (canUpdateMatters) => {
  stubEvents(api, []);
  api.get('/users', { users: [] });
  renderTab({ canUpdateMatters });
  await userEvent.click(await screen.findByRole('button', { name: 'Add Event' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByRole('textbox', { name: /^Title/ }), 'Client consultation');
  await userEvent.click(within(dialog).getByRole('button', { name: /^Start \*? ?(?!time)/ }));
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: '20' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  expect(within(dialog).queryByText('Link to Matter') !== null).toBe(canUpdateMatters);
});

describe('controls on a matter event', () => {
  // The backend refuses a matter event's edit, delete or completion without matters.update.
  // Red if: the row offers them on clients.manage alone, so every click ends in a 403.
  it('are withheld from a member who can manage the client but not update matters', async () => {
    stubEvents(api, [matterEvent(), makeEvent({ id: 'ev-own', title: 'Client meeting' })]);

    renderTab({ canUpdateMatters: false });

    await screen.findByText('Matter hearing');
    await screen.findByText('Client meeting');
    // Only the client's own event keeps its controls.
    expect(screen.getAllByRole('button', { name: 'Mark as completed' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
  });
});

describe('completing a matter event with unfinished dependencies', () => {
  function stubGraph(dependency: { status: string }) {
    api.getExact(`${API}/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}/events/graph`, {
      events: [
        { id: 'ev-matter', type: 'court_date', title: 'Matter hearing', status: 'upcoming', date: null, dateLocalDisplay: null, dependsOn: ['ev-dep'] },
        { id: 'ev-dep', type: 'deadline', title: 'File opening brief', status: dependency.status, date: null, dateLocalDisplay: 'Mar 1, 2026', dependsOn: [] },
      ],
    });
  }

  // Red if: the client tab completes a blocked matter event straight away, skipping the warning
  // the matter tab shows for the same event.
  it('warns first and completes only once the user confirms', async () => {
    stubEvents(api, [matterEvent()]);
    stubGraph({ status: 'upcoming' });
    api.put(`/clients/${CLIENT_ID}/events/ev-matter`, { message: 'ok', event: matterEvent({ status: 'completed' }) });

    renderTab();
    await screen.findByText('Matter hearing');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));

    const dialog = await screen.findByRole('dialog', { name: 'Complete Blocked Event?' });
    expect(within(dialog).getByText(/File opening brief/)).toBeInTheDocument();
    expect(api.calls('PUT')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete Anyway' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toMatchObject({ source: 'matter', matterId: MATTER_ID, status: 'completed' });
  });

  it('completes without a warning once every dependency is done', async () => {
    stubEvents(api, [matterEvent()]);
    stubGraph({ status: 'completed' });
    api.put(`/clients/${CLIENT_ID}/events/ev-matter`, { message: 'ok', event: matterEvent({ status: 'completed' }) });

    renderTab();
    await screen.findByText('Matter hearing');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Complete Blocked Event?' })).not.toBeInTheDocument();
  });
});

describe('editing a matter event', () => {
  async function openEdit() {
    stubEvents(api, [matterEvent()]);
    api.getExact(`${API}/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}`, {
      id: MATTER_ID,
      name: 'Meridian Freight',
      members: [{ userId: 'u-member', name: 'Rosa Member' }],
    });
    api.getExact(`${API}/users/lawfirm/${LAW_FIRM_ID}/users`, [
      { uid: 'u-member', name: 'Rosa Member', email: 'rosa@firm.test' },
      { uid: 'u-outsider', name: 'Otto Outsider', email: 'otto@firm.test' },
    ]);
    api.put(`/clients/${CLIENT_ID}/events/ev-matter`, { message: 'ok', event: matterEvent() });

    const view = renderTab();
    await screen.findByText('Matter hearing');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Edit event/i }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Event/i });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    return { ...view, dialog };
  }

  // The backend rejects a matter event assignee who is not on the matter.
  // Red if: the picker offers the whole firm roster, so choosing Otto fails on save.
  it('offers only the matter\'s members as assignees', async () => {
    const { dialog } = await openEdit();

    expect(await within(dialog).findByText('Rosa Member')).toBeInTheDocument();
    expect(within(dialog).queryByText('Otto Outsider')).not.toBeInTheDocument();
  });

  // The matter's own Events tab reads ["matterEvents", firm, matter]. Red if: only the client's
  // events are refreshed, so the matter tab keeps showing the event as it was before the edit.
  it('refreshes the matter\'s own events after saving', async () => {
    const { dialog, queryClient } = await openEdit();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['matterEvents', LAW_FIRM_ID, MATTER_ID] }));
  });
});
