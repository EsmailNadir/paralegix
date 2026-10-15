/**
 * Recipient claims are exercised against the real database. Gates prove that
 * overlapping sweeps contend, and expired leases permit crash recovery without
 * letting the old worker complete or release a newer worker's claim.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  sentEmails,
  freezeClockAt,
  unfreezeClock,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { rejectNextEmail } from '../support/email.mock';

const tasksRepo = require('../../src/modules/tasks/tasks.repository');
import { sendTaskReminders } from '../../src/modules/tasks/taskReminders.service';

let firm: Firm;
let taskId: string;
let assigneeUid: string;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  // The harness loads backend/.env, which sets DISABLE_ALL_REMINDER_EMAILS=true
  // so other suites don't accidentally mail out; this spec is specifically
  // about the reminder path, so it turns the kill switch off itself, the same
  // way tests/billing/invoiceReminders.test.ts and the matter-event race spec do.
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  freezeClockAt('2026-09-05T09:00:00-04:00');
  firm = await createFirm();
  const member = await createFirmMember(firm.id);
  assigneeUid = member.uid;

  taskId = randomUUID();
  // `freezeClockAt` only fakes the JS clock, not Postgres's own `current_date`,
  // so the due date is a literal matching the frozen "today" rather than
  // `current_date` (the real wall-clock day), or `daysUntilDue` would compute
  // a nonzero offset and the task would never qualify for a reminder at all.
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

  // The digest is enabled by default (`settings.defaults.ts`), and a digest
  // subscriber deliberately gets no separate per-task reminder (it is already
  // covered by the daily summary) - see `receivesDigest` in
  // `taskReminders.service.ts`. Opt this fixture's assignee out of the digest
  // so the claim path under test actually reaches a send.
  await testPool.query(
    `update users set preferences = '{"notifications":{"digest":{"enabled":false}}}'::jsonb, updated_at = now() where id = $1`,
    [assigneeUid],
  );
});

afterEach(() => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('task reminder claim collision (real concurrency)', () => {
  it('cannot claim another firm task or reclaim a successful recipient inside 24 hours', async () => {
    const other = await createFirm();
    expect(await tasksRepo.claimReminderSend(other.id, taskId, 'recipient')).toBeNull();
    const claim = await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient');
    expect(claim).not.toBeNull();
    expect(await tasksRepo.completeReminderSend(other.id, taskId, 'recipient', claim.token)).toBe(false);
    expect(await tasksRepo.completeReminderSend(firm.id, taskId, 'recipient', claim.token)).toBe(true);
    expect(await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient')).toBeNull();
    await testPool.query(
      `update task_reminder_deliveries set last_sent_at = now() - interval '25 hours' where task_id = $1`,
      [taskId],
    );
    const next = await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient');
    expect(next.sentCount).toBe(1);
    expect(next.id).toBe(claim.id);
  });
  it('does not re-remind a task whose legacy reminders row was stamped inside 24 hours', async () => {
    const legacy = await testPool.query(
      `insert into reminders (law_firm_id, task_id, last_sent_at, sent_count)
       values ($1, $2, now() - interval '1 hour', 1)`,
      [firm.id, taskId],
    );
    expect(legacy.rowCount).toBe(1);

    expect(await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient')).toBeNull();
    const swept = await sendTaskReminders(firm.id);
    expect(swept.sent).toBe(0);
    expect(sentEmails()).toHaveLength(0);

    // Paired with the older stamp: same fixture apart from the age, so the
    // refusal above is the 24 hour gate and not a broken task or recipient.
    await testPool.query(
      `update reminders set last_sent_at = now() - interval '25 hours' where task_id = $1`,
      [taskId],
    );
    expect(await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient')).not.toBeNull();
  });

  it('does not let a recent legacy reminders row of another task or firm gate this task', async () => {
    const otherTask = randomUUID();
    await testPool.query(
      `insert into tasks (id, law_firm_id, title, status, due_date) values ($1, $2, 'Other', 'open', '2026-09-05')`,
      [otherTask, firm.id],
    );
    const stamped = await testPool.query(
      `insert into reminders (law_firm_id, task_id, last_sent_at, sent_count) values ($1, $2, now(), 1)`,
      [firm.id, otherTask],
    );
    expect(stamped.rowCount).toBe(1);
    expect(await tasksRepo.claimReminderSend(firm.id, taskId, 'recipient')).not.toBeNull();
  });

  it('retries only the recipient whose delivery failed on the preceding pass', async () => {
    const second = await createFirmMember(firm.id);
    await testPool.query(
      'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
      [firm.id, taskId, second.uid],
    );
    await testPool.query(
      `update users set preferences = '{"notifications":{"digest":{"enabled":false}}}'::jsonb where id = $1`,
      [second.uid],
    );
    rejectNextEmail('Recipient delivery unavailable');
    const first = await sendTaskReminders(firm.id);
    expect(first.sent).toBe(1);
    expect(sentEmails()).toHaveLength(1);
    const successfulAddress = sentEmails()[0].to;
    const retry = await sendTaskReminders(firm.id);
    expect(retry.sent).toBe(1);
    expect(sentEmails()).toHaveLength(2);
    expect(sentEmails().filter((email) => email.to === successfulAddress)).toHaveLength(1);
    await sendTaskReminders(firm.id);
    expect(sentEmails()).toHaveLength(2);
  });
  it('two overlapping sweeps send exactly one reminder for the same task', async () => {
    const gate = gateMethod(tasksRepo, 'claimReminderSend');
    try {
      const passA = sendTaskReminders(firm.id);
      const passB = sendTaskReminders(firm.id);

      // Proof, not hope: both passes are genuinely paused inside the claim at
      // the same time before either is allowed to run its real UPDATE.
      await gate.arrived(2);
      gate.open();

      const [resultA, resultB] = await Promise.all([passA, passB]);
      await drainEvents();

      // Exactly one of the two overlapping sweeps won the claim and sent.
      expect(resultA.sent + resultB.sent).toBe(1);
      expect(resultA.skipped + resultB.skipped).toBe(1);
      expect(sentEmails()).toHaveLength(1);

      const { rows } = await testPool.query(
        `select sent_count as reminder_count, last_sent_at as last_reminder_sent_at
           from task_reminder_deliveries where task_id = $1`,
        [taskId],
      );
      // The claim increments once, not twice: a lost race that still landed
      // its own increment would double-count without necessarily double-mailing.
      expect(rows[0].reminder_count).toBe(1);
      expect(rows[0].last_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });

  it('recovers an expired recipient lease and fences the crashed worker from its replacement', async () => {
    const key = 'recipient-key';
    const claimed = await tasksRepo.claimReminderSend(firm.id, taskId, key);
    expect(claimed.token).toEqual(expect.any(String));

    // A live lease still belongs to the original worker.
    await testPool.query(
      `update task_reminder_deliveries set claim_expires_at = now() + interval '1 minute' where task_id = $1`,
      [taskId],
    );
    const tooSoon = await tasksRepo.claimReminderSend(firm.id, taskId, key);
    expect(tooSoon).toBeNull();

    // An expired lease can be reclaimed with a new fencing token.
    await testPool.query(
      `update task_reminder_deliveries set claim_expires_at = now() - interval '1 minute' where task_id = $1`,
      [taskId],
    );
    const recovered = await tasksRepo.claimReminderSend(firm.id, taskId, key);
    expect(recovered.token).not.toBe(claimed.token);
    expect(await tasksRepo.completeReminderSend(firm.id, taskId, key, claimed.token)).toBe(false);
    await tasksRepo.releaseReminderClaim(firm.id, taskId, key, claimed.token);
    expect(await tasksRepo.claimReminderSend(firm.id, taskId, key)).toBeNull();
    expect(await tasksRepo.completeReminderSend(firm.id, taskId, key, recovered.token)).toBe(true);
    expect(await tasksRepo.claimReminderSend(firm.id, taskId, key)).toBeNull();

    const { rows } = await testPool.query(`select sent_count as reminder_count from task_reminder_deliveries where task_id = $1`, [taskId]);
    // Only successful delivery increments the counter.
    expect(rows[0].reminder_count).toBe(1);
  });
});
