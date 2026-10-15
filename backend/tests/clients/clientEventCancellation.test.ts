/**
 * The client Events tab reports why and when an event was cancelled, with the
 * same three fields the matter Events route returns: `cancellationReason`,
 * `cancelledBy` and `cancelledAt`. The tab merges matter events with events
 * recorded against the client, so both sources are checked.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let matterId: string;

const clientEventsPath = () => `/api/lawfirms/${firm.id}/clients/${client.id}/events`;
const matterEventsPath = () => `/api/lawfirms/${firm.id}/matters/${matterId}/events`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Cancellation client' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Matter with a cancelled hearing',
    clients: [{ clientId: client.id, name: 'Cancellation client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
});

const byTitle = (events: any[], title: string) => {
  const found = events.find((e) => e.title === title);
  expect(found).toBeDefined();
  return found;
};

describe('cancellation details on the client Events tab', () => {
  /**
   * Goes red if the client formatter drops the cancellation fields again: the
   * tab shows a cancelled hearing with no reason, no canceller and no time.
   */
  test('a cancelled matter event carries the same cancellation details as on the matter route', async () => {
    const created = await owner.api.post(matterEventsPath()).send({
      type: 'hearing', title: 'Motion hearing', date: '2026-11-03', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId ?? created.body.event?.id;
    expect(eventId).toBeTruthy();

    const cancelled = await owner.api.post(`${matterEventsPath()}/${eventId}/cancel`).send({ reason: 'Court closed for the day' });
    expect(cancelled.status).toBe(200);

    const matterView = await owner.api.get(matterEventsPath());
    expect(matterView.status).toBe(200);
    const onMatter = byTitle(matterView.body.events, 'Motion hearing');
    expect(onMatter.cancellationReason).toBe('Court closed for the day');

    const clientView = await owner.api.get(clientEventsPath());
    expect(clientView.status).toBe(200);
    const onClient = byTitle(clientView.body.events, 'Motion hearing');
    expect(onClient.source).toBe('matter');
    expect({
      cancellationReason: onClient.cancellationReason,
      cancelledBy: onClient.cancelledBy,
      cancelledAt: onClient.cancelledAt,
    }).toEqual({
      cancellationReason: 'Court closed for the day',
      cancelledBy: owner.uid,
      cancelledAt: onMatter.cancelledAt,
    });
    expect(onClient.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  /**
   * Goes red if the client repository stops reading the cancellation columns
   * of an event recorded against the client, or if an event that was never
   * cancelled reports anything but null for them.
   */
  test('an event recorded against the client returns its stored cancellation details, and null when never cancelled', async () => {
    const cancelledRes = await owner.api.post(clientEventsPath()).send({
      type: 'meeting', title: 'Intake call', date: '2026-11-04', allDay: true,
    });
    expect(cancelledRes.status).toBe(201);
    const openRes = await owner.api.post(clientEventsPath()).send({
      type: 'meeting', title: 'Follow-up call', date: '2026-11-05', allDay: true,
    });
    expect(openRes.status).toBe(201);

    const cancelledId = cancelledRes.body.eventId ?? cancelledRes.body.event?.id;
    const stamped = await testPool.query(
      `update events set status = 'cancelled', cancellation_reason = 'Client asked to reschedule',
              cancelled_by = $3, cancelled_at = '2026-10-01T15:30:00Z'
        where law_firm_id = $1 and id = $2`,
      [firm.id, cancelledId, owner.uid],
    );
    expect(stamped.rowCount).toBe(1);

    const view = await owner.api.get(clientEventsPath());
    expect(view.status).toBe(200);
    const cancelled = byTitle(view.body.events, 'Intake call');
    expect(cancelled.source).toBe('client');
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Client asked to reschedule',
      cancelledBy: owner.uid,
      cancelledAt: '2026-10-01T15:30:00.000Z',
    });

    const open = byTitle(view.body.events, 'Follow-up call');
    expect(open).toHaveProperty('cancellationReason', null);
    expect(open).toHaveProperty('cancelledBy', null);
    expect(open).toHaveProperty('cancelledAt', null);
  });
});

export {};
