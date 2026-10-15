/**
 * Every foreign key to `users(id)` is real, and each one names its own delete
 * action.
 *
 * Until migration 0224 there were NONE. `schema.sql` declared all 67 inline and
 * then a sweep at the foot of the file dropped every one, so `created_by`,
 * `uploaded_by` and `performed_by` were unconstrained text: a typo, a stale id
 * or a hard delete could leave a row naming an account that does not exist, and
 * `db/check-user-delete-guards.ts` was the only thing looking.
 *
 * WHAT MAKES THIS GO RED: reinstating the sweep over `users`, adding a column
 * that points at `users` without a key, dropping one, or changing an action.
 * The last is the point of holding the action rather than just the column name.
 * `cascade` and `set null` DESTROY data when a users row goes; `restrict`
 * refuses. Flipping an actor column from `restrict` to `cascade` would delete a
 * firm's invoices along with the account that raised them, and nothing else in
 * the suite would notice.
 *
 * The list is deliberately exhaustive rather than a count. A count passes while
 * two keys swap actions.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, createFirmMember } from '../support/setupInProcess';

/**
 * `table.column action`, as migrations 0224 and 0226 declared them: 0224 made
 * real the 67 keys `schema.sql` already declared, and 0226 keyed the 36 actor
 * columns that had never been declared at all.
 */
const EXPECTED = new Set<string>([
  'activity_log.actor_user_id restrict',
  'attachments.created_by restrict',
  'billing_plans.created_by restrict',
  'billing_plans.updated_by restrict',
  'calendar_events.created_by restrict',
  'billing_codes.created_by restrict',
  'client_company_links.created_by restrict',
  // The portal user who started an identity verification. Restrict: the row is
  // the firm's evidence that this client was verified and must not vanish with
  // the account.
  'client_identity_verifications.user_id restrict',
  'clients.user_id set null',
  'conflict_check_records.performed_by restrict',
  'contact_clients.created_by restrict',
  'contacts.created_by restrict',
  'conversation_participants.participant_user_id restrict',
  'conversations.client_id set null',
  'digest_sends.user_id cascade',
  'document_request_templates.created_by restrict',
  'document_requests.created_by restrict',
  'document_request_uploads.created_by restrict',
  'email_verification_whitelist.created_by set null',
  'event_assignees.user_id cascade',
  'activities.created_by restrict',
  'activities.user_id restrict',
  'file_client_access.client_user_id cascade',
  // The requester of a folder export. Cascade, not restrict: the archive is a
  // temporary copy made for one person, so it has nothing to preserve once
  // that account is gone, and a restrict here would refuse to delete an
  // account over a download it took last week.
  'file_export_jobs.requested_by cascade',
  // The uploader holding quota for an upload in flight. Cascade: the row is a
  // lease that lapses within hours on its own, so it has nothing to preserve
  // once the account is gone.
  'storage_reservations.created_by cascade',
  'file_client_access.shared_by restrict',
  'file_share_links.created_by restrict',
  'files.deleted_by restrict',
  'files.uploaded_by restrict',
  'intake_form_templates.created_by restrict',
  'intake_submissions.sent_by restrict',
  'invitations.accepted_by restrict',
  'invitations.invited_by restrict',
  'invoices.created_by restrict',
  'invoices.stripe_payment_requested_by restrict',
  'invoices.updated_by restrict',
  'leads.created_by restrict',
  'matter_contacts.created_by restrict',
  'matter_field_defs.created_by restrict',
  'matter_members.user_id cascade',
  'matters.created_by restrict',
  'matters.lead_user_id restrict',
  'members.invited_by restrict',
  'members.user_id cascade',
  'messages.deleted_by restrict',
  'messages.sender_user_id restrict',
  'note_templates.created_by restrict',
  'note_types.created_by restrict',
  'notifications.created_by restrict',
  'notifications.user_id cascade',
  'oauth_states.user_id cascade',
  'practice_areas.created_by restrict',
  'task_assignees.user_id cascade',
  'task_subtasks.assignee_user_id set null',
  'task_subtasks.completed_by restrict',
  'task_subtasks.created_by restrict',
  'tasks.created_by restrict',
  'trust_accounts.created_by restrict',
  'trust_accounts.updated_by restrict',
  'trust_interest_remittances.created_by restrict',
  'trust_interest_remittances.updated_by restrict',
  'trust_minimum_balances.created_by restrict',
  'trust_minimum_balances.updated_by restrict',
  'trust_reconciliations.created_by restrict',
  'trust_reconciliations.reconciled_by restrict',
  'trust_transactions.created_by restrict',
  'trust_transactions.voided_by restrict',
  'user_oauth_tokens.user_id cascade',
  'calendar_mappings.user_id restrict',
  'calendar_subscriptions.user_id restrict',
  'calendar_sync_failures.user_id restrict',
  'clients.invited_by restrict',
  'conversation_participants.added_by restrict',
  'conversations.archived_by restrict',
  'conversations.created_by restrict',
  'conversations.last_sender_user_id restrict',
  'courts.created_by restrict',
  'deadline_set_templates.created_by restrict',
  'events.cancelled_by restrict',
  'events.created_by restrict',
  'invoice_adjustments.created_by restrict',
  'invoice_line_items.user_id restrict',
  'invoice_payments.recorded_by restrict',
  'law_firms.deletion_requested_by restrict',
  'legal_holds.placed_by restrict',
  'legal_holds.released_by restrict',
  'matter_categories.created_by restrict',
  'note_links.created_by restrict',
  'note_replies.created_by restrict',
  'note_replies.retracted_by restrict',
  'note_versions.edited_by restrict',
  'notes.created_by restrict',
  'notes.edited_by restrict',
  'notes.pinned_by restrict',
  'notes.retracted_by restrict',
  'signature_participants.client_user_id restrict',
  'signature_participants.facilitated_by restrict',
  'signature_participants.member_user_id restrict',
  'signature_sessions.created_by restrict',
  'signature_sources.uploaded_by restrict',
  'signature_templates.created_by restrict',
  'word_templates.created_by restrict',
]);

