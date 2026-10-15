/**
 * RLS policy tests for conversations, messages, and conversation_participants.
 *
 * Policies:
 *   conversations:  group -> rls_is_conversation_participant; direct -> client_id match or firm member
 *   messages:       messaging_realtime_message_access -> group requires BOTH participant AND firm member
 *   participants:   messaging_can_access_conversation -> same as conversations policy
 *
 * The critical asymmetry (R04): a client participant in a group CANNOT read raw
 * message rows through RLS, because the policy requires firm membership for group
 * messages. This protects sender names from leaking to clients.
 */
import { randomUUID } from 'crypto';
import { createFirm, testPool } from '../support/setupInProcess';
import { createFirmMember } from '../support/factories';
import { attemptUnderRls, withRlsIdentity } from '../support/rlsSession';

/** Create a users row so FKs resolve. */
async function ensureUser(uid: string, userType: 'firm_member' | 'client' = 'client') {
  await testPool.query(
    `INSERT INTO users (id, email, name, user_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [uid, `${uid}@example.test`, `User ${uid}`, userType],
  );
}

describe('RLS: messaging', () => {
  describe('R02: direct conversation access', () => {
    it('firm member and client_id owner see the conversation; others do not', async () => {
      const firmX = await createFirm();
      const firmY = await createFirm();

      // Create members via the low-level factory (we need UIDs for SQL seeding)
      const memX = await createFirmMember(firmX.id, { uid: 'memX-direct' });
      const memY = await createFirmMember(firmY.id, { uid: 'memY-direct' });

      const clientA = 'clientA-direct';
      const clientB = 'clientB-direct';
      await ensureUser(clientA);
      await ensureUser(clientB);

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, client_id, conversation_type, created_at, updated_at)
        VALUES ($1, $2, $3, 'direct', now(), now())
      `, [convId, firmX.id, clientA]);

      // Firm X member sees the direct conversation
      await withRlsIdentity(memX.uid, async (client) => {
        const { rows } = await client.query('SELECT id FROM conversations');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(convId);
      });

      // Client A (owner) sees the direct conversation
      await withRlsIdentity(clientA, async (client) => {
        const { rows } = await client.query('SELECT id FROM conversations');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(convId);
      });

      // Client B (different client, same firm) sees nothing
      await withRlsIdentity(clientB, async (client) => {
        const { rows } = await client.query('SELECT id FROM conversations');
        expect(rows).toEqual([]);
      });

      // Firm Y member sees nothing
      await withRlsIdentity(memY.uid, async (client) => {
        const { rows } = await client.query('SELECT id FROM conversations');
        expect(rows).toEqual([]);
      });

      // Stranger sees nothing
      await withRlsIdentity('stranger-msg', async (client) => {
        const { rows } = await client.query('SELECT id FROM conversations');
        expect(rows).toEqual([]);
      });
    });
  });

  describe('R03: group conversation access', () => {
    it('only active participants see the group; firm owner not in participant list cannot', async () => {
      const firm = await createFirm();
      // A firm has at most one owner (members_one_owner_per_firm_idx). This spec
      // needs the owner to be someone OUTSIDE the participant list, so the two
      // participants are ordinary members and the owner is created explicitly.
      const memA = await createFirmMember(firm.id, { uid: 'memA-group', isOwner: false });
      const memB = await createFirmMember(firm.id, { uid: 'memB-group', isOwner: false });
      const owner = await createFirmMember(firm.id, { uid: 'owner-group', isOwner: true });
      const clientC = 'clientC-group';
      await ensureUser(clientC);

      const groupId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
        VALUES ($1, $2, 'group', 'Project Alpha', now(), now())
      `, [groupId, firm.id]);

      // Active participants: memA, memB, clientC
      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
        VALUES
          ($1, $2, $3, 'firm_member', now()),
          ($1, $2, $4, 'firm_member', now()),
          ($1, $2, $5, 'client', now())
      `, [groupId, firm.id, memA.uid, memB.uid, clientC]);

      // memA sees the group
      await withRlsIdentity(memA.uid, async (client) => {
        const { rows } = await client.query('SELECT title FROM conversations');
        expect(rows).toEqual([{ title: 'Project Alpha' }]);
      });

      // clientC sees the group
      await withRlsIdentity(clientC, async (client) => {
        const { rows } = await client.query('SELECT title FROM conversations');
        expect(rows).toEqual([{ title: 'Project Alpha' }]);
      });

      // Owner (NOT a participant) cannot see the group
      await withRlsIdentity(owner.uid, async (client) => {
        const { rows } = await client.query('SELECT title FROM conversations');
        expect(rows).toEqual([]);
      });
    });

  });

  describe('R04: group message critical asymmetry', () => {
    it('client participant CANNOT read raw group message rows; firm member CAN', async () => {
      const firm = await createFirm();
      const memA = await createFirmMember(firm.id, { uid: 'memA-msg' });
      const clientC = 'clientC-msg';
      await ensureUser(clientC);

      const groupId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
        VALUES ($1, $2, 'group', 'Msg Test Group', now(), now())
      `, [groupId, firm.id]);

      // Both are active participants
      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
        VALUES ($1, $2, $3, 'firm_member', now()), ($1, $2, $4, 'client', now())
      `, [groupId, firm.id, memA.uid, clientC]);

      // Seed a message with sender_name (the field clients must not see via Realtime)
      await testPool.query(`
        INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, content, sender_name, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'Hello group', 'Lawyer Smith', now())
      `, [groupId, firm.id, memA.uid]);

      // Firm member participant CAN read the message row
      await withRlsIdentity(memA.uid, async (client) => {
        const { rows } = await client.query('SELECT content, sender_name FROM messages');
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe('Hello group');
        expect(rows[0].sender_name).toBe('Lawyer Smith');
      });

      // Client participant CANNOT read raw group message rows
      // This is the intentional asymmetry: clients get messages through the REST
      // API with masked sender names, not through raw Realtime SELECT
      await withRlsIdentity(clientC, async (client) => {
        const { rows } = await client.query('SELECT content FROM messages');
        expect(rows).toEqual([]);
      });
    });

    it('firm member can read direct conversation message rows; the owning client cannot', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-direct-msg' });
      const clientA = 'clientA-direct-msg';
      await ensureUser(clientA);

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, client_id, conversation_type, created_at, updated_at)
        VALUES ($1, $2, $3, 'direct', now(), now())
      `, [convId, firm.id, clientA]);

      await testPool.query(`
        INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, content, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'Direct message', now())
      `, [convId, firm.id, mem.uid]);

      // Both see direct messages
      await withRlsIdentity(mem.uid, async (client) => {
        const { rows } = await client.query('SELECT content FROM messages');
        expect(rows).toEqual([{ content: 'Direct message' }]);
      });

      // A raw direct row carries sender_name/sender_user_id of a send-as-firm
      // message and the retained content of a soft-deleted one, so the client
      // reads its thread through the masked REST path instead.
      await withRlsIdentity(clientA, async (client) => {
        const { rows } = await client.query('SELECT content FROM messages');
        expect(rows).toEqual([]);
      });
    });
  });

  describe('R05: conversation_participants access', () => {
    it('active participant sees participant list; removed participant does not', async () => {
      const firm = await createFirm();
      const memA = await createFirmMember(firm.id, { uid: 'memA-parts' });
      const memRemoved = await createFirmMember(firm.id, { uid: 'memRemoved-parts' });
      const clientC = 'clientC-parts';
      await ensureUser(clientC);

      const groupId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
        VALUES ($1, $2, 'group', 'Parts Test', now(), now())
      `, [groupId, firm.id]);

      // Active: memA, clientC. Removed: memRemoved
      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
        VALUES ($1, $2, $3, 'firm_member', now()), ($1, $2, $4, 'client', now())
      `, [groupId, firm.id, memA.uid, clientC]);

      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at, removed_at)
        VALUES ($1, $2, $3, 'firm_member', now(), now())
      `, [groupId, firm.id, memRemoved.uid]);

      // Active participant sees all participants (including removed ones)
      await withRlsIdentity(memA.uid, async (client) => {
        const { rows } = await client.query(
          'SELECT participant_user_id FROM conversation_participants ORDER BY participant_user_id',
        );
        expect(rows).toHaveLength(3);
      });

      // Removed participant sees nothing (cannot access the conversation)
      await withRlsIdentity(memRemoved.uid, async (client) => {
        const { rows } = await client.query('SELECT participant_user_id FROM conversation_participants');
        expect(rows).toEqual([]);
      });
    });
  });

  describe('R06: a client participant sees only its own participant row', () => {
    it('hides firm members\' read cursors and co-clients\' rows from a client in a group', async () => {
      const firm = await createFirm();
      const lawyer = await createFirmMember(firm.id, { uid: 'lawyer-own-row' });
      const clientC = 'clientC-own-row';
      const coClient = 'coClient-own-row';
      await ensureUser(clientC);
      await ensureUser(coClient);

      const groupId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
        VALUES ($1, $2, 'group', 'Own Row Test', now(), now())
      `, [groupId, firm.id]);
      await testPool.query(`
        INSERT INTO conversation_participants
          (conversation_id, law_firm_id, participant_user_id, participant_type, added_at, last_read_at)
        VALUES
          ($1, $2, $3, 'firm_member', now(), now()),
          ($1, $2, $4, 'client', now(), null),
          ($1, $2, $5, 'client', now(), null)
      `, [groupId, firm.id, lawyer.uid, clientC, coClient]);

      // The firm member keeps the whole roster.
      await withRlsIdentity(lawyer.uid, async (client) => {
        const { rows } = await client.query(
          'SELECT participant_user_id FROM conversation_participants ORDER BY participant_user_id',
        );
        expect(rows.map((r: { participant_user_id: string }) => r.participant_user_id).sort())
          .toEqual([clientC, coClient, lawyer.uid].sort());
      });

      // The client sees its own row and nothing else.
      await withRlsIdentity(clientC, async (client) => {
        const { rows } = await client.query('SELECT participant_user_id FROM conversation_participants');
        expect(rows).toEqual([{ participant_user_id: clientC }]);
      });
    });
  });

  describe('R07: a client streams no message rows in any thread', () => {
    it('denies a direct-thread client the send-as-firm and soft-deleted rows a firm member still reads', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-masked-direct' });
      const clientA = 'clientA-masked-direct';
      await ensureUser(clientA);

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, client_id, conversation_type, created_at, updated_at)
        VALUES ($1, $2, $3, 'direct', now(), now())
      `, [convId, firm.id, clientA]);
      await testPool.query(`
        INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, sender_name, sent_as_firm, content, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'Lawyer Real Name', true, 'From the firm', now())
      `, [convId, firm.id, mem.uid]);
      await testPool.query(`
        INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, content, deleted_at, deleted_by, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'Retracted text', now(), $3, now())
      `, [convId, firm.id, mem.uid]);

      // Positive control: the rows exist and a firm member can stream them.
      await withRlsIdentity(mem.uid, async (client) => {
        const { rows } = await client.query('SELECT content FROM messages ORDER BY content');
        expect(rows).toEqual([{ content: 'From the firm' }, { content: 'Retracted text' }]);
      });

      await withRlsIdentity(clientA, async (client) => {
        const { rows } = await client.query('SELECT sender_name, sender_user_id, content FROM messages');
        expect(rows).toEqual([]);
        // The conversations row stays readable: it is what the client watches.
        const { rows: convs } = await client.query('SELECT id FROM conversations');
        expect(convs).toEqual([{ id: convId }]);
      });
    });
  });

  describe('R08: INSERT/UPDATE/DELETE denied on messaging tables', () => {
    // Only SELECT is granted to `authenticated` on all three tables (schema.sql).
    // Each verb is an independently grantable privilege, so a migration that
    // accidentally adds UPDATE or DELETE without touching INSERT would pass an
    // INSERT-only check. Every verb is exercised here, each in its own
    // savepoint so the second and third refusals report their own reason
    // instead of "current transaction is aborted", with a positive control
    // proving the targeted row actually existed and survived untouched.
    it('authenticated role cannot mutate conversations', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-write-conv' });

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
        VALUES ($1, $2, 'group', 'Original Title', now(), now())
      `, [convId, firm.id]);
      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
        VALUES ($1, $2, $3, 'firm_member', now())
      `, [convId, firm.id, mem.uid]);

      await withRlsIdentity(mem.uid, async (client) => {
        const inserted = await attemptUnderRls(client, `
          INSERT INTO conversations (id, law_firm_id, conversation_type, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'group', now(), now())
        `, [firm.id]);
        expect(inserted.ok).toBe(false);
        expect(inserted.message).toMatch(/permission denied/);

        const updated = await attemptUnderRls(client, `
          UPDATE conversations SET title = 'Hacked' WHERE id = $1
        `, [convId]);
        expect(updated.ok).toBe(false);
        expect(updated.message).toMatch(/permission denied/);

        const deleted = await attemptUnderRls(client, `
          DELETE FROM conversations WHERE id = $1
        `, [convId]);
        expect(deleted.ok).toBe(false);
        expect(deleted.message).toMatch(/permission denied/);
      });

      const { rows } = await testPool.query('SELECT title FROM conversations WHERE id = $1', [convId]);
      expect(rows).toEqual([{ title: 'Original Title' }]);
    });

    it('authenticated role cannot mutate conversation_participants', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-write-parts' });
      const clientA = 'clientA-write-parts';
      await ensureUser(clientA);

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, created_at, updated_at)
        VALUES ($1, $2, 'group', now(), now())
      `, [convId, firm.id]);
      await testPool.query(`
        INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
        VALUES ($1, $2, $3, 'firm_member', now())
      `, [convId, firm.id, mem.uid]);

      await withRlsIdentity(mem.uid, async (client) => {
        const inserted = await attemptUnderRls(client, `
          INSERT INTO conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
          VALUES ($1, $2, $3, 'client', now())
        `, [convId, firm.id, clientA]);
        expect(inserted.ok).toBe(false);
        expect(inserted.message).toMatch(/permission denied/);

        const updated = await attemptUnderRls(client, `
          UPDATE conversation_participants SET removed_at = now()
          WHERE conversation_id = $1 AND participant_user_id = $2
        `, [convId, mem.uid]);
        expect(updated.ok).toBe(false);
        expect(updated.message).toMatch(/permission denied/);

        const deleted = await attemptUnderRls(client, `
          DELETE FROM conversation_participants WHERE conversation_id = $1 AND participant_user_id = $2
        `, [convId, mem.uid]);
        expect(deleted.ok).toBe(false);
        expect(deleted.message).toMatch(/permission denied/);
      });

      const { rows } = await testPool.query(
        'SELECT removed_at FROM conversation_participants WHERE conversation_id = $1 AND participant_user_id = $2',
        [convId, mem.uid],
      );
      expect(rows).toEqual([{ removed_at: null }]);
    });

    it('authenticated role cannot mutate messages', async () => {
      const firm = await createFirm();
      const mem = await createFirmMember(firm.id, { uid: 'mem-write-msg' });

      const convId = randomUUID();
      await testPool.query(`
        INSERT INTO conversations (id, law_firm_id, conversation_type, created_at, updated_at)
        VALUES ($1, $2, 'direct', now(), now())
      `, [convId, firm.id]);

      const msgId = randomUUID();
      await testPool.query(`
        INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, content, created_at)
        VALUES ($1, $2, $3, $4, 'Original', now())
      `, [msgId, convId, firm.id, mem.uid]);

      await withRlsIdentity(mem.uid, async (client) => {
        const inserted = await attemptUnderRls(client, `
          INSERT INTO messages (id, conversation_id, law_firm_id, sender_user_id, content, created_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'Hacked', now())
        `, [convId, firm.id, mem.uid]);
        expect(inserted.ok).toBe(false);
        expect(inserted.message).toMatch(/permission denied/);

        const updated = await attemptUnderRls(client, `
          UPDATE messages SET content = 'Tampered' WHERE id = $1
        `, [msgId]);
        expect(updated.ok).toBe(false);
        expect(updated.message).toMatch(/permission denied/);

        const deleted = await attemptUnderRls(client, `
          DELETE FROM messages WHERE id = $1
        `, [msgId]);
        expect(deleted.ok).toBe(false);
        expect(deleted.message).toMatch(/permission denied/);
      });

      const { rows } = await testPool.query('SELECT content FROM messages WHERE id = $1', [msgId]);
      expect(rows).toEqual([{ content: 'Original' }]);
    });
  });
});
