/**
 * Every foreign key column has an index that leads with it.
 *
 * Postgres indexes the REFERENCED side of a foreign key automatically, because
 * the target of an FK must be unique. It does not index the REFERENCING side,
 * and that is the side every delete of a parent has to scan.
 *
 * The cost is not theoretical. Deleting one matter makes Postgres check every
 * child table that points at `matters` for rows to cascade or restrict. A child
 * with no leading index is a sequential scan of that whole table, per parent
 * row deleted. `matterDeletionCascade.test.ts` deletes a matter with children
 * in about twenty tables; at firm scale that is twenty scans behind one button.
 *
 * WHAT MAKES THIS GO RED: adding a foreign key without an index whose FIRST
 * column is the referencing column, or removing an index some FK was relying
 * on. The fix is to add the index, not to widen the allow-list.
 *
 * WHAT COUNTS AS COVERED. A btree can be scanned on a leading prefix of its
 * columns, so an index on `(law_firm_id, matter_id, created_at)` serves a
 * lookup by `law_firm_id` but NOT one by `matter_id` alone. So:
 *
 *   - a single-column FK on `x` needs an index whose first column is `x`;
 *   - a composite FK on `(law_firm_id, x)` needs an index whose first two
 *     columns are exactly those, in that order, which the tenant-leading
 *     convention produces naturally.
 *
 * A partial index counts. The cascade scan it serves is the same scan, and a
 * predicate that excludes rows only makes the remaining lookup cheaper. That is
 * a deliberate difference from `indexRedundancy.test.ts`, where a partial index
 * is never treated as covering a non-partial one: there the question is whether
 * B can replace A for every query, and here it is only whether the delete path
 * has an access path at all.
 */
import { testPool } from '../support/setupInProcess';

/**
 * Foreign key columns with no leading index, as of this file's writing.
 *
 * Most are small configuration tables where the parent is a pick-list row that
 * is rarely deleted and the child holds a few dozen rows per firm: a sequential
 * scan of forty rows is cheaper than maintaining an index. Those are fine
 * permanently and are marked `small`.
 *
 * The rest are real and are fixed by the phase named beside them. An entry
 * leaves this list when its index lands, never because it became inconvenient.
 */
