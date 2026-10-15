/**
 * Structural guard for the schema conventions in
 * `.claude/rules/backend-data-model.md`.
 *
 * Every case re-derives its rule from the live catalog rather than checking a
 * hardcoded list, the way `indexRedundancy.test.ts` does. A hardcoded list is a
 * snapshot and cannot catch the next violation; a derived rule can.
 *
 * WHAT MAKES THESE GO RED: adding a table or column that breaks a convention,
 * OR fixing one without removing its entry from the allow-list below. Both are
 * deliberate. The second keeps the allow-list honest: an entry that no longer
 * corresponds to a real violation is debt that was paid but not recorded, and
 * leaving it there would let the same violation come back unnoticed.
 *
 * THE ALLOW-LISTS ARE THE DEBT LEDGER. They hold what the schema looked like on
 * the day this file was written, so the suite is green today. Each phase of the
 * redesign deletes entries. Nothing is ever ADDED to one without the reason
 * beside it: a new violation means the design is wrong, not that the test is.
 *
 * A rule that has no allow-list is one the schema already satisfies everywhere,
 * and those are the valuable ones. Keep them empty.
 */
import type { QueryResultRow } from 'pg';

import { testPool } from '../support/setupInProcess';

// ---------------------------------------------------------------------------
// Allow-lists: the violations that existed when this file was written.
// ---------------------------------------------------------------------------

/**
 * Tenant tables with no `unique (law_firm_id, id)`.
 *
 * The composite unique is what lets a child declare a COMPOSITE foreign key
 * `(law_firm_id, parent_id)`, which is the only formulation that makes it
 * impossible for a row to point at a parent in another firm. Without it, tenant
 * isolation on that relationship is a convention the services remember rather
 * than a constraint the database holds.
 */
const TENANT_KEY_ALLOWED = new Set<string>([
  'audit_events', 'billing_plan_periods', 'calendar_events', 'calendar_subscriptions',
  'calendar_sync_failures', 'conflict_check_records', 'event_outbox',
  'invitations',
  'invoice_adjustments', 'invoice_expected_payments',
  'invoice_line_items', 'invoice_payments', 'messages', 'notifications',
  // Deliberate, not debt: a field id is the client's name for a field, unique
  // only within its session (keyed `(session_id, id)`). Nothing references a
  // field row, and the composite FK `(law_firm_id, session_id)` holds tenancy.
  'signature_fields',
  'template_field_placements', 'template_folders', 'templates',
  'trust_deposit_fees', 'trust_interest_remittances',
  'trust_minimum_balances', 'trust_reconciliations', 'trust_transactions',
]);

/**
 * Tables with no `created_at`.
 *
 * Every one of these is a row someone inserted at a moment, and not knowing
 * when is a real gap: a backdated `invoice_payments.payment_date` cannot be
 * told from one recorded on the day (proposal B14).
 *
 * `invoice_line_items` and `invoice_payments` cannot be fixed by adding the
 * column. Both are REPLACE-ALL: `writeChildren` deletes every child row of an
 * invoice and reinserts the array on any update that supplies it, so a
 * `created_at default now()` would be rewritten to the time of the most recent
 * invoice edit. It would look like an audit column and behave like a
 * modification stamp for a different object. They need the row-addressable
 * model phase 5 introduces, not a column.
 *
 * `matter_members` has `joined_at`, but it is nullable and unset for a row
 * created any way other than an accepted invitation, so it is not a substitute.
 */
const CREATED_AT_ALLOWED = new Set<string>([
  'conversation_participants',
  'cron_pass_state',
  'firm_counters', 'invoice_expected_payments',
  'invoice_line_items', 'invoice_payments', 'matter_members',
  'rate_limits',
  'stripe_events', 'user_oauth_tokens', 'utbms_codes',
]);

/**
 * Tables with no `updated_at`, EXCLUDING the append-only ones below.
 *
 * `APPEND_ONLY` is not an allow-list. A row that is never updated must not
 * carry an `updated_at`, because the column would imply a mutation that a
 * trigger actively forbids. Those tables are correct and stay correct.
 */
