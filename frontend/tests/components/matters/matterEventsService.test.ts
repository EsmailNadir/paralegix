/**
 * The matter events service, tested OFFLINE against a fake transport.
 *
 * The hook contract tests (`useMatterEvents.contract.test.tsx` and friends)
 * reach this module through React Query. This file pins the service on its
 * own: every url, query and body, and what each method does with a refusal.
 *
 * TWO THINGS GET THE MOST ATTENTION.
 *
 * THE VIEWER'S TIMEZONE. Every read carries `tz`, because "today", "overdue"
 * and which day an all-day event falls on are decided server-side in the
 * viewer's zone. A read without it buckets events by the server's day.
 *
 * WHICH VERB ON WHICH EVENT. Postpone, cancel, update and delete all address
 * one event by id and differ only by method or a trailing segment. Postponing
 * an event that was meant to be cancelled leaves a hearing on the calendar that
 * is not happening, and reports success in the same words.
 */
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import matterEventsService from '@/services/matterEvents.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-9';
const EVENT_ID = 'ev-1';
const MATTERS = `/api/lawfirms/${LAW_FIRM_ID}/matters`;
const EVENTS = `${MATTERS}/${MATTER_ID}/events`;
const EVENT = `${EVENTS}/${EVENT_ID}`;
const TZ = encodeURIComponent(getUserTimeZone());

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('reads carry the viewer timezone', () => {
  it('bounds the firm-wide calendar read to the window, with tz', async () => {
    const body = { events: [{ id: EVENT_ID }], totalEvents: 1 };
    api.getExact(`${MATTERS}/events?tz=${TZ}&from=2026-03-01&to=2026-03-31`, body);

    await expect(matterEventsService.listAllEvents(LAW_FIRM_ID, { from: '2026-03-01', to: '2026-03-31' })).resolves.toEqual(body);
  });

  it('reads every firm event with only tz when no window is given', async () => {
    api.getExact(`${MATTERS}/events?tz=${TZ}`, { events: [], totalEvents: 0 });

    await matterEventsService.listAllEvents(LAW_FIRM_ID);

    expect(new URL(onlyCall('GET').url).searchParams.has('from')).toBe(false);
  });

  it('reads one matter events with tz', async () => {
    const body = { events: [{ id: EVENT_ID }], totalEvents: 1 };
    api.getExact(`${EVENTS}?tz=${TZ}`, body);

    await expect(matterEventsService.listEvents(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual(body);
  });

  it('sends the page window and status section for a paged read', async () => {
    const body = { events: [{ id: EVENT_ID }], totalEvents: 31 };
    api.getExact(`${EVENTS}?tz=${TZ}&status=upcoming&page=2&limit=10`, body);

    await expect(matterEventsService.getEventsPage(LAW_FIRM_ID, MATTER_ID, { status: 'upcoming', page: 2, limit: 10 }))
      .resolves.toEqual(body);
  });

  it('omits a paged read filter that was not given', async () => {
    api.getExact(`${EVENTS}?tz=${TZ}`, { events: [], totalEvents: 0 });

    await matterEventsService.getEventsPage(LAW_FIRM_ID, MATTER_ID, {});

    expect(api.calls('GET')).toHaveLength(1);
  });

  it('reads the dependency graph from its own route, with no paging', async () => {
    const graph = { events: [{ id: EVENT_ID, dependsOn: ['ev-0'] }] };
    api.getExact(`${EVENTS}/graph`, graph);

    await expect(matterEventsService.getEventGraph(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual(graph);
  });
});

describe('writes address one event by id', () => {
  it('POSTs a new event with exactly the payload', async () => {
    api.postExact(EVENTS, { message: 'Created', eventId: EVENT_ID, event: { id: EVENT_ID } });

    const payload = {
      type: 'hearing' as const,
      title: 'Motion hearing',
      date: '2026-04-01',
      assignedTo: ['u-1'],
      contactIds: [],
      allDay: true,
    };
    const result = await matterEventsService.createEvent(LAW_FIRM_ID, MATTER_ID, payload);

    // `contactIds: []` is a replace-set that clears attendees, so it must leave
    // as an empty array rather than be dropped.
    expect(onlyCall('POST').body).toEqual(payload);
    expect(result).toEqual({ message: 'Created', eventId: EVENT_ID, event: { id: EVENT_ID } });
  });

  it('PUTs an edit, keeping an explicit null that clears a field', async () => {
    api.putExact(EVENT, { message: 'Updated', event: { id: EVENT_ID } });

    await matterEventsService.updateEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { notes: null, location: null });

    expect(onlyCall('PUT').body).toEqual({ notes: null, location: null });
  });

  it('DELETEs one event', async () => {
    api.deleteExact(EVENT, { message: 'Deleted', eventId: EVENT_ID });

    await expect(matterEventsService.deleteEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID)).resolves.toEqual({ message: 'Deleted', eventId: EVENT_ID });
  });

  it('postpones on the postpone sub-route with the new date and reason', async () => {
    api.postExact(`${EVENT}/postpone`, { message: 'Postponed', event: { id: EVENT_ID, date: '2026-05-01' } });

    await matterEventsService.postponeEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { newDate: '2026-05-01', reason: 'Court closed' });

    expect(onlyCall('POST').body).toEqual({ newDate: '2026-05-01', reason: 'Court closed' });
  });

  it('cancels on the cancel sub-route, never the postpone one', async () => {
    api.postExact(`${EVENT}/cancel`, { message: 'Cancelled', event: { id: EVENT_ID, status: 'cancelled' } });

    const result = await matterEventsService.cancelEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { reason: 'Settled' });

    expect(onlyCall('POST').body).toEqual({ reason: 'Settled' });
    expect(result.event).toEqual({ id: EVENT_ID, status: 'cancelled' });
  });

  it('deletes a whole recurrence group by group id, not event id', async () => {
    api.deleteExact(`${EVENTS}/recurrence/grp-1`, { message: 'Deleted 12 events' });

    await expect(matterEventsService.deleteRecurrenceGroup(LAW_FIRM_ID, MATTER_ID, 'grp-1')).resolves.toEqual({ message: 'Deleted 12 events' });
  });

  it('escapes ids so a slash cannot become a path segment', async () => {
    api.delete('/events/a%2Fb', { message: 'Deleted', eventId: 'a/b' });

    await matterEventsService.deleteEvent(LAW_FIRM_ID, MATTER_ID, 'a/b');

    expect(onlyCall('DELETE').pathname).toBe(`${EVENTS}/a%2Fb`);
  });
});