const ACTION = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' } as const;

describe('foreign keys to users(id)', () => {
  it('declares every one of them, with the delete action it was given', async () => {
    const { rows } = await testPool.query(
      `select cl.relname as tbl, att.attname as col, con.confdeltype as act
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join unnest(con.conkey) as k(attnum) on true
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
        where con.contype = 'f' and con.confrelid = 'users'::regclass`,
    );
    const actual = new Set(
      rows.map((r: any) => `${r.tbl}.${r.col} ${ACTION[r.act as keyof typeof ACTION]}`),
    );
    const missing = [...EXPECTED].filter((e) => !actual.has(e)).sort();
    const extra = [...actual].filter((a) => !EXPECTED.has(a)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('refuses a row naming an account that does not exist', async () => {
    const firm = await createFirm();
    await expect(testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id, created_by)
       values ($1, $2, 'Ghost author', $3, 'uid-that-never-existed')`,
      [randomUUID(), firm.id, `REF-${randomUUID().slice(0, 8)}`],
    )).rejects.toThrow(/violates foreign key constraint/);
  });

  it('refuses to delete an account that authored something, instead of orphaning it', async () => {
    const firm = await createFirm();
    const { uid } = await createFirmMember(firm.id);
    const matterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id, created_by)
       values ($1, $2, 'Authored matter', $3, $4)`,
      [matterId, firm.id, `REF-${matterId.slice(0, 8)}`, uid],
    );
    // The membership row cascades, so clear it first: what has to be refused is
    // the AUTHORSHIP, which is the restrict half of migration 0224.
    await testPool.query('delete from members where user_id = $1', [uid]);

    await expect(testPool.query('delete from users where id = $1', [uid]))
      .rejects.toThrow(/violates foreign key constraint/);

    const { rows } = await testPool.query('select created_by from matters where id = $1', [matterId]);
    expect(rows[0].created_by).toBe(uid);
  });
});