const APPEND_ONLY = new Set<string>([
  'audit_events', 'signature_audit_events', 'note_versions', 'event_outbox',
  'digest_sends', 'activity_log',
  // Replace-set junctions: `tasks.repository.ts` deletes the whole set for a
  // task and reinserts it, so a row is created and destroyed but never updated.
  // They gained `created_at` in migration 0208 and must NOT gain `updated_at`.
  'task_assignees', 'task_clients', 'task_dependencies',
  // Same shape, added by migration 0218: an event's assignees are replaced as a
  // set, so a row is created and destroyed but never updated.
  'event_assignees',
  // The per-client narrowing of a share. `setVisibility` replaces the whole set
  // for one file rather than editing rows.
  'file_client_visibility',
  // The items a multi-item share link names, written once with the link.
  // Revoking acts on the link row, never on these.
  'file_share_link_items',
  // An upload's hold on quota. Inserted at upload-init and deleted at finalize,
  // cancel or the expiry purge; a reservation is never edited in place.
  'storage_reservations',
]);

const UPDATED_AT_ALLOWED = new Set<string>([
  'calendar_subscriptions',
  // A share link is written once and then revoked in place; migration 0236 gave
  // it `revoked_at` for exactly that, so there is no second kind of edit for an
  // `updated_at` to record.
  'file_share_links',
  'conflict_check_records', 'conversation_matters', 'conversation_participants',
  'court_catalog',
  'email_verification_whitelist', 'event_contacts',
  'firm_counters', 'intake_submissions', 'invoice_adjustments',
  'invoice_expected_payments', 'invoice_line_items',
  'invoice_payments', 'note_links',
  'note_templates', 'note_types', 'notifications', 'oauth_states',
  'rate_limits',
  'signature_participant_tokens',
  'stripe_events', 'user_oauth_tokens', 'utbms_codes',
]);

/**
 * Booleans without an `is_` / `has_` / `can_` prefix.
 *
 * The prefix is not decoration. `expenses.is_billed` once sat beside
 * `time_entries.billed` and `flat_fees.billed` for the same fact (all three
 * dropped by migration 0228, since nothing ever set them), and that kind of
 * inconsistency is exactly what produces a repository reading the wrong key.
 * Renaming is free here because Drizzle maps the column to the existing
 * JavaScript property name, so no API response changes.
 */
const BOOLEAN_PREFIX_ALLOWED = new Set<string>([
  'calendar_events.all_day', 'clients.invitation_failed',   'clients.portal_invite_pending',
  'contacts.one_time', 'conversations.hide_client_names', 'court_catalog.in_use',
  'deadline_set_templates.adjust_for_weekends', 'document_request_templates.archived',
  'events.all_day', 'events.client_visible', 'activities.billable',
  'files.client_visible',   'invitations.invitation_failed', 'invoices.payment_plan_enabled',
  'invoices.stripe_payment_requested',
  'law_firms.direct_charges_enabled', 'law_firms.storage_hard_limit',
  'law_firms.stripe_charges_enabled', 'law_firms.stripe_onboarding_complete',
  'matter_field_defs.archived', 'matter_field_defs.required',
  'matters.budget_includes_expenses', 'matters.payment_ongoing',
  'members.present_as_firm', 'messages.read', 'messages.read_by_client',
  'messages.read_by_firm', 'messages.sent_as_firm', 'note_links.created_from_note',
  'notifications.read',
  'signature_fields.required',
  'signature_participants.email_verified', 'signature_participants.requires_verification',
  'signature_sessions.email_signers_on_complete', 'tasks.all_day',
  'tasks.send_reminder_early', 'template_field_placements.bold',
  'template_field_placements.bullet_list', 'template_field_placements.italic',
  'trust_accounts.stripe_charges_enabled', 'trust_accounts.stripe_onboarding_complete',
]);

/**
 * `*_date` columns that are not `date`.
 *
 * `invoices.paid_date` is `timestamptz`, which is why it reads back as an ISO
 * string where every other `*_date` reads back as `'YYYY-MM-DD'`. The proposal
 * drops the column outright (the generated `balance_due_cents` is
 * authoritative), so this entry goes away with it rather than by a retype.
 */
