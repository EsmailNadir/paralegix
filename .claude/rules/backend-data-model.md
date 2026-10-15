---
paths:
  - "backend/db/**"
  - "backend/src/**/*.repository.ts"
  - "backend/src/shared/database/**"
---

## Table Inventory

`backend/db/schema.sql` is the authority (105 `CREATE TABLE`s); this is a curated map, not the full list.
Grep the schema before assuming a table does not exist. **`schema.sql` is GENERATED** from the
per-domain files in `backend/db/schema/*.sql` by `npm run db:schema:build`. Edit a domain file,
never `schema.sql`, and never change a table's shape on the way in: a shape change is a numbered
migration first and a domain-file edit second, in the same change. `npm run db:catalog-parity`
proves the two agree.

- `users` — PK is the Firebase UID (`text`, not uuid). `email` is NOT unique; the UID is the identity key.
- `law_firms` — tenant root. `plan` (jsonb), `settings` (jsonb), Stripe + storage-quota columns.
- `members` (`law_firm_id`,`user_id`), `roles` (permissions `text[]`) — firm membership & RBAC.
- `clients` (`client_type` 'person'|'company', immutable after insert). Portal identity for a person lives on `clients.user_id` directly; a company can never carry it there. A person's own related contacts (a guardian, an assistant) are `contact_clients` links into the firm-wide `contacts` directory; a company's people are real, standalone Person `clients` rows linked via `client_company_links` (`relationship`, `is_primary`, billing delivery/access flags), not directory contacts.
- `contacts` — firm-wide, matter-independent contact directory (opposing counsel, experts, adjusters, judges). The per-matter role lives on `matter_contacts.role`, since the same contact plays different roles on different matters.
- `matters` + junctions `matter_members`, `matter_clients`.
- `tasks` + junctions `task_assignees`, `task_clients`, `task_dependencies`, plus `task_subtasks`. Denormalized arrays and name copies are NOT stored; they are derived at read time via JOINs. See `tasks.repository.ts`.
- Billing: `invoices` (+ `invoice_line_items`, `invoice_payments`, `invoice_expected_payments`, `invoice_adjustments` with `direction` credit|charge and `kind`), `activities` (`kind` time|expense|flat_fee: the former `time_entries`, `expenses` and `flat_fees`, ids preserved; `amount_cents` is generated, from hours times `coalesce(resolved_rate_cents, rate_cents, 0)` for time (so it can be summed for unbilled value) and from the entered `charge_cents` otherwise; billed-ness is derived from `invoice_line_items.source_id`; a `before update or delete` trigger freezes a row that is on an invoice; a retainer period's coverage is `billing_plan_period_id` + `coverage` on the row), `billing_codes` (`kind` charge|expense; the charge-code and expense-category routes each filter on their kind), `billing_plans` (+ `billing_plan_periods`).
- Trust: `trust_accounts`, `trust_transactions` (append-only — a DB trigger blocks edit/delete of completed entries; corrections are reversing entries), `trust_reconciliations`, `trust_minimum_balances` (evergreen-retainer replenishment thresholds), `trust_interest_remittances` (IOLTA remittance tracking), `trust_deposit_fees`.
- Calendar: `calendar_events` (events synced INTO Paralegix from Google/Outlook) and `events` (the firm own records, which sync OUT; one table for both parents, with nullable `matter_id`/`client_id` and a CHECK that exactly one is set - it replaced `matter_events` and `client_events`), plus sync-engine tables `calendar_mappings`, `calendar_subscriptions` (one table discriminated by `provider`; it replaced the separate `google_watch_channels` and `outlook_subscriptions`), the `event_contacts` join table (formerly `matter_event_contacts` / `client_event_contacts`), and `event_assignees` (one row per event and user; the former `events.assigned_to` jsonb array).
- Messaging: `conversations`, `messages`, `conversation_participants` (group membership + per-participant read cursor). **RLS enabled** (Supabase Realtime reads via a Firebase-UID JWT; the backend writes as `postgres` and bypasses RLS). A client the firm added before they have a portal account is a participant row with `client_id` set and `participant_user_id` null; it gains the user id when they register (the former `conversation_pending_clients`). `conversation_matters` is not RLS-enabled.
- Signatures: `signature_sessions` (PK is `id uuid`; `token` is unique and is the public link key; every child keys on `session_id uuid`, with a composite `(law_firm_id, session_id)` foreign key), `signature_participants`, `signature_fields`, `signature_templates`, `signature_audit_events` (append-only; "last viewed" is `max(created_at)` per actor over the two `*.viewed` types, which replaced `signature_session_views`), `signature_participant_tokens`, and `signature_challenges` (one row per participant per gate, `kind` otp|access_code, holding the code hash, the two attempt counters and the lock; `email_verified` stays on the participant because passing the one-time code verifies the person, not the code).
- Matter configuration & activity: `matter_field_defs` + `matters.custom_fields`, `matter_stage_pipelines` (named, optionally practice-area-scoped; at most one default per scope) + `matter_stages` (ordered, branchable via `parent_stage_id`; `matters.stage_id`/`stage_pipeline_id` point at the current ones), `matter_contacts`, `activity_log` (exclusive arc over matter, client and task; formerly `matter_activity`), `matter_categories`, `deadline_set_templates`, `legal_holds` (one row per hold over matter, client or file, released not deleted; a `before delete` trigger on `matters` and `clients` refuses while a hold is live).
- Leads & intake: `leads` + `lead_stages` (same branching shape as `matter_stages`), `intake_form_templates` (public-token forms) + `intake_submissions`, `conflict_check_records`.
- Documents & files: `document_requests` (+ items and templates), `files` (THE FOLDER TREE: a folder is a row, a file is a row plus one object at `objects/{the row's id}`, and the tree is `parent_id`. Storage holds bytes and nothing else; an object path is opaque and is never parsed. `npm run db:files-tree` enforces that. See `docs/features/files.md`), `attachments` (a file attached to a parent, exclusive arc over note, note reply, message, task, event, activity and document-request item; `created_by` is who attached it, which is how the portal tells a client's own upload from one the firm linked; it replaced `document_request_fulfillments` and, since migration 0260, is the ONLY place a note, note reply or task records what it has attached; `sort_order` (0262) carries the position those three used to get free from a jsonb array, and is null on every other arc. `messages.attachments` is the one jsonb array left: a conversation attachment is written straight to a conversation prefix and has no `files` row to point at), `file_client_access` (one row per file per client user: shared, notified and first-seen; it replaced `client_document_views` and `pending_share_notifications`), `file_share_links`, `templates`/`template_folders`, `template_field_placements`. `files` has NO exclusive arc: a matter-linked task's document sets both `matter_id` and `task_id` on purpose, and shares the matter's root. `file_client_visibility` narrows a share to named clients.
- Notes: ONE `notes` table for all three parents (matter, client, task), plus `note_versions`, `note_replies`, `note_links`, `note_types` and `note_templates`. The former per-parent tables (`matter_notes`, `client_notes`, `task_notes` and their version/reply siblings) were merged; do not reference them.
- Infrastructure & ops: `event_outbox` (durable backstop for the event bus; see `.claude/rules/backend-events.md`), `stripe_events` (webhook idempotency), `cron_pass_state` (reminder/reconciliation cron bookkeeping), `rate_limits` (the Postgres-backed rate-limit store), `lock_leases` (the lease rows behind `withLock`/`tryLock`, which hold no connection while locked), `oauth_states`, `digest_sends`, `email_verification_whitelist`, `calendar_sync_failures` (one retry queue keyed by `(kind, dedupe_key)` with a jsonb payload; it replaced `calendar_webhook_failures` and `google_watch_channel_stop_failures`).
- Reference data: `utbms_codes`, `court_catalog` (the only remaining full-text-search table), `practice_areas`, `courts`.
- Reminders: `reminders` holds invoice, event and signature scheduling plus legacy task counters. Task sends use `task_reminder_deliveries`, scoped by firm, task and a hash of the normalized recipient email. Each recipient has an expiring claim token and its own successful-send window. Invoice claims remain inside the invoice row lock; take that locking read separately before reading joined reminder state. `next_run_at` is unused.
- Other: `notifications`, `invitations` (unified and token-based; `token` is unique, `invite_type` distinguishes member vs client), `user_oauth_tokens`, `firm_counters`, `audit_events` (append-only security/data-access log backing the `audit` module). `users` carries `timezone` and `preferences` itself (the `user_settings` satellite was folded in) and `deleted_at` marks the tombstone the privacy erase leaves; every `*_by` and `*user_id` column is a real foreign key to `users`, and every `client_id` a real key to `clients`.

### The abandoned CRM cutover is gone

`parties`, `client_relations`, `pipelines`, `stages` and `billing_rates` were created and
backfilled once by migrations 0237 and 0239, then never written or read. Migration 0250 dropped
all five, along with the four `party_id` columns that pointed into `parties`. The authoritative
tables are `clients`/`contacts`/`leads`, `client_company_links`, and the
`matter_stage_pipelines` / `matter_stages` / `lead_stages` trio.

## A column that looks unused is not proof that it is

Find the readers before proposing a drop, then look for the WRITERS separately: a reader is
not proof of life. Five `contact_clients` columns survived two audits on a reader alone, and
nothing had written them since migration 0174. `invoices.invoice_name` looks dead and is not:
it is the firm's own label for an invoice, unique within its billing context.
`templates.html` and `notes.client_visible` were examples here until migrations 0251 and 0032
dropped them, which is the other half of the rule: an example ages, so re-check before quoting
one.

## Conventions

`backend/tests/schema/conventions.test.ts` and `fkIndexes.test.ts` enforce these against
`information_schema` and `pg_constraint`, so a table that breaks one fails CI. Each holds an
allow-list of today's violations with the reason beside each entry. **The allow-lists only
shrink.** They are checked in both directions, so fixing a violation without deleting its
entry also fails: a stale entry would silently re-permit the violation later.

1. **Tenant.** Every tenant-owned table has `law_firm_id uuid not null references
   law_firms(id) on delete cascade` and `unique (law_firm_id, id)`. Every FK to a tenant row
   is composite: `foreign key (law_firm_id, x_id) references x (law_firm_id, id)`. Exception,
   documented and permanent: a nullable pointer that must `set null` on delete
   (`practice_area_id`, `court_id`, `stage_id`, `role_id`) stays single-column, because a
   composite `set null` nulls the NOT NULL tenant column and fails with 23502.
2. **Ids.** `id uuid not null default gen_random_uuid()`, `primary key (id)`. A `text` id only
   where an external system allocates it (`users.id` is a Firebase UID, calendar subscription
   ids are provider-issued). A secret is never a primary key; give it its own `unique` column.
3. **Timestamps.** Every mutable table has `created_at` and `updated_at`, both `timestamptz
   not null default now()`. Never write `updated_at` from application code; the `set_updated_at`
   trigger does it. An append-only table carries `created_at` only, and must NOT have
   `updated_at`: the column would imply a mutation its trigger forbids.
4. **Names.** Booleans start with `is_`, `has_` or `can_`. `*_at` is `timestamptz`. `*_date` is
   `date`. `*_cents` is `bigint`, never a float. `*_id` is a foreign key. `kind` discriminates
   rows in one table; `status` is a lifecycle. A hidden-but-kept row uses `archived_at`, never
   `is_archived`, `archived` or `status = 'archived'`.
5. **Vocabularies.** A fixed list is `text` with `check (col in (...))`, mirrored from the Zod
   enum in the module's `*.validation.ts`. Never `create type ... as enum`: adding a value is
   DDL and a value can never be retired. A list the firm edits is a table, referenced by FK.
6. **One parent among several.** Use the exclusive arc, never a `(type, id)` pair:

   ```sql
   matter_id uuid, task_id uuid, client_id uuid,
   check (num_nonnulls(matter_id, task_id, client_id) = 1),
   foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
   -- one composite FK per arm, one partial index per arm
   ```

   `notes` and `events` are the model. A `(type, id)` pair carries no foreign key, so nothing
   cascades it and nothing stops it naming a row in another firm. It is allowed only on
   `notifications`, `audit_events` and `event_outbox`, whose targets may legitimately be deleted.
7. **jsonb** holds settings, field values, rule bodies (`recurrence`), consent records and
   snapshots. It never holds a list of ids the app joins on, and never a copied name. Relations
   are rows; names are joins.
8. **Nothing is copied that can be joined.** No `created_by_name`, `client_name`, `court_name`.
   The one exception is a legal record frozen at a moment: the `billing_*` group on `invoices`,
   written once at issue and commented as a snapshot.
9. **Indexes.** `law_firm_id` leads. One partial index per arc arm. Every FK column has an index
   whose FIRST column is that column, or the cascade delete of a parent scans the whole child
   table. Partial indexes for hot predicates (`where archived_at is null`). No trigram GIN
   without an `explain` showing it changes the plan. Declare indexes directly after their table.
10. **Deletes.** Every FK names its `on delete` action: `cascade` for children, `set null` for
    pointers, `restrict` for money and trust rows. The service pre-check gives the friendly
    error; the constraint gives the guarantee.
11. **Compliance guarantees live in triggers**, not in service code: `trust_txn_immutable`,
    `audit_events_immutable`, `signature_audit_immutable`. Never relax one; add a reversing row.

### Do not touch

The `trust_transactions` append-only trigger and its void lineage. The running-balance columns
on trust transactions. RLS policies and the `SECURITY DEFINER` helpers on messaging,
notifications and signatures. `court_catalog`'s tsvector. The single-column `set null` FKs in
rule 1. `calendar_events.stable_id`. `matter_clients.billing_portion_bp` as basis points. The
`contact_clients` roster columns.

### Direct-charge columns

`law_firms.direct_charges_enabled` and `invoice_payments.charge_model` are live: Standard
onboarding sets the flag, `invoiceChargeScope` in `stripe.service.ts` reads it, and the invoice
payment rows record which model charged them (`docs/DIRECT_CHARGE_MIGRATION.md`).
`trust_transactions.charge_model` is still read by nothing, because trust deposits stay
destination charges; it holds its default and must not be dropped.

Adding or changing a table, column, index or migration is the `new-migration` skill.
