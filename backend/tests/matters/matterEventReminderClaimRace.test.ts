/**
 * B08.2: matter-event reminders' claim-collision, proved with a REAL race.
 *
 * `matterEventReminders.service.ts` reads a batch of events, then for each one
 * calls `matterEventsRepo.claimReminderSend` before sending, specifically so
 * that two overlapping cron sweeps cannot both decide to mail the same
 * recipient twice (see the comment above the call site: "the check above is a
 * read, and 'send then stamp' lets two overlapping sweeps both pass it and
 * mail the same recipient twice"). `claimReminderSend` moves the guard into a
 * single atomic upsert-claim whose WHERE holds the window (`last_sent_at IS
 * NULL OR < cutoff`) on the shared `reminders` row.
 *
 * That claim is exercised everywhere else in the suite only through a mocked
 * boolean return (`tests/matters/matterEventReminders.service.test.ts`), which
 * proves the SERVICE branches correctly on true/false but proves nothing about
 * whether the underlying SQL is actually race-safe against two REAL concurrent
 * writers. This file drives two full service passes against the same row and
 * uses a gate to prove they overlap at the claim, rather than hoping
 * `Promise.all` interleaves them.
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

const matterEventsRepo = require('../../src/modules/matters/matterEvents.repository');
import { sendMatterEventReminders } from '../../src/modules/matters/matterEventReminders.service';

let firm: Firm;
let matterId: string;
let eventId: string;
let assigneeUid: string;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  // The harness loads backend/.env, which sets DISABLE_ALL_REMINDER_EMAILS=true
  // so other suites don't accidentally mail out. This spec is specifically
  // about the reminder path, so it has to turn the kill switch off itself, the
  // same way tests/billing/invoiceReminders.test.ts does.
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  freezeClockAt('2026-09-05T09:00:00-04:00');
  firm = await createFirm();
  const member = await createFirmMember(firm.id);
  assigneeUid = member.uid;

  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Race Matter', $3)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
  );

  eventId = randomUUID();
  // One day out, matching the service's default daysBefore = [1, 7].
  await testPool.query(
    `with e as (
       insert into events (id, law_firm_id, matter_id, title, type, status, date)
       values ($1, $2, $3, 'Hearing', 'hearing', 'upcoming', $4)
     )
     insert into event_assignees (law_firm_id, event_id, user_id) values ($2, $1, $5)`,
    [eventId, firm.id, matterId, '2026-09-06T09:00:00-04:00', assigneeUid],
  );
});

afterEach(() => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('matter event reminder worker-death recovery (J07)', () => {
  it('a worker that dies right after claiming blocks a premature reclaim, then recovers once the 24h window elapses', async () => {
    // B08.1 J07: this file already proves J03 (two genuinely overlapping
    // sweeps) above. J07 is a distinct scenario the plan calls out
    // separately: a worker that claims and then dies before sending or
    // releasing, rather than two workers racing live. Nothing in the code can
    // tell "still sending" apart from "crashed", so the 24h claim window IS
    // the lease. This proves both edges of it: no premature reclaim (which
    // would risk a double-send if the original caller were merely slow, not
    // dead) and no permanently-stuck row once the window elapses.
    const claimed = await matterEventsRepo.claimReminderSend(firm.id, matterId, eventId);
    expect(claimed).toBe(true);

    await testPool.query(
      `update reminders set last_sent_at = now() - interval '23 hours' where event_id = $1`,
      [eventId],
    );
    const tooSoon = await matterEventsRepo.claimReminderSend(firm.id, matterId, eventId);
    expect(tooSoon).toBe(false);

    await testPool.query(
      `update reminders set last_sent_at = now() - interval '25 hours' where event_id = $1`,
      [eventId],
    );
    const recovered = await matterEventsRepo.claimReminderSend(firm.id, matterId, eventId);
    expect(recovered).toBe(true);

    const { rows } = await testPool.query(
      `select sent_count as reminder_count from reminders where event_id = $1`,
      [eventId],
    );
    // Two successful claims (the original "crash" and the recovery); the
    // rejected too-soon attempt must not have incremented anything.
    expect(rows[0].reminder_count).toBe(2);
  });
});

describe('matter event reminder claim collision (real concurrency)', () => {
  it('two overlapping sweeps send exactly one reminder for the same event', async () => {
    const gate = gateMethod(matterEventsRepo, 'claimReminderSend');
    try {
      const passA = sendMatterEventReminders(firm.id);
      const passB = sendMatterEventReminders(firm.id);

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
           from reminders where event_id = $1`,
        [eventId],
      );
      // The claim increments once, not twice: a lost race that still landed its
      // own increment would double-count without necessarily double-mailing.
      expect(rows[0].reminder_count).toBe(1);
      expect(rows[0].last_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });
});