/**
 * Each method checks `response.ok` itself. When the server sends no reason,
 * the message the user reads is the method's own fallback, so each row pins
 * that its OWN guard ran rather than an error body being returned as data.
 */
describe('a refusal with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'get' | 'post' | 'put' | 'delete', string, () => Promise<unknown>, string]> = [
    ['listAllEvents', 'get', `${MATTERS}/events?tz=${TZ}`, () => matterEventsService.listAllEvents(LAW_FIRM_ID), 'Failed to load matter events'],
    ['getEventGraph', 'get', `${EVENTS}/graph`, () => matterEventsService.getEventGraph(LAW_FIRM_ID, MATTER_ID), 'Failed to load event dependencies'],
    ['getEventsPage', 'get', `${EVENTS}?tz=${TZ}`, () => matterEventsService.getEventsPage(LAW_FIRM_ID, MATTER_ID, {}), 'Failed to load matter events'],
    ['listEvents', 'get', `${EVENTS}?tz=${TZ}`, () => matterEventsService.listEvents(LAW_FIRM_ID, MATTER_ID), 'Failed to load matter events'],
    ['createEvent', 'post', EVENTS, () => matterEventsService.createEvent(LAW_FIRM_ID, MATTER_ID, { type: 'hearing', title: 't', date: '2026-04-01' }), 'Failed to create matter event'],
    ['updateEvent', 'put', EVENT, () => matterEventsService.updateEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, {}), 'Failed to update matter event'],
    ['deleteEvent', 'delete', EVENT, () => matterEventsService.deleteEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID), 'Failed to delete matter event'],
    ['postponeEvent', 'post', `${EVENT}/postpone`, () => matterEventsService.postponeEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { newDate: '2026-05-01' }), 'Failed to postpone event'],
    ['cancelEvent', 'post', `${EVENT}/cancel`, () => matterEventsService.cancelEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { reason: 'r' }), 'Failed to cancel event'],
    ['deleteRecurrenceGroup', 'delete', `${EVENTS}/recurrence/grp-1`, () => matterEventsService.deleteRecurrenceGroup(LAW_FIRM_ID, MATTER_ID, 'grp-1'), 'Failed to delete recurring events'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ get: api.getExact, post: api.postExact, put: api.putExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });

  it('carries the server reason when there is one', async () => {
    api.postExact(`${EVENT}/postpone`, { status: 409, body: { error: 'Cannot postpone a cancelled event' } });

    const error = await rejectionOf(matterEventsService.postponeEvent(LAW_FIRM_ID, MATTER_ID, EVENT_ID, { newDate: '2026-05-01' }));

    expect(error.message).toBe('Cannot postpone a cancelled event');
    expect(error.status).toBe(409);
  });
});
