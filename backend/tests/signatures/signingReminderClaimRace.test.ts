/**
 * B08.1 J03/J07: signing reminders' claim collision, proved with a REAL race.
 *
 * `signingReminders.service.ts` used to read a batch of candidate sessions via
 * `listReminderCandidates`, decide in JS whether a participant was due a
 * reminder, send it, and only THEN stamp the send time via
 * `updateParticipant`. That is a check-then-act: two overlapping cron sweeps
 * both read the same participant before either had written the stamp, so both
 * would send the same "please sign" nudge. Task reminders and matter-event
 * reminders already close this hole with an atomic claim (`claimReminderSend`,
 * a single upsert-claim whose WHERE holds the window on the reminders row)
 * before sending; signing reminders had no equivalent.
 *
 * This spec adds the same claim to `signatures.repository.ts` and wires it
 * into `signingReminders.service.ts` (mirroring `matterEventReminderClaimRace
 * .test.ts`'s technique exactly: a gate proves genuine overlap instead of
 * hoping `Promise.all` interleaves two async calls). Before the fix this test
 * fails with two emails sent and the send count at 2; after the fix, exactly
 * one sweep wins.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ensureUser,
  drainEvents,
  sentEmails,
  freezeClockAt,
  unfreezeClock,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const signaturesRepo = require('../../src/modules/signatures/signatures.repository');
import { sendSigningReminders } from '../../src/modules/signatures/signingReminders.service';
import { sessionKeysSql } from '../support/factories';

let firm: Firm;
let sessionToken: string;
let participantId: string;
let previousKillSwitch: string | undefined;

/**
 * `listReminderCandidates`'s day window runs against Postgres's own `now()`,
 * and the service re-checks the exact day count against the real JS clock
 * too, so this fixture anchors to actual wall-clock time (matching
 * `signingReminderCandidates.repository.test.ts`) rather than a frozen clock.
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  firm = await createFirm();

  sessionToken = `sess-${randomUUID().slice(0, 12)}`;
  await ensureUser('creator-uid');
  await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, created_by, status, routing_mode, file_name, created_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'creator-uid', 'in_progress', 'parallel', 'Engagement.pdf', now())`,
    [sessionToken, firm.id],
  );

  participantId = `part-${randomUUID().slice(0, 12)}`;
  await testPool.query(
    `insert into signature_participants
       (id, session_id, law_firm_id, role_label, signing_order, delivery_method, name, email,
        status, started_at)
     values ($1, ${sessionKeysSql('$2')}, 'Signer', 1, 'email', 'Signer One', $3, 'active', $4)`,
    [participantId, sessionToken, `signer-${participantId}@example.test`, daysAgo(1)],
  );
});

afterEach(async () => {
  unfreezeClock();
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('signing reminder claim collision (real concurrency)', () => {
  it('two overlapping sweeps send exactly one reminder for the same participant', async () => {
    const gate = gateMethod(signaturesRepo, 'claimReminderSend');
    try {
      const passA = sendSigningReminders();
      const passB = sendSigningReminders();

      // Proof, not hope: both passes are genuinely paused inside the claim at
      // the same time before either runs its real UPDATE.
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
           from reminders where signature_participant_id = $1`,
        [participantId],
      );
      // The claim increments once, not twice: a lost race that still landed
      // its own increment would double-count without necessarily double-mailing.
      expect(rows[0].reminder_count).toBe(1);
      expect(rows[0].last_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });

  it('a worker that dies right after claiming leaves the participant unreminded until the 24h window passes, then recovers', async () => {
    // Simulates a crash: the claim (the only atomic write) lands, but the
    // process dies before it can send or release. Nothing else in the code
    // can distinguish "still sending" from "crashed", so the 24h window IS
    // the lease. Before it elapses, a second worker must NOT re-claim (that
    // would risk a double-send if the first process were merely slow rather
    // than dead); once it elapses, recovery must actually happen rather than
    // the row being stuck forever.
    const claimed = await signaturesRepo.claimReminderSend(sessionToken, participantId);
    expect(claimed).toBe(true);

    freezeClockAt(new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString());
    const tooSoon = await signaturesRepo.claimReminderSend(sessionToken, participantId);
    expect(tooSoon).toBe(false);
    unfreezeClock();

    // `claimReminderSend`'s window is evaluated by Postgres's own `now()`, not
    // the JS clock, so recovery is proved by moving the real row's stamp back
    // rather than freezing time.
    await testPool.query(
      `update reminders set last_sent_at = now() - interval '25 hours' where signature_participant_id = $1`,
      [participantId],
    );
    const recovered = await signaturesRepo.claimReminderSend(sessionToken, participantId);
    expect(recovered).toBe(true);

    const { rows } = await testPool.query(
      `select sent_count as reminder_count from reminders where signature_participant_id = $1`,
      [participantId],
    );
    // Two successful claims (the original "crash" and the recovery); the
    // rejected too-soon attempt must not have incremented anything.
    expect(rows[0].reminder_count).toBe(2);
  });
});
