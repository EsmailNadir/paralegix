/**
 * RLS policy tests for signature_sessions and signature_participants.
 *
 * Policies:
 *   signature_sessions:      rls_is_firm_member(law_firm_id, sub)
 *   signature_participants:  client_user_id = sub OR member_user_id = sub
 *                            OR firm member via session's law_firm_id
 *
 * A client sees only their own participant rows. A firm member sees all
 * participants in sessions belonging to their firm. Another firm's sessions
 * and participants are invisible.
 */
import { randomUUID } from 'crypto';
import { createFirm, testPool } from '../support/setupInProcess';
import { createFirmMember, ensureUser } from '../support/factories';
import { attemptUnderRls, withRlsIdentity } from '../support/rlsSession';
import { sessionKeysSql } from '../support/factories';

describe('RLS: signatures', () => {
  describe('R06: signature_sessions — firm membership controls visibility', () => {
    it('firm member sees own firm sessions; other firm and non-member do not', async () => {
      const firmX = await createFirm();
      const firmY = await createFirm();
      const memX = await createFirmMember(firmX.id, { uid: 'memX-sig' });
      const memY = await createFirmMember(firmY.id, { uid: 'memY-sig' });

      const tokenX = `session-${randomUUID().slice(0, 8)}`;
      const tokenY = `session-${randomUUID().slice(0, 8)}`;

      await testPool.query(`
        INSERT INTO signature_sessions (token, law_firm_id, source_id, created_by, status, created_at, updated_at)
        VALUES
          ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', now(), now()),
          ($4, $5, (select id from signature_sources where law_firm_id = $5 order by created_at limit 1), $6, 'pending', now(), now())
      `, [tokenX, firmX.id, memX.uid, tokenY, firmY.id, memY.uid]);

      // Firm X member sees only firm X session
      await withRlsIdentity(memX.uid, async (client) => {
        const { rows } = await client.query('SELECT token FROM signature_sessions ORDER BY token');
        expect(rows).toHaveLength(1);
        expect(rows[0].token).toBe(tokenX);
      });

      // Firm Y member sees only firm Y session
      await withRlsIdentity(memY.uid, async (client) => {
        const { rows } = await client.query('SELECT token FROM signature_sessions ORDER BY token');
        expect(rows).toHaveLength(1);
        expect(rows[0].token).toBe(tokenY);
      });

      // Client (not a firm member) sees no sessions
      await withRlsIdentity('client-no-sessions', async (client) => {
        const { rows } = await client.query('SELECT token FROM signature_sessions');
        expect(rows).toEqual([]);
      });

      // Stranger sees nothing
      await withRlsIdentity('stranger-sig', async (client) => {
        const { rows } = await client.query('SELECT token FROM signature_sessions');
        expect(rows).toEqual([]);
      });
    });

    it('a client who IS a signature_participant on the session still cannot see the session row: portal participation is not firm membership', async () => {
      // signature_sessions_select is `rls_is_firm_member(law_firm_id, sub)` only
      // (schema.sql). It does not consult signature_participants at all, so being
      // a named signer on a session must not be confused with being a member of
      // the firm that owns it - the two grants are checked by different policies
      // on different tables, and this proves neither leaks into the other.
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-portal-vs-member' });
      const clientSigner = 'client-portal-vs-member';
      // signature_participants.client_user_id is a real key to users (0224).
      await ensureUser(clientSigner);

      const sessionToken = `session-portal-${randomUUID().slice(0, 8)}`;
      await testPool.query(`
        INSERT INTO signature_sessions (token, law_firm_id, source_id, created_by, status, created_at, updated_at)
        VALUES ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', now(), now())
      `, [sessionToken, firm.id, mem.uid]);

      const { rows: seeded } = await testPool.query(`
        INSERT INTO signature_participants (id, session_id, law_firm_id, name, email, client_user_id)
        VALUES ($1, ${sessionKeysSql('$2')}, 'Portal Client', 'portal@test.com', $3)
        RETURNING session_id
      `, [randomUUID(), sessionToken, clientSigner]);
      const sessionId = seeded[0].session_id;

      // The client CAN see their own participant row (client_user_id = sub).
      // The session's uuid is read here rather than looked up inside the query:
      // this identity cannot read `signature_sessions` at all, which is the very
      // next assertion, so a subquery there would answer nothing and the row
      // would look invisible for the wrong reason.
      await withRlsIdentity(clientSigner, async (client) => {
        const { rows } = await client.query(
          'SELECT name FROM signature_participants WHERE session_id = $1',
          [sessionId],
        );
        expect(rows).toEqual([{ name: 'Portal Client' }]);
      });

      // But the SAME client cannot see the signature_sessions row that
      // participant row belongs to - only firm membership grants that, and this
      // client is a signer, not a firm member.
      await withRlsIdentity(clientSigner, async (client) => {
        const { rows } = await client.query(
          'SELECT token FROM signature_sessions WHERE token = $1',
          [sessionToken],
        );
        expect(rows).toEqual([]);
      });
    });
  });

  describe('R07: signature_participants — identity and firm-based visibility', () => {
    it('client sees own participant rows; firm member sees all in their firm', async () => {
      const firmX = await createFirm();
      const firmY = await createFirm();
      const memX = await createFirmMember(firmX.id, { uid: 'memX-sigpart' });
      const memX2 = await createFirmMember(firmX.id, { uid: 'memX2-sigpart' });
      const memY = await createFirmMember(firmY.id, { uid: 'memY-sigpart' });

      const clientA = 'clientA-sigpart';
      const clientB = 'clientB-sigpart';
      for (const uid of [clientA, clientB]) await ensureUser(uid);

      const tokenX = `session-part-${randomUUID().slice(0, 8)}`;
      const tokenY = `session-part-y-${randomUUID().slice(0, 8)}`;

      await testPool.query(`
        INSERT INTO signature_sessions (token, law_firm_id, source_id, created_by, status, created_at, updated_at)
        VALUES
          ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', now(), now()),
          ($4, $5, (select id from signature_sources where law_firm_id = $5 order by created_at limit 1), $6, 'pending', now(), now())
      `, [tokenX, firmX.id, memX.uid, tokenY, firmY.id, memY.uid]);

      const partIdA = randomUUID();
      const partIdB = randomUUID();
      const partIdX2 = randomUUID();
      const partIdAinY = randomUUID();

      await testPool.query(`
        INSERT INTO signature_participants (id, session_id, law_firm_id, name, email, client_user_id, member_user_id)
        VALUES
          ($1, ${sessionKeysSql('$5')}, 'Client A', 'a@test.com', $7, null),
          ($2, ${sessionKeysSql('$5')}, 'Client B', 'b@test.com', $8, null),
          ($3, ${sessionKeysSql('$5')}, 'Member X2', 'mx2@test.com', null, $9),
          ($4, ${sessionKeysSql('$6')}, 'Client A in Y', 'a@test.com', $7, null)
      `, [partIdA, partIdB, partIdX2, partIdAinY, tokenX, tokenY, clientA, clientB, memX2.uid]);

      // Firm X member (memX) sees all participants in firm X sessions via firm membership
      await withRlsIdentity(memX.uid, async (client) => {
        const { rows } = await client.query('SELECT name FROM signature_participants ORDER BY name');
        expect(rows).toEqual([
          { name: 'Client A' },
          { name: 'Client B' },
          { name: 'Member X2' },
        ]);
      });

      // memX2 (direct participant AND firm member) sees the same
      await withRlsIdentity(memX2.uid, async (client) => {
        const { rows } = await client.query('SELECT name FROM signature_participants ORDER BY name');
        // Sees firm X participants (via membership) plus own participant row
        expect(rows).toEqual([
          { name: 'Client A' },
          { name: 'Client B' },
          { name: 'Member X2' },
        ]);
      });

      // Client A sees only rows where client_user_id matches (across all sessions)
      await withRlsIdentity(clientA, async (client) => {
        const { rows } = await client.query('SELECT name FROM signature_participants ORDER BY name');
        expect(rows).toEqual([
          { name: 'Client A' },
          { name: 'Client A in Y' },
        ]);
      });

      // Client B sees only their own participant row
      await withRlsIdentity(clientB, async (client) => {
        const { rows } = await client.query('SELECT name FROM signature_participants ORDER BY name');
        expect(rows).toEqual([{ name: 'Client B' }]);
      });

      // Firm Y member sees only firm Y participants
      await withRlsIdentity(memY.uid, async (client) => {
        const { rows } = await client.query('SELECT name FROM signature_participants ORDER BY name');
        expect(rows).toEqual([{ name: 'Client A in Y' }]);
      });

      // Stranger sees nothing
      await withRlsIdentity('stranger-sigpart', async (client) => {
        const { rows: sessions } = await client.query('SELECT token FROM signature_sessions');
        expect(sessions).toEqual([]);
        const { rows: participants } = await client.query('SELECT name FROM signature_participants');
        expect(participants).toEqual([]);
      });
    });
  });

  describe('R08: INSERT/UPDATE/DELETE denied on signature tables', () => {
    // Only SELECT is granted to `authenticated` on both tables (schema.sql).
    // Each verb is an independently grantable privilege, so a migration that
    // accidentally adds UPDATE or DELETE without touching INSERT would pass an
    // INSERT-only check. Every verb is exercised here, each in its own
    // savepoint so a refusal reports its own reason rather than "current
    // transaction is aborted", with a positive control proving the targeted
    // rows actually existed and survived untouched.
    it('authenticated role cannot mutate signature_sessions or signature_participants', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-write-sig' });

      const sessionToken = `session-write-${randomUUID().slice(0, 8)}`;
      await testPool.query(`
        INSERT INTO signature_sessions (token, law_firm_id, source_id, created_by, status, created_at, updated_at)
        VALUES ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', now(), now())
      `, [sessionToken, firm.id, mem.uid]);

      const participantId = randomUUID();
      await testPool.query(`
        INSERT INTO signature_participants (id, session_id, law_firm_id, name, email)
        VALUES ($1, ${sessionKeysSql('$2')}, 'Original Name', 'orig@test.com')
      `, [participantId, sessionToken]);

      await withRlsIdentity(mem.uid, async (client) => {
        const insertedSession = await attemptUnderRls(client, `
          INSERT INTO signature_sessions (token, law_firm_id, source_id, created_by, status, created_at, updated_at)
          VALUES ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', now(), now())
        `, ['hacked-token', firm.id, mem.uid]);
        expect(insertedSession.ok).toBe(false);
        expect(insertedSession.message).toMatch(/permission denied/);

        const updatedSession = await attemptUnderRls(client, `
          UPDATE signature_sessions SET status = 'completed' WHERE token = $1
        `, [sessionToken]);
        expect(updatedSession.ok).toBe(false);
        expect(updatedSession.message).toMatch(/permission denied/);

        const deletedSession = await attemptUnderRls(client, `
          DELETE FROM signature_sessions WHERE token = $1
        `, [sessionToken]);
        expect(deletedSession.ok).toBe(false);
        expect(deletedSession.message).toMatch(/permission denied/);

        const insertedParticipant = await attemptUnderRls(client, `
          INSERT INTO signature_participants (id, session_id, law_firm_id, name, email)
          VALUES ($1, ${sessionKeysSql('$2')}, 'Hacked', 'h@test.com')
        `, [randomUUID(), sessionToken]);
        expect(insertedParticipant.ok).toBe(false);
        expect(insertedParticipant.message).toMatch(/permission denied/);

        const updatedParticipant = await attemptUnderRls(client, `
          UPDATE signature_participants SET name = 'Tampered' WHERE id = $1
        `, [participantId]);
        expect(updatedParticipant.ok).toBe(false);
        expect(updatedParticipant.message).toMatch(/permission denied/);

        const deletedParticipant = await attemptUnderRls(client, `
          DELETE FROM signature_participants WHERE id = $1
        `, [participantId]);
        expect(deletedParticipant.ok).toBe(false);
        expect(deletedParticipant.message).toMatch(/permission denied/);
      });

      const { rows: sessionRows } = await testPool.query(
        'SELECT status FROM signature_sessions WHERE token = $1', [sessionToken],
      );
      expect(sessionRows).toEqual([{ status: 'pending' }]);

      const { rows: participantRows } = await testPool.query(
        'SELECT name FROM signature_participants WHERE id = $1', [participantId],
      );
      expect(participantRows).toEqual([{ name: 'Original Name' }]);
    });
  });
});
