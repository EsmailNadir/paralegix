-- =====================================================================
-- IDENTITY & TENANCY
-- =====================================================================

create table if not exists users (
  id                    text primary key,                 -- Firebase UID
  email                 citext not null,
  name                  text,
  photo_object_path     text,                             -- per-user profile picture (GCS object path; migration 0101)
  user_type             text not null default 'pending'
                          check (user_type in ('firm_member','client','pending')),
  is_admin              boolean not null default false,   -- platform super-admin (migration 0023)
  terms_accepted_at     timestamptz,
  privacy_accepted_at   timestamptz,
  consent_version       text,
  consent_ip            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Folded off the 1:1 `user_settings` satellite by migration 0217.
  timezone         text,
  preferences      jsonb not null default '{}',
  -- Set by the privacy erase, which anonymizes this row rather than deleting
  -- it so every reference to the account stays valid (migration 0224). A live
  -- account has this null; a tombstone has it set.
  deleted_at       timestamptz,
  identity_erased_at timestamptz
);
comment on column users.deleted_at is
  'Set by the privacy erase when the account is anonymized. The row is kept as a tombstone so every reference to it stays valid; this column is what distinguishes a tombstone from a live account.';
comment on column users.identity_erased_at is
  'Set only after privacy identity cleanup, including Firebase deletion, completes. A deleted_at tombstone with this null remains queued for recovery.';
create index if not exists users_pending_erasure_idx on users (deleted_at)
  where deleted_at is not null and identity_erased_at is null;
-- NOTE: email is NOT unique; duplicate and blank emails are possible, so the
-- Firebase UID (users.id) is the real identity key.
create index if not exists users_email_idx on users (email);
-- Supports findUserByEmail's `where lower(email) = $1` predicate.
create index if not exists users_lower_email_idx on users (lower(email));
-- Admin console list sorts, newest first, across every firm (migration 0132).
-- These are global rather than per-firm on purpose: the admin console reads
-- the whole table, so a law_firm_id-leading index cannot serve the sort.
create index if not exists users_created_at_idx on users (created_at desc);

-- DB-backed email-verification whitelist. Auth treats an address as verified if
-- it is on the EMAIL_VERIFICATION_WHITELIST env var OR in this table, so admins
-- can whitelist test accounts live (no redeploy). See shared/utils/emailWhitelist.js.
create table if not exists email_verification_whitelist (
  email       citext primary key,
  note        text,
  created_by  text references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
-- Serves the on-delete walk of email_verification_whitelist_created_by_fkey (migration 0224).
create index if not exists email_verification_whitelist_created_by_idx on email_verification_whitelist (created_by);

create table if not exists law_firms (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  description               text,
  address                   text,
  city                      text,
  state                     text,
  zip                       text,
  phone                     text,
  website                   text,
  email                     citext,
  logo_object_path          text,
  plan_id                   text not null default 'starter'
                              check (plan_id in ('starter','basic','professional','enterprise')),
  billing_status            text not null default 'comped'
                              check (billing_status in ('comped','active','trialing','incomplete','past_due','canceled')),
  plan                      jsonb not null default '{}',
  stripe_account_id         text,
  stripe_charges_enabled    boolean not null default false,
  stripe_onboarding_complete boolean not null default false,
  -- Direct-charge migration (docs/DIRECT_CHARGE_MIGRATION.md) cutover flag. When true,
  -- client payments are created as DIRECT charges on this firm's connected account (the
  -- firm is merchant of record and bears its own disputes) instead of destination
  -- charges on the platform. Default false = current destination-charge behavior.
  -- NOT READ BY ANY CODE PATH YET, and deliberately so: this is Phase 0 of that
  -- migration, which lands the column ahead of the behaviour. Not dead weight.
  direct_charges_enabled    boolean not null default false,
  storage_quota_bytes       bigint check (storage_quota_bytes is null or storage_quota_bytes >= 0),
  storage_used_bytes        bigint not null default 0 check (storage_used_bytes >= 0),
  -- Retired. Upload reservations are rows in `storage_reservations` (migration
  -- 0015) and nothing adds to this column any more. It stays until a contract
  -- migration folds any remaining balance out of `storage_used_bytes` and drops
  -- it; the recount zeroes it until then so that fold stays accurate.
  storage_reserved_bytes    bigint not null default 0 check (storage_reserved_bytes >= 0),
  storage_hard_limit        boolean not null default false,
  -- Percent-of-quota at which the UI warns. See DEFAULT_STORAGE_WARN_AT_PERCENT.
  storage_warn_at_percent   int not null default 85
                              check (storage_warn_at_percent between 1 and 100),
  -- When the usage figure last CHANGED (bumped by every upload/delete delta).
  storage_usage_updated_at  timestamptz,
  -- When usage was last RECONCILED against the bucket by a full recount, and the
  -- object count that recount saw. Distinct from the column above so a staleness
  -- check is not reset by ordinary uploads. See migration 0124.
  storage_usage_recounted_at timestamptz,
  storage_file_count        bigint,
  -- Soft-delete: see migration 0159 for the full rationale (retention protection
  -- for signature/invoice/matter records that legally cannot be destroyed the
  -- instant a firm account is closed).
  pending_deletion_at       timestamptz,
  deletion_purge_after      timestamptz,
  deletion_requested_by     text references users(id) on delete restrict,
  settings                  jsonb not null default '{}',
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (id)                                            -- redundant but documents composite-FK target
);
create index if not exists law_firms_plan_idx on law_firms (plan_id, billing_status);
-- Admin console list sorts, newest first, across every firm (migration 0132).
-- These are global rather than per-firm on purpose: the admin console reads
-- the whole table, so a law_firm_id-leading index cannot serve the sort.
create index if not exists law_firms_created_at_idx on law_firms (created_at desc);
create index if not exists law_firms_purge_eligible_idx
  on law_firms (deletion_purge_after)
  where pending_deletion_at is not null;