const DATE_SUFFIX_ALLOWED = new Set<string>(['invoices.paid_date']);

/**
 * Columns that LOOK like a fixed vocabulary and are not.
 *
 * This is not an allow-list. Each entry is a decision, reached by tracing every
 * writer rather than by reading the column name, and each should stay. A CHECK
 * on an open vocabulary is a defect: it turns the next feature into a schema
 * migration, or refuses a write the application is right to make.
 *
 * The redesign proposal originally called for a CHECK on all 32 columns matching
 * `status` / `kind` / `type` / `*_type`. Auditing them moved 18 into migrations
 * 0209 and 0210 and moved these 11 here permanently.
 */
const OPEN_VOCABULARY = new Set<string>([
  // Real MIME strings from uploads. `uploadPolicy.ts` is a DENY-list, so
  // anything not explicitly dangerous is stored exactly as the client sent it.
  'files.mime_type', 'file_share_links.mime_type',
  'template_field_placements.image_mime_type',
  // About 21 values invented ad hoc across 10 files, with no constants file
  // anywhere. Needs that file first; a CHECK would only move the breakage.
  'notifications.type',
  // Enumerable today (82 constants in shared/events/eventTypes.ts, and all 117
  // emit sites use them) but designed to grow with every feature. Constraining
  // it couples ordinary feature work to a migration.
  'event_outbox.event_type',
  // A log field: mostly null, two literals today, no constants file.
  'audit_events.resource_type',
  // Validated as `z.string().max(100)`: a firm types its own court type.
  'courts.court_type',
  // One importer produces 11 values, but the table's own comment anticipates a
  // second source with a different vocabulary.
  'court_catalog.court_type',
  // Migration 0215 moved this into `calendar_sync_failures.payload`, where it is
  // a job argument rather than a column. It was read straight off the Microsoft
  // Graph webhook payload with no validation and persisted on the FAILURE path,
  // so a CHECK would have let an unexpected provider value turn "record this
  // failure so it can be retried" into a second failure inside the failure
  // handler, losing the record.
  // Thirteen literals, every one hardcoded at its call site, with no enum, no
  // Zod schema and no shared union type behind them. Adding the CHECK and
  // freezing the vocabulary are the same decision, and it needs a shared type
  // to back it rather than being a side effect of a migration.
  'activity_log.activity_type',
  // Only ever written as 'sent', by all three insert paths, and no UPDATE
  // touches it. A single-value CHECK would protect nothing while foreclosing the
  // delivery-status lifecycle the column was evidently added for.
  'messages.status',
  // The provider's document type (e.g. "org.iso.18013.5.1.mDL"), recorded as the
  // credential stated it. Issuers add types; a CHECK would refuse a valid one.
  'client_identity_verifications.doc_type',
]);

/**
 * Fixed-vocabulary columns still missing their CHECK.
 *
 * All three are the same blocked decision (proposal B24). `note_type` names a
 * `note_types.value`, but only HALF the vocabulary is in that table: eight
 * built-in types live as constants in `noteTypes.service.ts` and a row is
 * written only for a firm's custom type. Since `notes.note_type` defaults to
 * 'general', a foreign key or a CHECK today would reject notes in every firm
 * that has not customized that type. The fix is to seed the built-ins as rows,
 * which is a data change, not a constraint.
 */
const VOCABULARY_CHECK_ALLOWED = new Set<string>([
  'note_templates.note_type', 'note_versions.note_type', 'notes.note_type',
]);

/**
 * `(x_type, x_id)` pairs.
 *
 * A pair carries no foreign key, so the database cannot cascade it, cannot
 * enforce tenancy on it, and cannot stop it naming a row that does not exist.
 * `notes` and `events` use the exclusive arc instead (one nullable FK per
 * parent plus a CHECK), which is the pattern every new table follows.
 *
 * LOG_PAIRS is not an allow-list: three tables are allowed a pair permanently,
 * because they are logs whose target may legitimately be deleted. A foreign key
 * there would either block the delete or erase the log entry, and the point of
 * an audit row is that it outlives what it describes.
 */