const ALLOWED = new Set<string>([
  // ---- small configuration parents, deletion is rare and children are few ---
  'billing_codes.utbms_code_id',                   // small
  'contacts.court_id',                             // small
  'courts.catalog_court_id',                       // small
  'intake_form_templates.practice_area_id',        // small
  'lead_stages.parent_stage_id',                   // small
  'lead_stages.practice_area_id',                  // small
  'matter_field_defs.practice_area_id',            // small
  'matter_stage_pipelines.practice_area_id',       // small
  'matter_stages.parent_stage_id',                 // small
  'matter_stages.pipeline_id',                     // small
  'members.role_id',                               // small
  'invitations.role_id',                           // small
  'template_folders.parent_folder_id',             // small
  'templates.folder_id',                           // small
  'billing_plans.matter_id',                       // small
  'leads.converted_matter_id',                     // small
  'intake_submissions.lead_id',                    // small
  'invitations.contact_client_id',                 // small
  'trust_minimum_balances.trust_account_id',       // small
  'trust_transactions.reverses_transaction_id',    // small
  'trust_transactions.transfer_to_account_id',     // small

  // ---- real, and scheduled -------------------------------------------------
  // The composite tenant key these need does not exist yet; the index arrives
  // with `unique (law_firm_id, id)` in phase 2 of the redesign.
  'billing_plan_periods.law_firm_id',
  'template_field_placements.law_firm_id',
  // `note_links` stays: the relationship is many-to-many in both directions, so a
  // scalar column on `tasks` cannot replace it (see the phase 3 corrections).
  // `reply_id` is `set null` and rarely traversed.
  'note_links.reply_id',
  // Phase 5 rebuilds these: `billing_plan_periods.generated_invoice_id` becomes
  // part of the invoice arc, and `event_contacts` becomes `contact_links`.
  'billing_plan_periods.generated_invoice_id',
  'event_contacts.event_id',

  // ---- the parent is `users`, which no path deletes -------------------------
  //
  // Migration 0224 made all 67 foreign keys to `users(id)` real. The fifteen
  // that `cascade` or `set null` DO run on a delete and each got its own leading
  // index in that migration; these forty-eight are `restrict` on an actor column
  // (`created_by`, `updated_by`, `voided_by`, `performed_by`), and the scan they
  // would need happens only when a users row is actually deleted.
  //
  // Nothing deletes one on any user-facing path. The privacy erase anonymizes
  // the row and keeps it (`users.repository.anonymizeAccount`, and `deleted_at`
  // marks the tombstone). The single remaining delete is the unverified-account
  // sweep, which is off by default, runs at most daily, and only ever considers
  // accounts `findAccountActivity` has already proved hold no references at all
  // -- so in the case it does delete, every one of these scans finds nothing and
  // the table it scans is the firm's, not the platform's.
  //
  // Forty-eight btree indexes on write-heavy tables (`invoices`, `expenses`,
  // `trust_transactions`) is a permanent insert cost for a delete that does not
  // happen. This is the same trade as the `small` group above, with the parent
  // rarity coming from the delete path rather than the row count.
  //
  // WHAT MAY JOIN THIS GROUP, and nothing else: a `restrict` key to `users`.
  // That is the whole condition, and it is the reasoning above rather than a
  // convenience. A `cascade` or `set null` key to `users` DOES run on a delete
  // and gets an index; so does every key to any other parent. Migration 0226
  // added the thirty-three below on top of 0224's forty-eight, keying the actor
  // columns `schema.sql` had never declared at all.
  'activity_log.actor_user_id',
  'billing_plans.created_by',
  'billing_plans.updated_by',
  'calendar_events.created_by',
  'billing_codes.created_by',
  'client_company_links.created_by',
  'conflict_check_records.performed_by',
  'contact_clients.created_by',
  'contacts.created_by',
  'document_request_templates.created_by',
  'document_requests.created_by',
  'file_share_links.created_by',
  'files.uploaded_by',
  'intake_form_templates.created_by',
  'intake_submissions.sent_by',
  'invitations.accepted_by',
  'invitations.invited_by',
  'invoices.created_by',
  'invoices.stripe_payment_requested_by',
  'invoices.updated_by',
  'leads.created_by',
  'matter_contacts.created_by',
  'matter_field_defs.created_by',
  'matters.created_by',
  'matters.lead_user_id',
  'members.invited_by',
  'messages.sender_user_id',
  'note_templates.created_by',
  'note_types.created_by',
  'notifications.created_by',
  'practice_areas.created_by',
  'task_subtasks.completed_by',
  'task_subtasks.created_by',
  'trust_accounts.created_by',
  'trust_accounts.updated_by',
  'trust_interest_remittances.created_by',
  'trust_interest_remittances.updated_by',
  'trust_minimum_balances.created_by',
  'trust_minimum_balances.updated_by',
  'trust_reconciliations.created_by',
  'trust_reconciliations.reconciled_by',
  'trust_transactions.created_by',
  'trust_transactions.voided_by',

  'calendar_subscriptions.user_id',
  'calendar_sync_failures.user_id',
  'clients.invited_by',
  'conversation_participants.added_by',
  'conversations.archived_by',
  'conversations.created_by',
  'conversations.last_sender_user_id',
  'courts.created_by',
  'deadline_set_templates.created_by',
  'events.cancelled_by',
  'events.created_by',
  'invoice_adjustments.created_by',
  'invoice_line_items.user_id',
  'invoice_payments.recorded_by',
  'law_firms.deletion_requested_by',
  'legal_holds.placed_by',
  'legal_holds.released_by',
  'matter_categories.created_by',
  'note_links.created_by',
  'note_replies.created_by',
  'note_replies.retracted_by',
  'note_versions.edited_by',
  'notes.created_by',
  'notes.edited_by',
  'notes.pinned_by',
  'notes.retracted_by',
  'signature_participants.facilitated_by',
  'signature_sessions.created_by',
  'signature_templates.created_by',
  'activities.created_by',
]);

/**
 * Every foreign key in the public schema paired with the columns it references
 * FROM, and whether any index on that table leads with those columns.
 *
 * `conkey` is the referencing column list in FK order. `indkey` is the indexed
 * column list in index order; comparing a prefix of the second against the
 * whole of the first is exactly the btree leading-prefix rule.
 */
/**
 * `pg_index.indkey` is an int2vector, whose lower bound is ZERO, not one. A
 * naive `[1:n]` slice of it therefore starts at the SECOND indexed column and
 * reports almost every foreign key as uncovered. `string_to_array` on its text
 * form produces an ordinary one-based array, which is the same normalization
 * `indexRedundancy.test.ts` uses on the same column and for the same reason.
 *
 * A finding is reported by its last referencing column, which is the one a
 * reader would look for: the composite `(law_firm_id, matter_id)` reads as
 * `child.matter_id`, and a single-column FK reads as itself.
 */
const SQL = `
  select r.relname || '.'
      || (array_agg(a.attname::text order by ord.n))[array_length(k.conkey, 1)] as name
    from pg_constraint k
    join pg_class r on r.oid = k.conrelid
    cross join lateral unnest(k.conkey) with ordinality as ord(attnum, n)
    join pg_attribute a on a.attrelid = r.oid and a.attnum = ord.attnum
   where k.contype = 'f'
     and r.relnamespace = 'public'::regnamespace
     and not exists (
       select 1
         from pg_index i
        where i.indrelid = r.oid
          and (string_to_array(i.indkey::text, ' ')::int[])[1:array_length(k.conkey, 1)]
              = k.conkey::int[])
   group by r.oid, r.relname, k.conname, k.conkey
   order by 1
`;

describe('every foreign key column has a leading index', () => {
  it('reports every referencing column no index leads with', async () => {
    const { rows } = await testPool.query<{ name: string }>(SQL);
    const findings = rows.map((r) => r.name);

    const unexpected = findings.filter((f) => !ALLOWED.has(f)).sort();
    const stale = [...ALLOWED].filter((a) => !findings.includes(a)).sort();

    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });
});
