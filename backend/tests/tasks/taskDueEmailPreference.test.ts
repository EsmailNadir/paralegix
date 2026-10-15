/**
 * TASK_DUE: the assignee's own "email me when a task is due" preference,
 * proved against the REAL reminder sweep and the REAL settings route.
 *
 * `tests/tasks/taskReminders.service.test.ts` mocks `emailPreferences`
 * wholesale (see its `jest.mock('../../src/shared/services/emailPreferences'
 * , ...)`), so every case there proves the service's branching on whatever
 * `resolveUserCategory` was told to return, never that a real
 * `POST /api/settings/user` write actually reaches that branch. This file
 * does not mock `emailPreferences`, `tasks.repository`, or `emailService` at
 * all: `sendTaskReminders` runs for real against a real due task and a real
 * `user_settings` row, the same technique
 * `tests/tasks/taskReminderClaimRace.test.ts` uses for the claim itself.
 *
 * FINDING: `notifications.email.taskDue` has real, correct backend wiring
 * (confirmed below: default-on, off suppresses, back on restores), but grep
 * across `frontend/src/app/lawfirm/` and `frontend/src/components/` for
 * `notifications.email` / `taskDue` finds no UI control anywhere. The
 * Settings > Notifications page only exposes in-app category toggles
 * (`InAppNotificationPrefs`); there is no page for the EMAIL half of a firm
 * member's own preferences at all. A firm member can never turn this off
 * through the product - only directly through the settings API, which is
 * what this test uses.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  recipientsOf,
  freezeClockAt,
  unfreezeClock,
  as,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';
import { sendTaskReminders } from '../../src/modules/tasks/taskReminders.service';

let firm: Firm;
let taskId: string;
let assigneeUid: string;
let assigneeEmail: string;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  // Same kill-switch handling as taskReminderClaimRace.test.ts: the harness's
  // .env disables all reminder email sends by default so other suites can't
  // mail out by accident.
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  freezeClockAt('2026-09-05T09:00:00-04:00');
  firm = await createFirm();
  const member = await createFirmMember(firm.id);
  assigneeUid = member.uid;
  assigneeEmail = `${assigneeUid}@example.test`;

  taskId = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, due_date)
     values ($1, $2, 'File response', 'open', '2026-09-05')`,
    [taskId, firm.id],
  );
  await testPool.query(
    `insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
    [taskId, assigneeUid],
  );

  // A digest subscriber gets no separate per-task reminder (receivesDigest in
  // taskReminders.service.ts), so opt out to make sure this test reaches the
  // TASK_DUE branch under test rather than being skipped for that reason.
  await testPool.query(
    `update users set preferences = '{"notifications":{"digest":{"enabled":false}}}'::jsonb, updated_at = now() where id = $1`,
    [assigneeUid],
  );
});

afterEach(() => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('the task-due reminder email', () => {
  it('sends by default', async () => {
    const result = await sendTaskReminders(firm.id);
    await drainEvents();

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(recipientsOf(/File response/)).toContain(assigneeEmail);
  });

  it('is suppressed once the assignee turns off "email me when a task is due"', async () => {
    const off = await testPool.query(
      `update users set preferences = '{"notifications":{"digest":{"enabled":false},"email":{"taskDue":false}}}'::jsonb, updated_at = now() where id = $1`,
      [assigneeUid],
    );
    expect(off.rowCount).toBe(1);

    await sendTaskReminders(firm.id);
    await drainEvents();

    expect(recipientsOf(/File response/)).not.toContain(assigneeEmail);
  });

  it('restores once the assignee turns it back on', async () => {
    await testPool.query(
      `update users
          set preferences = jsonb_set(preferences, '{notifications,email,taskDue}', 'false'::jsonb)
        where id = $1`,
      [assigneeUid],
    );
    await testPool.query(
      `update users
          set preferences = jsonb_set(preferences, '{notifications,email,taskDue}', 'true'::jsonb)
        where id = $1`,
      [assigneeUid],
    );

    await sendTaskReminders(firm.id);
    await drainEvents();

    expect(recipientsOf(/File response/)).toContain(assigneeEmail);
  });
});

describe('the real settings route actually reaches the same preference row', () => {
  it('POST /api/settings/user writes notifications.email.taskDue, and the reminder sweep honours it', async () => {
    const assignee = as(tokenFor({ uid: assigneeUid }));

    const write = await assignee.post(`/api/settings/user?lawFirmId=${firm.id}`)
      .send({ preferences: { notifications: { email: { taskDue: false } } } });
    expect(write.status).toBe(200);

    await sendTaskReminders(firm.id);
    await drainEvents();

    expect(recipientsOf(/File response/)).not.toContain(assigneeEmail);
  });
});
