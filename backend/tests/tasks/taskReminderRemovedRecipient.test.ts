/**
 * B08.2 task reminders: an explicit reminder recipient who is later removed
 * from the firm.
 *
 * `taskReminders.service.ts#sendTaskReminders` reads `task.reminderRecipientIds`
 * - a plain `text[]` column a firm member sets on a task to be pinged about its
 * due date regardless of assignment - and resolves each id straight through
 * `resolveUserInfo` (`shared/utils/reminderHelpers.ts`), which looks the uid up
 * in the global `users` table (and, failing that, Firebase Auth) with NO
 * membership check at all. `matters.events.ts`'s `MEMBER_REMOVED` listener
 * already knows this matters for `task_assignees` - its own comment says
 * removing those rows is specifically so a removed member stops "receiving
 * reminders" - but it clears only that junction table. `tasks.reminder_recipient_ids`
 * is a separate column the same listener never touches, so a former team
 * member explicitly added as a reminder recipient keeps receiving due-date
 * emails - carrying the task title, due date and matter name - indefinitely
 * after their access to the firm ends.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  drainEvents,
  sentEmails,
  freezeClockAt,
  unfreezeClock,
  type Firm,
  type Actor,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let colleague: Actor;
let taskId: string;
let previousKillSwitch: string | undefined;

const MEMBER_PATH = (lawFirmId: string, uid: string) => `/api/lawfirms/${lawFirmId}/members/${uid}`;

beforeEach(async () => {
  // Reminder sends are killed by default in the test env (backend/.env);
  // this spec is specifically about who receives one, so turn the switch off
  // the same way the existing claim-race specs do.
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  freezeClockAt('2026-09-10T09:00:00-04:00');

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  colleague = await memberWith(firm.id, []);

  taskId = randomUUID();
  // Due "today" against the frozen clock, unassigned, with the colleague set
  // as an explicit reminder recipient - the path `reminderRecipientIds` exists
  // for (someone who wants updates regardless of who the task is assigned to).
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, due_date, reminder_recipient_ids)
     values ($1, $2, 'File response', 'open', '2026-09-10', $3)`,
    [taskId, firm.id, [colleague.uid]],
  );

  // Absent preferences resolve to "enabled" (see emailPreferences.ts), but be
  // explicit rather than resting on that default: opt the colleague out of the
  // digest so a real send is not silently swallowed for an unrelated reason.
  await testPool.query(
    `update users set preferences = '{"notifications":{"digest":{"enabled":false}}}'::jsonb, updated_at = now() where id = $1`,
    [colleague.uid],
  );
});

afterEach(() => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('task reminder explicit recipient removed from the firm', () => {
  it('stops receiving due-date reminders once removed, and the stale id is dropped from the task', async () => {
    // Removed for real, through the same route membersServiceOps.test.ts drives -
    // this proves the production MEMBER_REMOVED cascade, not a hand-rolled event.
    const removeRes = await owner.api.delete(MEMBER_PATH(firm.id, colleague.uid));
    expect(removeRes.status).toBe(200);
    await drainEvents();

    const { rows: taskRows } = await testPool.query(
      `select reminder_recipient_ids from tasks where id = $1`,
      [taskId],
    );
    // The stale id must not survive the member's removal - left in place, it
    // is a standing leak of every future due-date reminder for this task.
    expect(taskRows[0].reminder_recipient_ids).not.toContain(colleague.uid);

    const { sendTaskReminders } = require('../../src/modules/tasks/taskReminders.service');
    await sendTaskReminders(firm.id);
    await drainEvents();

    const recipients = sentEmails().flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]));
    expect(recipients).not.toContain(`${colleague.uid}@example.test`);
  });
});