-- `plan_id` and `billing_status` are AUTHORITATIVE. They are not mirrored from
-- the `plan` jsonb and the jsonb does not carry `planId` / `billingStatus` at
-- all (migration 0200). Until then a BEFORE trigger copied those two keys into
-- these columns, and the same normalization was written a second time in
-- lawfirms.repository, with a comment saying the two had to match. The columns
-- are CHECK-constrained and indexed; the jsonb copy was neither.
--
-- The jsonb keeps the eighteen keys that have no duplicate: the Stripe
-- subscription/customer/price ids, billing interval and period bounds, the trial
-- and comp metadata, and the plan overrides. Readers still see `plan.planId` and
-- `plan.billingStatus`, filled from these columns by loadFirmPlan and
-- lawfirms.repository.toEntity.

create table if not exists user_oauth_tokens (
  user_id          text not null references users(id) on delete cascade,
  provider         text not null check (provider in ('google','microsoft')),
  access_token     text,
  refresh_token    text,
  token_updated_at timestamptz,
  expires_at       timestamptz,
  scope            text,
  meta             jsonb not null default '{}',
  -- Per-provider sync state, folded off `user_settings` by migration 0217. It
  -- lived there as seven columns that named Google explicitly, so a third
  -- provider meant three more columns and two more booleans on a table that has
  -- nothing to do with providers. Keyed by provider it is five columns, and a
  -- new provider is a new row.
  calendar_id      text,   -- which provider calendar this user syncs with
  app_calendar_id  text,   -- the calendar this app created there, if any
  sync_cursor      text,   -- incremental sync position (Google's syncToken)
  is_sync_to_provider   boolean not null default false,
  is_sync_from_provider boolean not null default false,
  primary key (user_id, provider)
);

create table if not exists oauth_states (
  state        text primary key,
  user_id      text references users(id) on delete cascade,
  provider     text check (provider in ('google','microsoft')),
  redirect_uri text,
  return_url   text,
  created_at   timestamptz not null default now()
);
-- Serves the on-delete walk of oauth_states_user_id_fkey (migration 0224).
create index if not exists oauth_states_user_id_idx on oauth_states (user_id);

create table if not exists firm_counters (
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  counter_type text not null check (counter_type in ('matter_reference','invoice_number')),
  next_val     bigint not null default 1,
  primary key (law_firm_id, counter_type)
);

-- Shared rate-limit store (migration 0079) backing the express-rate-limit
-- Postgres store, so per-IP/per-token caps are coordinated across instances.
-- Keyed by "<limiter-prefix>:<client-key>"; expired windows are swept by the store.
create table if not exists rate_limits (
  key         text primary key,
  hits        integer not null default 0,
  expires_at  timestamptz not null
);
create index if not exists rate_limits_expires_at_idx on rate_limits (expires_at);

-- Stripe webhook idempotency ledger, one row per (endpoint, event id). Each
-- webhook endpoint claims an event before running its handler: 'processing'
-- while a delivery holds it, 'done' once the handler succeeded. Keyed per
-- endpoint because both endpoints receive invoice.paid under the same event id
-- and each must process it. A 'processing' row older than the stale threshold
-- (STRIPE_EVENT_CLAIM_STALE_SECONDS) is reclaimed, so a process that died
-- mid-handler cannot strand the event. Migration 0045.
create table if not exists stripe_events (
  event_id     text not null,
  processed_at timestamptz,
  endpoint     text not null default 'payments',
  status       text not null default 'processing',
  claimed_at   timestamptz not null default now(),
  primary key (endpoint, event_id),
  constraint stripe_events_endpoint_check check (endpoint in ('payments', 'subscriptions')),
  constraint stripe_events_status_check check (status in ('processing', 'done')),
  constraint stripe_events_processed_when_done check ((status = 'done') = (processed_at is not null))
);

-- =====================================================================
-- MEMBERS & ROLES
-- =====================================================================

create table if not exists roles (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  is_built_in         boolean not null default false,
  permissions         text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  unique (law_firm_id, name)
);
create index if not exists roles_perms_gin on roles using gin (permissions);

create table if not exists members (
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  user_id                   text not null references users(id) on delete cascade,
  role_id                   uuid,
  is_owner                  boolean not null default false,
  default_hourly_rate_cents bigint check (default_hourly_rate_cents is null or default_hourly_rate_cents >= 0),
  present_as_firm           boolean not null default false,                     -- "send as firm" member preference (migration 0107)
  joined_at                 timestamptz,
  invited_at                timestamptz,
  invited_by                text references users(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (law_firm_id, user_id),
  -- Single column, not (law_firm_id, role_id). A composite key with ON DELETE
  -- SET NULL nulls EVERY column of the key, including the NOT NULL tenant
  -- column, so deleting a role that anyone held failed with 23502 (migration
  -- 0186). Tenant agreement is the application's job: the role is fetched with
  -- its own law_firm_id predicate, so a foreign role id resolves to null and
  -- the member degrades to the baseline.
  constraint members_role_fk foreign key (role_id) references roles(id) on delete set null
);
create index if not exists members_user_idx on members (user_id);
-- At most one owner per firm (migration 0223). Not "exactly one": a partial
-- unique cannot say "at least one", and a firm with two owners has no obvious
-- recovery while a firm with none does. The transfer flow demotes before it
-- promotes, inside one transaction, so it never violates this.
create unique index if not exists members_one_owner_per_firm_idx
  on members (law_firm_id) where is_owner;

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column law_firms.deletion_purge_after is 'Earliest the firm may be hard-purged (row + GCS bytes actually deleted, by the housekeeping cron). Computed at soft-delete time as pending_deletion_at plus the configured retention window (FIRM_DELETION_RETENTION_YEARS, default 10). Null while pending_deletion_at is null.';
comment on column law_firms.deletion_requested_by is 'User id who triggered the soft delete, for support/audit purposes when investigating a pending deletion.';
comment on column law_firms.pending_deletion_at is 'Set when firm deletion is requested (self-serve delete, or the sole owner leaving). Non-null means the firm is soft-deleted: access is revoked (assertLawFirmMembership / loadResolvedMember treat it as gone) and billing is stopped, but the row and every child record are retained until deletion_purge_after so retention-protected records (signatures, invoices, matters) cannot be destroyed before their legal retention window clears.';
comment on column law_firms.storage_reserved_bytes is 'Retired. Upload reservations live in storage_reservations; nothing adds to this column any more. The recount still zeroes it until a contract migration folds any remaining balance out of storage_used_bytes and drops it.';