const LOG_PAIRS = new Set<string>([
  'audit_events.resource_type', 'notifications.entity_type', 'event_outbox.event_type',
]);

const TYPE_ID_PAIR_ALLOWED = new Set<string>([
  'calendar_mappings.entity_type', 'invoices.billing_plan_type',
  'note_versions.note_type',
]);

/**
 * Columns that copy a name or an email another table owns.
 *
 * Each one is a cache with no invalidation: rename a user and every note they
 * wrote keeps the old name. `tasks` already joins for this and is the model.
 *
 * NAME_COLUMNS_OK is not an allow-list. These columns are the record rather
 * than a copy of one: an invoice snapshot frozen at issue is a legal document,
 * a signer's typed name is what they signed as, and a court catalog name is the
 * catalog's own data.
 */
const NAME_COLUMNS_OK = new Set<string>([
  // The invoice bill-to snapshot, frozen at issue. A legal record.
  'invoices.billing_client_name', 'invoices.billing_contact_name',
  'invoices.billing_contact_email', 'invoices.remit_to_name',
  // Reference data owned by the row itself.
  'court_catalog.full_name', 'court_catalog.short_name', 'trust_accounts.bank_name',
  'cron_pass_state.pass_name', 'template_field_placements.field_name',
  'template_field_placements.repeater_name', 'signature_templates.source_file_name',
  'word_templates.original_file_name',
  // What a person typed or where a message was sent, not a copy of a row.
  'signature_participants.signer_name', 'signature_sessions.notify_name',
  'signature_sessions.notify_email',
  'intake_submissions.sent_to_email', 'invitations.invitation_email',
  'conflict_check_records.query_name', 'conflict_check_records.query_email',
  'audit_events.actor_email', 'events.location_name',
  // A billing plan's delivery address, set per plan rather than copied.
  'billing_plans.billing_email', 'invoices.billing_email',
  // The label a document was shared or signed under. Chosen at share time and
  // deliberately independent of whatever the underlying object is later named.
  'file_share_links.display_name', 'signature_sessions.file_name',
  // The firm's own label for an invoice, unique within its billing context and
  // prefix-searched. It names the invoice, not a row in another table.
  'invoices.invoice_name',
  // The name the identity credential states, which is the verification record
  // itself. Comparing it with the client's own name is the point of keeping it.
  'client_identity_verifications.verified_given_name',
  'client_identity_verifications.verified_family_name',
]);

/**
 * Names and emails that ARE copies of another table's data, still here.
 *
 * This is a debt list, not a design. Each entry says what it copies and what
 * has to happen for it to go, so the next reader is not left deciding whether
 * a line is a considered exception or something nobody got to. An entry naming
 * a column that no longer exists fails the last test in this rule's group.
 */
const COPIED_NAME_ALLOWED = new Set<string>([
  // Copies of `users.name`, all three joinable at read. `messages.sender_name`
  // is the expensive one: the RLS masking functions read it, so removing it
  // simplifies those as well as the table.
  'invoice_line_items.user_name', 'activity_log.actor_name', 'messages.sender_name',
  // Copies of the client the invoice bills, taken BEFORE the bill-to snapshot
  // existed. `invoices.billing_client_name` and `billing_contact_email` are the
  // frozen legal record and are in the list above; these two are the older
  // draft-path copies that the snapshot did not replace.
  'invoices.client_email', 'invoices.client_name',
  // A copy of `billing_plans.name`, joinable through `invoices.billing_plan_id`.
  'invoices.billing_plan_name',
]);

/**
 * Foreign keys left on the NO ACTION default.
 *
 * Empty, and it should stay that way. Five keys sat here until migration 0206
 * spelled them `on delete restrict`: three on `trust_transactions`, one on
 * `trust_reconciliations` and the deliberate one on `conversations`. All five
 * already behaved as RESTRICT, since NO ACTION differs only for a deferred
 * constraint and none is deferred, so 0206 changed nothing at runtime and made
 * the intent readable at the declaration.
 */
