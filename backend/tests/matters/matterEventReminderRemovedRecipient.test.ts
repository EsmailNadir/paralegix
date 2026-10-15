/**
 * B08.2's matter-event sibling: a member removed from the firm who is still
 * referenced by a matter event's reminder recipients.
 *
 * `matterEventReminders.service.ts#resolveEventRecipients` resolves recipients
 * from `event_assignees` rows and, when that is
 * empty, from `events.created_by` - both routed through
 * `resolveUserInfo` (`shared/utils/reminderHelpers.ts`), which looks a uid up
 * in the global `users` table (then Firebase Auth) with NO check of current
 * firm membership. `matters.events.ts`'s `MEMBER_REMOVED` listener already
 * clears `task_assignees` and (as of this same tick) `tasks.reminder_recipient_ids`
 * for exactly this reason, but never touched the event assignees or
 * accounted for `created_by`. So a member removed from a firm who was an event
 * assignee, or the creator a reminder falls back to, kept receiving that
 * event's reminder emails (event title, type, date, matter name) indefinitely.
 *
 * Two distinct paths, two cases below:
 *   - assignees: the removed member has an event_assignees row -> must be
 *     stripped from the column (mirroring the tasks fix) so they never
 *     resolve as a recipient again.
 *   - created_by: the removed member authored the event and there is no (or
 *     no longer any) assignee, so `resolveEventRecipients` falls back to
 *     `createdBy`. Nulling `created_by` would destroy audit history other
 *     features rely on, so the fix has to be "don't treat a former member's
 *     created_by as a reminder recipient", proved by the admin fallback firing
 *     in their place instead.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  drainEvents,
  freezeClockAt,
  memberWith,
  ownerOf,
  sentEmails,
  testPool,
  unfreezeClock,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let colleague: Actor;
let matterId: string;
let previousKillSwitch: string | undefined;

const MEMBER_PATH = (lawFirmId: string, uid: string) => `/api/lawfirms/${lawFirmId}/members/${uid}`;

async function optOutOfDigest(uid: string) {
  await testPool.query(
    `update users set preferences = '{"notifications":{"digest":{"enabled":false}}}'::jsonb, updated_at = now() where id = $1`,
    [uid],
  );
}

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  freezeClockAt('2026-09-10T09:00:00-04:00');

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  colleague = await memberWith(firm.id, []);
  await optOutOfDigest(owner.uid);
  await optOutOfDigest(colleague.uid);

  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Reminder Matter', $3)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
  );
});

afterEach(() => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('matter event reminder recipient removed from the firm', () => {
  it('stops receiving assignee reminders once removed, and the stale assignee row is dropped', async () => {
    const eventId = randomUUID();
    // One day out, matching the service's default daysBefore = [1, 7].
    await testPool.query(
      `with e as (
         insert into events (id, law_firm_id, matter_id, title, type, status, date, created_by)
         values ($1, $2, $3, 'Hearing', 'hearing', 'upcoming', $4, $6)
       )
       insert into event_assignees (law_firm_id, event_id, user_id) values ($2, $1, $5)`,
      [eventId, firm.id, matterId, '2026-09-11T09:00:00-04:00', colleague.uid, owner.uid],
    );

    const removeRes = await owner.api.delete(MEMBER_PATH(firm.id, colleague.uid));
    expect(removeRes.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      `select coalesce(array_agg(user_id), '{}') as assigned_to
         from event_assignees where event_id = $1`,
      [eventId],
    );
    // The stale id must not survive the member's removal - left in place, it
    // is a standing leak of every future reminder for this event.
    expect(rows[0].assigned_to).not.toContain(colleague.uid);

    const { sendMatterEventReminders } = require('../../src/modules/matters/matterEventReminders.service');
    await sendMatterEventReminders(firm.id);
    await drainEvents();

    const recipients = sentEmails().flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]));
    expect(recipients).not.toContain(`${colleague.uid}@example.test`);
    // Proves the sweep actually ran and resolved a recipient (createdBy, the
    // still-current owner) rather than the assertion above passing because
    // nothing was sent to anyone.
    expect(recipients).toContain(`${owner.uid}@example.test`);
  });

  it('does not fall back to a removed creator, and still notifies the admin fallback instead', async () => {
    const eventId = randomUUID();
    await testPool.query(
      `insert into events
         (id, law_firm_id, matter_id, title, type, status, date, created_by)
       values ($1, $2, $3, 'Filing deadline', 'filing_deadline', 'upcoming', $4, $5)`,
      [eventId, firm.id, matterId, '2026-09-11T09:00:00-04:00', colleague.uid],
    );

    const removeRes = await owner.api.delete(MEMBER_PATH(firm.id, colleague.uid));
    expect(removeRes.status).toBe(200);
    await drainEvents();

    const { sendMatterEventReminders } = require('../../src/modules/matters/matterEventReminders.service');
    await sendMatterEventReminders(firm.id);
    await drainEvents();

    const recipients = sentEmails().flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]));
    // The removed member authored this event, but is no longer a member, so
    // their created_by must not resolve them as a recipient.
    expect(recipients).not.toContain(`${colleague.uid}@example.test`);
    // Proves recipients weren't just silently empty: the firm owner (the
    // admin fallback) picks it up instead.
    expect(recipients).toContain(`${owner.uid}@example.test`);
  });

  /**
   * The same leak on a STANDALONE CLIENT event, which went unfixed for longer
   * and for a structural reason.
   *
   * Client events carry the identical assignee rows and resolve
   * recipients the same membership-blind way, but until migration 0205 they
   * lived in `client_events`, a different table, and the `MEMBER_REMOVED`
   * listener only ever named `matter_events`. So the case above was fixed and
   * this one silently was not: a removed member stayed an assignee on every
   * standalone client event in the firm.
   *
   * Both parents now share one table, so the listener's single statement covers
   * both. Goes red if that statement is narrowed back to matter events -- by
   * adding a `matter_id is not null` predicate, or by splitting the tables again.
   */
  it('strips a removed member from a standalone CLIENT event too, not just a matter event', async () => {
    const clientId = (await createPersonClient(firm.id, { name: 'Standalone Client' })).id;
    const clientEventId = randomUUID();
    const matterEventId = randomUUID();

    await testPool.query(
      `with e as (
         insert into events (id, law_firm_id, client_id, title, type, status, date, created_by)
         values ($1, $2, $3, 'Client meeting', 'meeting', 'upcoming', $4, $6)
       )
       insert into event_assignees (law_firm_id, event_id, user_id) values ($2, $1, $5)`,
      [clientEventId, firm.id, clientId, '2026-09-11T09:00:00-04:00',
       colleague.uid, owner.uid],
    );
    // A matter event in the same firm, so a fix that somehow cleared everything
    // indiscriminately is still distinguishable from one that cleared nothing.
    await testPool.query(
      `with e as (
         insert into events (id, law_firm_id, matter_id, title, type, status, date, created_by)
         values ($1, $2, $3, 'Hearing', 'hearing', 'upcoming', $4, $6)
       )
       insert into event_assignees (law_firm_id, event_id, user_id)
       values ($2, $1, $5), ($2, $1, $6)`,
      [matterEventId, firm.id, matterId, '2026-09-11T09:00:00-04:00',
       colleague.uid, owner.uid],
    );

    const removeRes = await owner.api.delete(MEMBER_PATH(firm.id, colleague.uid));
    expect(removeRes.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      `select e.id, coalesce(array_agg(ea.user_id) filter (where ea.user_id is not null), '{}') as assigned_to
         from events e
         left join event_assignees ea on ea.event_id = e.id
        where e.id = any($1::uuid[])
        group by e.id
        order by e.id`,
      [[clientEventId, matterEventId]],
    );
    const byId = new Map(rows.map((r: any) => [r.id, r.assigned_to]));

    // The point of the test.
    expect(byId.get(clientEventId)).not.toContain(colleague.uid);
    // The matter event is cleared as well, which is the behaviour that already
    // worked; asserting it here is what proves the statement ran at all.
    expect(byId.get(matterEventId)).not.toContain(colleague.uid);
    // And it removed only the departing member. Without this an `assigned_to`
    // set to `[]` wholesale would pass both assertions above.
    expect(byId.get(matterEventId)).toContain(owner.uid);
  });
});

test('reminder sweeps continue beyond the calendar read ceiling', async () => {
  await testPool.query(`insert into events (id, law_firm_id, matter_id, title, type, status, date, created_by)
    select gen_random_uuid(), $1, $2, 'Old appointment', 'meeting', 'completed', '2026-09-10T12:00:00Z', $3 from generate_series(1, 5000)`, [firm.id, matterId, owner.uid]);
  await testPool.query(`insert into events (id, law_firm_id, matter_id, title, type, status, date, created_by)
    values (gen_random_uuid(), $1, $2, 'Beyond the first 5000', 'meeting', 'upcoming', '2026-09-11T12:00:00Z', $3)`, [firm.id, matterId, owner.uid]);
  const { sendMatterEventReminders } = require('../../src/modules/matters/matterEventReminders.service');
  const result = await sendMatterEventReminders(firm.id);
  expect(result.errors).toBe(0);
  expect(sentEmails().some((mail) => mail.subject.includes('Beyond the first 5000'))).toBe(true);
});
