/**
 * `cleanupExpiredSessions` writes its whole batch of SESSION_EXPIRED audit rows
 * through `writeAuditEvents`, and it swallows a failure there:
 *
 *     .catch((err) => console.error('[audit] SESSION_EXPIRED batch failed:', err.message))
 *
 * So a broken batch INSERT does not fail the sweep, does not fail a route, and
 * does not fail any other spec. It silently stops recording that sessions
 * expired, in the one trail that gets rendered onto a signing certificate.
 * Nothing else in the suite calls that function, so this file is what turns red.
 *
 * The batch path is also the only multi-row statement in the signing module,
 * and it resolves each row's session from a token inside the statement. A
 * single-row spec would not exercise that at all, so both sessions below must
 * come back with their event.
 */
import { randomUUID } from 'crypto';
import { createFirm, ensureUser, testPool, type Firm } from '../support/setupInProcess';
import { installInMemoryBucket, inMemoryBucket } from '../support/inMemoryBucket';

const signingRoutes = require('../../src/modules/signatures/signing.routes');
const { writeAuditEvent, writeAuditEvents, AUDIT_EVENTS } = require('../../src/modules/signatures/audit');

let firm: Firm;

// Each expiry also sweeps the session's scratch prefix. The default GCS double
// throws by name, which the sweep logs and carries on from; a working bucket
// keeps that noise out of the run without changing what is under test.
beforeEach(async () => {
  installInMemoryBucket();
  firm = await createFirm();
  await ensureUser('sweep-creator-uid');
});

/**
 * A session already past its expiry, with one signer who never finished.
 *
 * Two days is deliberate. The sweep allows one hour past `expires_at`
 * (`SESSION_EXPIRY_GRACE_MS`) for clock skew and requests already in flight,
 * and it used to allow ten days, which left a session sitting in `in_progress`
 * for that long after it expired. Two days is inside the old window and outside
 * the new one, so this fixture is only swept by the corrected constant.
 */
async function seedExpiredSession(): Promise<string> {
  const token = `sess-expired-${randomUUID().slice(0, 12)}`;
  const { rows } = await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, created_by, status, routing_mode, file_name, expires_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'sweep-creator-uid', 'in_progress', 'sequential', 'Retainer.pdf',
             now() - interval '2 days')
     returning id`,
    [token, firm.id],
  );
  await testPool.query(
    `insert into signature_participants
       (id, session_id, law_firm_id, role_label, signing_order, delivery_method,
        name, email, status)
     values ($1, $2, $3, 'Signer', 1, 'email', 'Signer One', $4, 'active')`,
    [`part-${randomUUID().slice(0, 12)}`, rows[0].id, firm.id,
     `signer-${randomUUID().slice(0, 8)}@example.test`],
  );
  return token;
}

const expiryEvents = async () => {
  const { rows } = await testPool.query(
    `select s.token, e.law_firm_id, e.metadata
       from signature_audit_events e
       join signature_sessions s on s.id = e.session_id
      where e.event_type = 'session.expired' and e.law_firm_id = $1
      order by s.token`,
    [firm.id],
  );
  return rows;
};

describe('expiring open signing sessions', () => {
  it('records one audit event per session the sweep actually claimed', async () => {
    const first = await seedExpiredSession();
    const second = await seedExpiredSession();

    await signingRoutes.cleanupExpiredSessions();

    const events = await expiryEvents();
    expect(events.map((r: any) => r.token).sort()).toEqual([first, second].sort());
    // Both columns are NOT NULL on the table, so a row that reached it at all
    // carries them; what this pins is that the firm is the session's own and
    // not, say, the first row's copied across the batch.
    expect(events.every((r: any) => r.law_firm_id === firm.id)).toBe(true);
    expect(events.every((r: any) => typeof r.metadata?.expiredAt === 'string')).toBe(true);
  });

  it('leaves a session that is not yet expired alone', async () => {
    const { rows } = await testPool.query(
      `insert into signature_sessions
         (token, law_firm_id, source_id, created_by, status, routing_mode, file_name, expires_at)
       values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'sweep-creator-uid', 'in_progress', 'sequential', 'Later.pdf',
               now() + interval '2 days')
       returning id`,
      [`sess-live-${randomUUID().slice(0, 12)}`, firm.id],
    );

    await signingRoutes.cleanupExpiredSessions();

    expect(await expiryEvents()).toEqual([]);
    const { rows: after } = await testPool.query(
      'select status from signature_sessions where id = $1', [rows[0].id],
    );
    expect(after[0].status).toBe('in_progress');
  });

  it('writes nothing a second time when the sweep runs again', async () => {
    await seedExpiredSession();

    await signingRoutes.cleanupExpiredSessions();
    await signingRoutes.cleanupExpiredSessions();

    // `bulkExpireSessions` guards on status, so the second pass claims nothing.
    // A duplicate SESSION_EXPIRED row in a tamper-evident trail is an
    // evidentiary problem, not a cosmetic one.
    expect(await expiryEvents()).toHaveLength(1);
  });
});

/**
 * An audit write that reaches no session.
 *
 * Before the `session_id` cutover the foreign key on `session_token` rejected
 * the statement. The writes resolve the session inside the INSERT now, so an
 * unknown token simply matches no row and inserts nothing. Silence is the wrong
 * answer for a trail that gets rendered onto a signing certificate, so both
 * writers have to keep failing.
 */
describe('an audit event whose token names no session', () => {
  it('fails the single write rather than recording nothing', async () => {
    await expect(writeAuditEvent('sess-does-not-exist', AUDIT_EVENTS.SESSION_VIEWED))
      .rejects.toThrow(/no signing session/);
  });

  it('fails the batch write, naming how much of the trail is missing', async () => {
    const token = await seedExpiredSession();

    await expect(writeAuditEvents([
      { token, eventType: AUDIT_EVENTS.SESSION_EXPIRED },
      { token: 'sess-does-not-exist', eventType: AUDIT_EVENTS.SESSION_EXPIRED },
    ])).rejects.toThrow(/1 of 2 event\(s\) named no signing session/);
  });
});

describe('the expiry sweep is bounded', () => {
  it('never has more than eight workspace sweeps in flight', async () => {
    // Each expired session's workspace is a listing and a delete. Started all
    // at once, a batch of 500 is 500 concurrent storage calls from a request
    // sharing one vCPU with everything else.
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedExpiredSession();
    }
    const original = inMemoryBucket.getFiles;
    let active = 0;
    let peak = 0;
    const listing = jest.spyOn(inMemoryBucket, 'getFiles').mockImplementation(async (query: any) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      try {
        return await original(query);
      } finally {
        active -= 1;
      }
    });

    try {
      await signingRoutes.cleanupExpiredSessions();
    } finally {
      listing.mockRestore();
    }

    // Proved first: every session was swept, so a low peak is not a sweep that did nothing.
    expect(await expiryEvents()).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
