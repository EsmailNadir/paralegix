/**
 * B08.2: signing reminders' "sequential turn not reached", proved against the
 * real SQL, not a mocked repository return.
 *
 * `signingReminders.service.test.ts` covers the service branch for "no active
 * participant" entirely through a mocked `getActiveParticipant` and a mocked
 * `listReminderCandidates`, so it proves the SERVICE handles a null active
 * participant correctly but proves nothing about whether the real query in
 * `signatures.repository.ts#listReminderCandidates` actually filters a waiting
 * (not-yet-their-turn) participant out in the first place. That repository
 * function is never once called against a real database anywhere else in the
 * suite (confirmed by grep before writing this).
 *
 * `listReminderCandidates` INNER JOINs to `signature_participants` on
 * `status = 'active'`, so a sequential session where the next signer's turn
 * has not been reached yet (their row is still 'waiting') must never surface a
 * session on their behalf, even if their `started_at`/day-count would
 * otherwise land inside the 1/3/5-day reminder window. This is the exact
 * mechanism that keeps a sequential co-signer from getting a "please sign"
 * nudge before the person ahead of them has finished.
 */
import { randomUUID } from 'crypto';
import { testPool, createFirm, ensureUser, type Firm } from '../support/setupInProcess';
import { sessionKeysSql } from '../support/factories';

const repo = require('../../src/modules/signatures/signatures.repository');

let firm: Firm;

/**
 * `listReminderCandidates`'s day math runs entirely in SQL against Postgres's
 * own `now()`, not the JS clock, so fixtures anchor to the real wall clock at
 * test time (`freezeClockAt` would only move `Date.now()`, leaving the SQL
 * side unaffected and the two out of sync).
 */
const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

interface SessionSeed {
  status?: string;
  routingMode?: 'sequential' | 'parallel';
}

interface ParticipantSeed {
  order: number;
  status: 'active' | 'waiting' | 'completed';
  startedAt?: string | null;
  lastReminderSentAt?: string | null;
}

async function seedSession(seed: SessionSeed = {}): Promise<string> {
  const token = `sess-${randomUUID().slice(0, 12)}`;
  await ensureUser('creator-uid');
  await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, created_by, status, routing_mode, file_name, created_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'creator-uid', $3, $4, 'Retainer.pdf', now())`,
    [token, firm.id, seed.status ?? 'in_progress', seed.routingMode ?? 'sequential'],
  );
  return token;
}

async function seedParticipant(sessionToken: string, seed: ParticipantSeed): Promise<string> {
  const id = `part-${randomUUID().slice(0, 12)}`;
  await testPool.query(
    `insert into signature_participants
       (id, session_id, law_firm_id, role_label, signing_order, delivery_method, name, email,
        status, started_at)
     values ($1, ${sessionKeysSql('$2')}, 'Signer', $3, 'email', $4, $5, $6, $7)`,
    [
      id, sessionToken, seed.order, `Signer ${seed.order}`, `signer${seed.order}-${id}@example.test`,
      seed.status, seed.startedAt ?? null,
    ],
  );
  // The "reminded within 24h" filter reads the shared reminders row now.
  if (seed.lastReminderSentAt) {
    await testPool.query(
      `insert into reminders (law_firm_id, signature_participant_id, last_sent_at, sent_count)
       select p.law_firm_id, p.id, $2, 1 from signature_participants p where p.id = $1`,
      [id, seed.lastReminderSentAt],
    );
  }
  return id;
}

const candidateTokens = async () => (await repo.listReminderCandidates()).map((s: any) => s.token);

beforeEach(async () => {
  firm = await createFirm();
});

describe('listReminderCandidates: sequential turn not reached', () => {
  it('excludes a session whose only day-eligible participant has not been activated', async () => {
    // p1 already signed. p2 is next in the sequential order but their row is
    // still 'waiting' - the flow has not (yet) flipped them to 'active'. Their
    // started_at is stamped 3 days back specifically so that, if the JOIN's
    // status filter were ever weakened or dropped, the day-window math alone
    // would make them look eligible.
    const token = await seedSession();
    await seedParticipant(token, { order: 1, status: 'completed', startedAt: daysAgoIso(4) });
    await seedParticipant(token, { order: 2, status: 'waiting', startedAt: daysAgoIso(3) });

    expect(await candidateTokens()).not.toContain(token);
  });

  it('includes the same session once that participant is actually activated', async () => {
    // Positive control: identical shape, only the status flips to 'active'.
    // Proves the exclusion above is about the turn not being reached, not
    // about some other property of the fixture (a missing token row, say)
    // that would exclude it regardless of status.
    const token = await seedSession();
    await seedParticipant(token, { order: 1, status: 'completed', startedAt: daysAgoIso(4) });
    await seedParticipant(token, { order: 2, status: 'active', startedAt: daysAgoIso(3) });

    const candidates = await repo.listReminderCandidates();
    const match = candidates.find((s: any) => s.token === token);
    expect(match).toBeDefined();
    // The waiting-turned-active participant is the one the reminder cron would
    // act on; the already-completed one must not be mistaken for it.
    const active = match.participants.find((p: any) => p.status === 'active');
    expect(active.order).toBe(2);
  });

  it('excludes a fully-waiting parallel session with nobody active yet', async () => {
    // Belt-and-suspenders: even outside strict sequential routing, a session
    // where NO participant has been activated must never appear, regardless
    // of how long ago the participant rows themselves were created.
    const token = await seedSession({ routingMode: 'parallel' });
    await seedParticipant(token, { order: 1, status: 'waiting', startedAt: daysAgoIso(3) });
    await seedParticipant(token, { order: 2, status: 'waiting', startedAt: daysAgoIso(3) });

    expect(await candidateTokens()).not.toContain(token);
  });
});
