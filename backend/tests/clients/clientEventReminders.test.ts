/**
 * Standalone client events (an `events` row with a `client_id` and no
 * `matter_id`) get the same reminder emails matter events do: the same per-firm
 * `matterEventReminders` settings, the same recipients (assignees, else the
 * creator, else the firm's owner and admins), and the same claim on the shared
 * `reminders` row so a second sweep inside 24 hours sends nothing.
 *
 * Driven through the real cron route, so these also prove the pass is wired.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createFirmMember,
  createPersonClient,
  drainEvents,
  freezeClockAt,
  ownerOf,
  recipientsOf,
  request,
  testPool,
  unfreezeClock,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let assigneeUid: string;
let client: ClientRecord;
let savedKillSwitch: string | undefined;

const NOW = '2026-09-05T09:00:00-04:00';
const ONE_DAY_OUT = '2026-09-06T09:00:00-04:00';

const emailOf = (uid: string) => `${uid}@example.test`;
const runSweep = async () => {
  const res = await request().post('/api/cron/reminders').set('x-cloudscheduler', 'true');
  expect(res.status).toBe(200);
  await drainEvents();
  return res;
};

beforeEach(async () => {
  // `.env` ships DISABLE_ALL_REMINDER_EMAILS=true so other suites never mail.
  savedKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  freezeClockAt(NOW);
  firm = await createFirm({ name: 'Client Reminder Firm' });
  owner = await ownerOf(firm.id);
  assigneeUid = (await createFirmMember(firm.id, { isOwner: false })).uid;
  client = await createPersonClient(firm.id, { name: 'Reminder client' });
});

afterEach(() => {
  unfreezeClock();
  if (savedKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = savedKillSwitch;
});

/** A client event written straight to the table, for states the API does not create. */
async function seedClientEvent(title: string, { status = 'upcoming', date = ONE_DAY_OUT } = {}) {
  const id = randomUUID();
  await testPool.query(
    `with e as (
       insert into events (id, law_firm_id, client_id, title, type, status, date, created_by)
       values ($1, $2, $3, $4, 'meeting', $5, $6, $7)
     )
     insert into event_assignees (law_firm_id, event_id, user_id) values ($2, $1, $8)`,
    [id, firm.id, client.id, title, status, date, owner.uid, assigneeUid],
  );
  return id;
}

describe('client event reminders', () => {
  /**
   * Goes red if client events are left out of the reminder pass (nothing is
   * sent), or if the recipients are not the event's assignees (the owner, who
   * created it but is not assigned, would be mailed instead or as well).
   */
  test('a client event one day out emails its assignee exactly once', async () => {
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/clients/${client.id}/events`).send({
      type: 'meeting', title: 'Client deposition prep', date: ONE_DAY_OUT, assignedTo: [assigneeUid],
    });
    expect(created.status).toBe(201);

    const res = await runSweep();

    expect(recipientsOf('In 1 day: Client deposition prep')).toEqual([emailOf(assigneeUid)]);
    expect(res.body.clientEventReminders).toMatchObject({ sent: 1 });
  });

  /**
   * Goes red if the client sweep does not claim the shared `reminders` row
   * before sending: the scheduler retries on any non-2xx, so a second pass
   * inside the window is the ordinary case.
   */
  test('a second sweep sends nothing more for the same client event', async () => {
    const eventId = await seedClientEvent('Only once for the client');

    await runSweep();
    expect(recipientsOf('In 1 day: Only once for the client')).toEqual([emailOf(assigneeUid)]);

    await runSweep();
    expect(recipientsOf('In 1 day: Only once for the client')).toEqual([emailOf(assigneeUid)]);
    const { rows } = await testPool.query(
      'select sent_count from reminders where law_firm_id = $1 and event_id = $2',
      [firm.id, eventId],
    );
    expect(rows).toEqual([{ sent_count: 1 }]);
  });

  /**
   * Proves the sweep ran (the upcoming event is mailed) before asserting the
   * cancelled and completed ones were not. Goes red if the status filter is
   * dropped from the client read.
   */
  test('cancelled and completed client events send nothing', async () => {
    await seedClientEvent('Upcoming client meeting');
    await seedClientEvent('Cancelled client meeting', { status: 'cancelled' });
    await seedClientEvent('Completed client meeting', { status: 'completed' });

    await runSweep();

    expect(recipientsOf('In 1 day: Upcoming client meeting')).toEqual([emailOf(assigneeUid)]);
    expect(recipientsOf('In 1 day: Cancelled client meeting')).toEqual([]);
    expect(recipientsOf('In 1 day: Completed client meeting')).toEqual([]);
  });

  /** Goes red if the client sweep ignores the firm's reminder settings. */
  test('a firm with event reminders switched off gets no client event reminders', async () => {
    await testPool.query(
      `update law_firms set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1`,
      [firm.id, JSON.stringify({ matterEventReminders: { enabled: false } })],
    );
    await seedClientEvent('Muted client meeting');

    await runSweep();

    expect(recipientsOf('In 1 day: Muted client meeting')).toEqual([]);
  });
});

export {};