const UNNAMED_DELETE_ACTION_ALLOWED = new Set<string>([]);

// ---------------------------------------------------------------------------
// Catalog queries. Each returns the violations of one rule, derived not listed.
// ---------------------------------------------------------------------------

async function rows<T extends QueryResultRow = { name: string }>(sql: string): Promise<T[]> {
  const result = await testPool.query<T>(sql);
  return result.rows;
}

/**
 * Compare findings against an allow-list in BOTH directions.
 *
 * The forward direction catches a new violation. The reverse catches a fixed
 * one whose entry was left behind, which matters because a stale entry would
 * silently re-permit the violation if it ever came back.
 */
function expectOnly(findings: string[], allowed: Set<string>) {
  const unexpected = findings.filter((f) => !allowed.has(f)).sort();
  const stale = [...allowed].filter((a) => !findings.includes(a)).sort();
  expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
}

describe('schema conventions', () => {
  // -------------------------------------------------------------------------
  // Rule 1: tenancy
  // -------------------------------------------------------------------------
  it('every tenant table has unique (law_firm_id, id)', async () => {
    const found = await rows(`
      select c.table_name as name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public'
         and t.table_type = 'BASE TABLE'
         and c.column_name = 'law_firm_id'
         and exists (
           select 1 from information_schema.columns i
            where i.table_schema = 'public' and i.table_name = c.table_name
              and i.column_name = 'id')
         and not exists (
           select 1
             from pg_constraint k
             join pg_class r on r.oid = k.conrelid
            where r.relname = c.table_name
              and r.relnamespace = 'public'::regnamespace
              and k.contype in ('u', 'p')
              and k.conkey @> array[
                    (select attnum from pg_attribute
                      where attrelid = r.oid and attname = 'law_firm_id')]::smallint[]
              and k.conkey @> array[
                    (select attnum from pg_attribute
                      where attrelid = r.oid and attname = 'id')]::smallint[]
              and array_length(k.conkey, 1) = 2)
       order by 1`);
    expectOnly(found.map((r) => r.name), TENANT_KEY_ALLOWED);
  });

  // -------------------------------------------------------------------------
  // Rule 3: timestamps
  // -------------------------------------------------------------------------
  it('every table has created_at', async () => {
    const found = await rows(`
      select t.table_name as name
        from information_schema.tables t
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and not exists (
           select 1 from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = t.table_name
              and c.column_name = 'created_at')
       order by 1`);
    expectOnly(found.map((r) => r.name), CREATED_AT_ALLOWED);
  });

  it('every mutable table has updated_at', async () => {
    const found = await rows(`
      select t.table_name as name
        from information_schema.tables t
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and not exists (
           select 1 from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = t.table_name
              and c.column_name = 'updated_at')
       order by 1`);
    const mutable = found.map((r) => r.name).filter((n) => !APPEND_ONLY.has(n));
    expectOnly(mutable, UPDATED_AT_ALLOWED);
  });

  it('an append-only table carries created_at and no updated_at', async () => {
    const found = await rows(`
      select table_name as name from information_schema.columns
       where table_schema = 'public' and column_name = 'updated_at'
       order by 1`);
    const withUpdatedAt = new Set(found.map((r) => r.name));
    const wrong = [...APPEND_ONLY].filter((t) => withUpdatedAt.has(t)).sort();
    expect(wrong).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule 4: names and types
  // -------------------------------------------------------------------------
  it('every boolean is prefixed is_, has_ or can_', async () => {
    const found = await rows(`
      select table_name || '.' || column_name as name
        from information_schema.columns
       where table_schema = 'public' and data_type = 'boolean'
         and column_name !~ '^(is|has|can)_'
       order by 1`);
    expectOnly(found.map((r) => r.name), BOOLEAN_PREFIX_ALLOWED);
  });

  it('every *_at column is timestamptz', async () => {
    const found = await rows(`
      select table_name || '.' || column_name || ' is ' || data_type as name
        from information_schema.columns
       where table_schema = 'public' and column_name like '%\\_at'
         and data_type <> 'timestamp with time zone'
       order by 1`);
    expect(found.map((r) => r.name)).toEqual([]);
  });

  it('every *_date column is date', async () => {
    const found = await rows(`
      select table_name || '.' || column_name as name
        from information_schema.columns
       where table_schema = 'public' and column_name like '%\\_date'
         and data_type <> 'date'
       order by 1`);
    expectOnly(found.map((r) => r.name), DATE_SUFFIX_ALLOWED);
  });

  it('every *_cents column is bigint', async () => {
    const found = await rows(`
      select table_name || '.' || column_name || ' is ' || data_type as name
        from information_schema.columns
       where table_schema = 'public' and column_name like '%\\_cents'
         and data_type <> 'bigint'
       order by 1`);
    expect(found.map((r) => r.name)).toEqual([]);
  });

  it('no money column is a float', async () => {
    const found = await rows(`
      select table_name || '.' || column_name || ' is ' || data_type as name
        from information_schema.columns
       where table_schema = 'public'
         and data_type in ('real', 'double precision')
       order by 1`);
    expect(found.map((r) => r.name)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule 5: vocabularies
  // -------------------------------------------------------------------------
  it('every fixed-vocabulary column carries a CHECK or a foreign key', async () => {
    const found = await rows(`
      select c.table_name || '.' || c.column_name as name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and c.data_type = 'text'
         and (c.column_name in ('status', 'kind', 'type')
              or c.column_name like '%\\_status'
              or c.column_name like '%\\_kind'
              or c.column_name like '%\\_type')
         and not exists (
           select 1 from pg_constraint k
             join pg_class r on r.oid = k.conrelid
            where r.relname = c.table_name
              and r.relnamespace = 'public'::regnamespace
              and k.contype = 'c'
              and pg_get_constraintdef(k.oid) ~ ('\\m' || c.column_name || '\\M'))
         and not exists (
           select 1 from pg_constraint k
             join pg_class r on r.oid = k.conrelid
            where r.relname = c.table_name
              and r.relnamespace = 'public'::regnamespace
              and k.contype = 'f'
              and k.conkey @> array[
                    (select attnum from pg_attribute
                      where attrelid = r.oid and attname = c.column_name)]::smallint[])
       order by 1`);
    const closed = found.map((r) => r.name).filter((n) => !OPEN_VOCABULARY.has(n));
    expectOnly(closed, VOCABULARY_CHECK_ALLOWED);
  });

  it('no column uses a Postgres enum type', async () => {
    // Adding a value to an enum is DDL, and a value can never be retired. A
    // text column with a CHECK does the same job and can be changed in a
    // migration like anything else.
    const found = await rows(`
      select c.relname || '.' || a.attname || ' is enum ' || tt.typname as name
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_type tt on tt.oid = a.atttypid
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
         and a.attnum > 0 and tt.typtype = 'e'
       order by 1`);
    expect(found.map((r) => r.name)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule 6: one parent among several
  // -------------------------------------------------------------------------
  it('no (type, id) pair outside the three log tables', async () => {
    const found = await rows(`
      select a.table_name || '.' || a.column_name as name
        from information_schema.columns a
        join information_schema.columns b
          on b.table_schema = 'public' and b.table_name = a.table_name
         and b.column_name = regexp_replace(a.column_name, '_type$', '_id')
       where a.table_schema = 'public' and a.column_name like '%\\_type'
       order by 1`);
    const pairs = found.map((r) => r.name).filter((n) => !LOG_PAIRS.has(n));
    expectOnly(pairs, TYPE_ID_PAIR_ALLOWED);
  });

  it('every exclusive arc has a CHECK that exactly one parent is set', async () => {
    // An arc is a table carrying two or more NULLABLE parent columns. Nullable
    // is what makes it an arc: a junction like `matter_clients` carries both
    // `matter_id` and `client_id` as NOT NULL parts of its primary key, which
    // means "this pair", not "one of these", and it is correctly excluded.
    //
    // Without the CHECK an arc is two tables' worth of rows in one with no rule
    // saying which: a row naming both parents appears in both parents' lists,
    // and a row naming neither appears in nobody's while still counting toward
    // the firm's totals. `notes` and `events` are the model.
    //
    // The CHECK is recognized by naming two or more of the arms, not by its
    // spelling. Three spellings are already in use and all are correct:
    // `num_nonnulls(...) = 1`, the `::integer` sum, and `(a is not null) <> (b
    // is not null)`.
    const found = await rows<{ name: string }>(`
      with arcs as (
        select c.table_name,
               array_agg(c.column_name order by c.column_name) as arms
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
           and c.column_name in ('matter_id', 'task_id', 'client_id')
           and c.is_nullable = 'YES'
         group by c.table_name
        having count(*) > 1
      )
      select a.table_name || ' (' || array_to_string(a.arms, ',') || ')' as name
        from arcs a
       where not exists (
         select 1 from pg_constraint k
           join pg_class r on r.oid = k.conrelid
          where r.relname = a.table_name
            and r.relnamespace = 'public'::regnamespace
            and k.contype = 'c'
            and (select count(*) from unnest(a.arms) arm
                  where pg_get_constraintdef(k.oid) ~ ('\\m' || arm || '\\M')) >= 2)
       order by 1`);
    // `note_replies` used to appear here carrying its note's three parent
    // columns as copies; migration 0207 dropped them, so it is no longer an arc
    // at all.
    //
    // `files` is the one genuine arc with no CHECK, and it gains one when the
    // `scope` column goes in phase 7.
    //
    // The other three are not arcs, and no CHECK belongs on them. The heuristic
    // cannot tell an arc from two independent nullable columns, so each is
    // listed with why it is independent:
    //
    //   invoices             the arc is (matter_id, client_context_id) and it
    //                        HAS its CHECK. `client_id` is a third thing, the
    //                        client being billed.
    //   trust_transactions   `client_id` is whose money it is and is required
    //                        by the ledger; `matter_id` is optional attribution
    //                        on top of it. Both set is the normal case.
    //   conversations        a thread can be with a client, about a matter, or
    //                        both.
    expectOnly(found.map((r) => r.name), new Set([
      'conversations (client_id,matter_id)',
      'invoices (client_id,matter_id)',
      'trust_transactions (client_id,matter_id)',
    ]));
  });

  // -------------------------------------------------------------------------
  // Rule 8: nothing is copied that can be joined
  // -------------------------------------------------------------------------
  it('no column copies a name or email another table owns', async () => {
    const found = await rows(`
      select table_name || '.' || column_name as name
        from information_schema.columns
       where table_schema = 'public'
         and column_name ~ '_(name|email)$'
       order by 1`);
    const copies = found.map((r) => r.name).filter((n) => !NAME_COLUMNS_OK.has(n));
    expectOnly(copies, COPIED_NAME_ALLOWED);
  });

  it('both name lists mention only columns that still exist', async () => {
    // A list entry outlives the column it excused. The next reader takes the
    // list as a description of the schema, and a dropped column's entry quietly
    // pre-approves whatever is added back under that name later.
    const found = await rows(`
      select table_name || '.' || column_name as name
        from information_schema.columns
       where table_schema = 'public'
         and column_name ~ '_(name|email)$'`);
    const real = new Set(found.map((r) => r.name));
    const stale = [...NAME_COLUMNS_OK, ...COPIED_NAME_ALLOWED].filter((n) => !real.has(n));
    expect(stale).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule 11: deletes
  // -------------------------------------------------------------------------
  it('every foreign key names an on delete action', async () => {
    // The default is NO ACTION, which is not a decision anyone made. Every one
    // of these five wants RESTRICT and behaves as RESTRICT today, since neither
    // is deferred anywhere; spelling it makes the intent readable at the
    // declaration instead of inferable from the absence of a clause.
    const found = await rows(`
      select r.relname || '.' || k.conname as name
        from pg_constraint k
        join pg_class r on r.oid = k.conrelid
       where k.contype = 'f' and r.relnamespace = 'public'::regnamespace
         and k.confdeltype = 'a'
       order by 1`);
    expectOnly(found.map((r) => r.name), UNNAMED_DELETE_ACTION_ALLOWED);
  });
});
