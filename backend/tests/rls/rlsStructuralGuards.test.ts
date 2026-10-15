/**
 * Three things the per-surface RLS specs (messaging, notifications, signatures)
 * do not and structurally cannot check, because each of them only ever queries
 * ITS OWN table with ITS OWN fixtures:
 *
 *   R08 (structural half). Two DIFFERENT valid patterns coexist in this schema
 *   for restricting a policy to `authenticated`: the messaging/notifications
 *   policies omit `TO authenticated` and rely on `grant select ... to
 *   authenticated` (so `roles` in `pg_policies` reads `{public}`, and `anon`
 *   is kept out by having no table grant at all), while the signature policies
 *   spell `for select to authenticated` explicitly. Both are correct, so this
 *   file checks the one thing that is true regardless of which pattern a table
 *   uses - no SELECT grant to `anon` - rather than asserting a `roles` shape
 *   that only half the tables would actually have.
 *
 *   Row Level Security can also be silently turned off on a
 *   table, or a policy can be dropped, without any application code changing at
 *   all: `alter table x disable row level security` is a single DDL statement
 *   with no corresponding TypeScript to review. The per-surface specs would
 *   still pass afterward, because the backend itself connects as `postgres` and
 *   bypasses RLS regardless, so nothing in the normal test run would notice
 *   until a real Realtime client read every row in the table. This file queries
 *   `pg_class`/`pg_policies` directly so that regression is a red test instead
 *   of a silent hole.
 *
 *   R09 (access transitions). A stale grant is the sharper failure: access is
 *   correctly refused when a spec seeds a firm from scratch and denied, but the
 *   REVOCATION path is never exercised, because every other RLS spec builds one
 *   fixture and reads it once. Here the same identity reads the same row twice
 *   in one test, with a privileged write revoking access in between and NO
 *   `truncateAll` or cache reset anywhere in the middle. `withRlsIdentity` opens
 *   a fresh transaction and role per call, so this also proves that a rolled-
 *   back RLS transaction cannot leave any session-level state (a GUC, a
 *   prepared plan) that lets a later transaction on the SAME pooled connection
 *   see stale claims.
 *
 *   R10 (security-definer hardening). Every helper the policies above call is
 *   `security definer`, which means it runs with the DEFINING user's
 *   privileges rather than the caller's - the classic way to intentionally
 *   punch a hole through RLS for a cheap non-recursive check. Two things have
 *   to hold for that not to become the actual hole: `search_path` must be
 *   pinned (an unpinned one lets a caller who can create objects in an earlier
 *   schema on their search path shadow a table the function reads, and make it
 *   answer with the caller's data planted under a name the function trusts),
 *   and only `authenticated` may EXECUTE it, never `public` or `anon`.
 */
import { randomUUID } from 'crypto';
import { createFirm, testPool } from '../support/setupInProcess';
import { createFirmMember } from '../support/factories';
import { withRlsIdentity } from '../support/rlsSession';

/** Every table this app puts under RLS. Kept as one list so a table added to
 * the schema without a matching row here fails loudly rather than silently. */
const RLS_TABLES = [
  'notifications',
  'conversations',
  'messages',
  'conversation_participants',
  'signature_sessions',
  'signature_participants',
];

/** The `security definer` functions the policies above call. */
const SECURITY_DEFINER_FUNCTIONS = [
  'rls_is_firm_member',
  'rls_is_conversation_client',
  'rls_is_conversation_participant',
  'messaging_can_access_conversation',
  'messaging_realtime_message_access',
];

describe('RLS: structural guards', () => {
  describe('R08: every RLS table actually has RLS on, with a SELECT policy', () => {
    it.each(RLS_TABLES)('%s has row_security enabled', async (table) => {
      const { rows } = await testPool.query(
        `select relrowsecurity from pg_class where oid = $1::regclass`,
        [table],
      );
      // A table that does not exist would also read as "not enabled", so a
      // typo'd name in RLS_TABLES fails here rather than passing by accident.
      expect(rows).toHaveLength(1);
      expect(rows[0].relrowsecurity).toBe(true);
    });

    it.each(RLS_TABLES)('%s has at least one SELECT policy', async (table) => {
      const { rows } = await testPool.query(
        `select policyname, cmd
           from pg_policies
          where schemaname = 'public' and tablename = $1`,
        [table],
      );

      const selectPolicies = rows.filter((r: any) => r.cmd === 'SELECT' || r.cmd === '*');
      // A table with RLS enabled and NO select policy at all denies every row to
      // every role, which is safe but is also exactly what "the feature quietly
      // stopped working" looks like from a dropped `create policy` statement.
      expect(selectPolicies.length).toBeGreaterThan(0);
    });

    it('does not grant SELECT on any RLS table to anon', async () => {
      // `authenticated` is the only Realtime-connected role these tables are
      // meant to serve. A grant to `anon` would make every policy above
      // meaningless for an unauthenticated caller in exactly the cases where
      // the policy predicate itself would otherwise refuse them.
      const { rows } = await testPool.query(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = any($1::text[])
            and grantee = 'anon'
            and privilege_type = 'SELECT'`,
        [RLS_TABLES],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('R10: the security-definer helpers cannot be turned into a bypass', () => {
    it.each(SECURITY_DEFINER_FUNCTIONS)('%s pins search_path', async (fn) => {
      const { rows } = await testPool.query(
        `select p.proconfig
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(rows.length).toBeGreaterThan(0);
      const configs: string[] = rows.flatMap((r: any) => r.proconfig || []);
      // An overload with no pinned search_path anywhere in its config array is
      // the classic SECURITY DEFINER hijack: create a same-named table earlier
      // on an attacker-controlled schema in the caller's search_path, and the
      // function silently reads THAT table's rows instead of public's.
      expect(configs.some((c) => /^search_path=/.test(c))).toBe(true);
    });

    // rls_is_conversation_client is excluded from this loop; see the
    // CHARACTERISATION case right below it for why.
    const HARDENED_FUNCTIONS = SECURITY_DEFINER_FUNCTIONS.filter(
      (fn) => fn !== 'rls_is_conversation_client',
    );

    it.each(HARDENED_FUNCTIONS)('%s is not executable by anon or public', async (fn) => {
      const { rows } = await testPool.query(
        `select grantee, privilege_type
           from information_schema.routine_privileges
          where routine_schema = 'public' and routine_name = $1`,
        [fn],
      );
      const grantees = rows.map((r: any) => r.grantee);
      // A grant to PUBLIC or to anon would let an unauthenticated Realtime
      // connection call the helper directly (Postgres functions are callable
      // independent of any policy), turning a firm-membership check into a
      // free-standing membership ORACLE: an anonymous caller could ask
      // rls_is_firm_member(firmId, uid) for any (firm, uid) pair and learn who
      // belongs where without ever passing a policy at all.
      expect(grantees).not.toContain('PUBLIC');
      expect(grantees).not.toContain('anon');
    });

    it('rls_is_conversation_client is no longer open to PUBLIC', async () => {
      // This was pinned for a long time as a characterisation: the helper was
      // left at Postgres's default of EXECUTE to PUBLIC while all four of its
      // siblings carried the revoke/grant pair. Being SECURITY DEFINER, an
      // unrestricted grant made it a free-standing membership oracle: any role
      // that could open a connection could ask "is uid X the client on
      // conversation Y?" for any pair it chose, entirely outside RLS.
      //
      // Migration 0249 closed it, so this now asserts the safe state alongside
      // its siblings above rather than documenting the gap. If a future schema
      // edit recreates the function without the revoke, Postgres reinstates the
      // PUBLIC default silently and this is what catches it.
      const { rows } = await testPool.query(
        `select grantee
           from information_schema.routine_privileges
          where routine_schema = 'public' and routine_name = 'rls_is_conversation_client'`,
      );
      const grantees = rows.map((r: any) => r.grantee);
      expect(grantees).not.toContain('PUBLIC');
      expect(grantees).not.toContain('anon');
      expect(grantees).toContain('authenticated');

      // Kept from the characterisation: no policy's USING expression calls the
      // helper, so it is still dead code. That is worth knowing if anyone
      // wonders why the grant above is the only thing standing between it and a
      // caller.
      const { rows: policyRows } = await testPool.query(
        `select pol.polname, pg_get_expr(pol.polqual, pol.polrelid) as qual
           from pg_policy pol`,
      );
      const callers = policyRows.filter((r: any) =>
        (r.qual || '').includes('rls_is_conversation_client'));
      expect(callers).toEqual([]);
    });
  });

  describe('R09: access transitions take effect without resetting the database', () => {
    it('a removed firm member loses notifications-adjacent conversation access on the very next read', async () => {
      const firm = await createFirm();
      const member = await createFirmMember(firm.id, { uid: `rls-transition-${randomUUID().slice(0, 8)}` });

      const convId = randomUUID();
      await testPool.query(
        `insert into conversations (id, law_firm_id, conversation_type, created_at, updated_at)
         values ($1, $2, 'direct', now(), now())`,
        [convId, firm.id],
      );

      // Allowed: read #1, in its own rolled-back transaction.
      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select id from conversations');
        expect(rows.map((r: any) => r.id)).toEqual([convId]);
      });

      // Revoke, on a SEPARATE privileged connection. Nothing here truncates or
      // resets any cache; the only thing that changed is this one row.
      await testPool.query('delete from members where law_firm_id = $1 and user_id = $2', [
        firm.id, member.uid,
      ]);

      // Denied: read #2, in a NEW transaction on a (possibly reused, pooled)
      // connection. If read #1's ROLLBACK had left `request.jwt.claims` or the
      // `authenticated` role set on the connection, this would still see the
      // conversation - it would just be riding read #1's leftover identity
      // rather than actually re-evaluating the policy.
      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select id from conversations');
        expect(rows).toEqual([]);
      });
    });

    it('a removed group participant loses access on the very next read, and regains it if re-added', async () => {
      const firm = await createFirm();
      const member = await createFirmMember(firm.id, { uid: `rls-regrant-${randomUUID().slice(0, 8)}` });

      const groupId = randomUUID();
      await testPool.query(
        `insert into conversations (id, law_firm_id, conversation_type, title, created_at, updated_at)
         values ($1, $2, 'group', 'Transition Test', now(), now())`,
        [groupId, firm.id],
      );
      await testPool.query(
        `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_at)
         values ($1, $2, $3, 'firm_member', now())`,
        [groupId, firm.id, member.uid],
      );

      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select id from conversations');
        expect(rows.map((r: any) => r.id)).toEqual([groupId]);
      });

      // Soft-removed, the way the app actually does it (removed_at, not a
      // delete): the row stays, only the timestamp changes.
      await testPool.query(
        'update conversation_participants set removed_at = now() where conversation_id = $1 and participant_user_id = $2',
        [groupId, member.uid],
      );

      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select id from conversations');
        expect(rows).toEqual([]);
      });

      // Re-added: the same uid, the same row, a THIRD fresh transaction. This is
      // the direction a stale-negative cache would miss, which a test that only
      // ever revokes would never catch.
      await testPool.query(
        'update conversation_participants set removed_at = null where conversation_id = $1 and participant_user_id = $2',
        [groupId, member.uid],
      );

      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select id from conversations');
        expect(rows.map((r: any) => r.id)).toEqual([groupId]);
      });
    });

    it('a removed firm member loses signature-session visibility on the very next read', async () => {
      const firm = await createFirm();
      const member = await createFirmMember(firm.id, { uid: `rls-sig-transition-${randomUUID().slice(0, 8)}` });

      const sessionToken = `sess-${randomUUID()}`;
      await testPool.query(
        `insert into signature_sessions (token, law_firm_id, source_id, status, created_at, updated_at)
         values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'pending', now(), now())`,
        [sessionToken, firm.id],
      );

      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select token from signature_sessions');
        expect(rows.map((r: any) => r.token)).toEqual([sessionToken]);
      });

      await testPool.query('delete from members where law_firm_id = $1 and user_id = $2', [
        firm.id, member.uid,
      ]);

      await withRlsIdentity(member.uid, async (client) => {
        const { rows } = await client.query('select token from signature_sessions');
        expect(rows).toEqual([]);
      });
    });
  });
});
