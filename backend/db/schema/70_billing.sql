-- =====================================================================
-- BILLING
-- =====================================================================

-- The firm's pick lists for work: charge codes (`kind = 'charge'`, which carry
-- an hourly rate) and expense categories (`kind = 'expense'`). One table since
-- migration 0231; the two route files each filter on their kind, so the API
-- did not change. Ids were preserved, so `activities.billing_code_id` (the
-- former `charge_code_id` and `expense_category_id`) points here unchanged.
create table if not exists billing_codes (
  id             uuid primary key default gen_random_uuid(),
  law_firm_id    uuid not null references law_firms(id) on delete cascade,
  kind           text not null check (kind in ('charge', 'expense')),
  code           text not null,
  name           text not null,
  is_active      boolean not null default true,
  -- Seeded by the application rather than entered by the firm. Only expense
  -- categories are seeded lazily today; charge codes are seeded at firm
  -- creation and were never flagged.
  is_default     boolean not null default false,
  sort_order     int,
  -- Charge codes only: the hourly rate in dollars, and per-member overrides.
  default_rate   numeric,
  default_rate_cents bigint check (default_rate_cents is null or default_rate_cents >= 0),
  member_rates   jsonb not null default '{}',
  -- Provenance link to the UTBMS code this was adopted from; null is a custom code.
  utbms_code_id  uuid references utbms_codes(id) on delete set null,
  created_by     text references users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, kind, code),
  constraint billing_codes_rate_only_on_charge check (
    kind = 'charge' or (default_rate is null and default_rate_cents is null and member_rates = '{}'::jsonb)
  )
);
create index if not exists billing_codes_firm_kind_idx on billing_codes (law_firm_id, kind, sort_order);
create index if not exists billing_codes_utbms_idx
  on billing_codes (law_firm_id, utbms_code_id) where utbms_code_id is not null;

create table if not exists invoices (
  id                          uuid not null default gen_random_uuid(),
  law_firm_id                 uuid not null references law_firms(id) on delete cascade,
  matter_id                     uuid,
  client_context_id           uuid references clients(id) on delete restrict,  -- part of the XOR check below; restrict, so a client with invoices cannot be deleted
  client_id                   uuid references clients(id) on delete set null,
  context_type                text
    check (context_type is null or context_type in ('matter', 'client')),
  invoice_name                text,
  invoice_number              text not null,
  invoice_date                date,
  due_date                    date,
  billing_email               citext,
  notes                       text,
  client_name                 text,
  client_email                citext,
  matter_client_id              uuid,
  remit_to                    text,
  remit_to_name               text,
  remit_to_address            text,
  remit_to_city               text,
  remit_to_state              text,
  remit_to_zip                text,
  -- 'draft' is the column default, written by _createTx and then overwritten in
  -- the same transaction by deriveInvoiceStatus, which never returns it, so no
  -- stored invoice reads 'draft'. 'voided' is written by the void route and is
  -- terminal: deriveInvoiceStatus keeps it, every money total excludes it, and
  -- the billed-source trigger ignores line items on it.
  status                      text not null default 'draft'
    check (status in ('draft', 'outstanding', 'overdue', 'partially_paid', 'paid', 'credited', 'voided')),
  total_cents                 bigint not null default 0 check (total_cents >= 0),
  flat_fees_amount_cents      bigint not null default 0,
  tax_rate                    numeric,                       -- optional sales/gross-receipts tax %
  tax_cents                   bigint not null default 0,     -- computed tax, already included in total_cents
  total_hours                 numeric,
  amount_paid_cents           bigint not null default 0 check (amount_paid_cents >= 0),
  -- Accounts for write-offs so fully-written-off invoices are not treated as
  -- outstanding by invoices_outstanding_idx. Matches the app's remainingBalance
  -- (total - amountPaid - totalWrittenOff).
  balance_due_cents           bigint generated always as (total_cents - amount_paid_cents - coalesce(total_written_off_cents, 0)) stored,
  total_written_off_cents     bigint not null default 0,
  is_paid                     boolean not null default false,
  paid_date                   timestamptz,
  next_payment_date           date,
  -- payment-plan header (the installment schedule lives in invoice_expected_payments)
  payment_plan_enabled        boolean not null default false,
  plan_installment_cents      bigint,
  plan_frequency_days         int,
  plan_start_date             date,
  plan_regular_start_date     date,
  plan_down_payment_cents     bigint,
  plan_pre_reminder_days      int,
  billing_plan_id             uuid,
  billing_plan_period_id      uuid,
  billing_plan_name           text,
  billing_plan_type           text
    check (billing_plan_type is null or billing_plan_type in ('retainer')),
  is_recurring_retainer       boolean not null default false,
  split_group_id              uuid,
  split_mode                  text,
  split_recipient_count       int,
  split_share_cents           bigint check (split_share_cents is null or split_share_cents >= 0),
  split_share_percent         numeric,
  stripe_invoice_id           text,
  -- Account the hosted invoice / checkout session was created on: 'platform' or an
  -- acct_ id. Null = unknown (row predates the column); teardown then uses the
  -- firm's current charge setup.
  stripe_invoice_account_id   text,
  stripe_checkout_session_id  text,
  stripe_checkout_session_account_id text,
  stripe_payment_intent_id    text,
  -- The application's words, not Stripe's: stripe.service.ts maps open / void /
  -- uncollectible / paid onto these four before any write.
  stripe_payment_status       text
    check (stripe_payment_status is null or stripe_payment_status in ('completed', 'pending', 'voided', 'failed')),
  stripe_payment_requested    boolean not null default false,
  stripe_payment_requested_by text references users(id) on delete restrict,
  google_last_modified        timestamptz,
  outlook_last_modified       timestamptz,
  -- per-user calendar_sync map + cross-sync stamps for billing calendar items (migration 0031)
  calendar_sync               jsonb,
  last_synced_to_google       timestamptz,
  last_synced_to_outlook      timestamptz,
  created_by                  text references users(id) on delete restrict,
  updated_by                  text references users(id) on delete restrict,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- Billing recipient / bill-to snapshot (organization-clients plan). Recorded
  -- once, atomically, on an invoice's first external issue so later roster
  -- changes never rewrite billing history; null/empty until then, including
  -- on newly drafted invoices. billing_client_address mirrors clients.address
  -- (plain text) - there is no structured street/city/state/zip anywhere on
  -- the client model, unlike the firm's own remit_to_* address.
  billing_emails               text[] not null default '{}',
  -- Client display/legal name, distinct from billing_contact_name (the
  -- attention contact, a company roster contact).
  billing_client_name          text,
  billing_contact_name         text,
  billing_contact_title        text,
  billing_contact_email        text,
  billing_client_address       text,
  billing_snapshot_at          timestamptz,
  -- Who pays the online processing fee on this invoice's payment request, per
  -- method: false means the firm absorbs it, true adds it on top of what the
  -- client pays. Set when the firm requests payment (migration 0041).
  is_card_fee_passed_on        boolean not null default false,
  is_bank_fee_passed_on        boolean not null default false,
  -- The secure payment link's token, the only credential for the no-login pay
  -- page. Null until the firm requests payment; a new request replaces it and
  -- voiding the request clears it (migration 0042).
  pay_link_token               text,
  -- The payment-plan installment the payment link asks for, by the row's
  -- stable installment_id; null asks for the full balance (migration 0044).
  pay_link_installment_id      text,
  -- A card-form PaymentIntent waiting on the client's bank or on Stripe, and
  -- the account it lives on. Nothing else may charge the invoice while it is
  -- set (migration 0047).
  stripe_card_payment_intent_id text,
  stripe_card_payment_intent_account_id text,
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  check ( (matter_id is not null) <> (client_context_id is not null) )
);
create unique index if not exists invoices_pay_link_token_key
  on invoices (pay_link_token)
  where pay_link_token is not null;
-- invoices_number_idx removed by migration 0195: the planner prefers
-- invoices_number_unique_idx for the (law_firm_id, invoice_number) lookup either way.
-- BL3 (migration 0034): a firm's invoice_number must be unique (allocator-backed).
create unique index if not exists invoices_number_unique_idx
  on invoices (law_firm_id, invoice_number)
  where invoice_number is not null and invoice_number <> '';
-- BL11 (migration 0034): a firm's invoice_name must be unique within a billing context.
create unique index if not exists invoices_name_unique_idx
  on invoices (law_firm_id, coalesce(matter_id, client_context_id), lower(invoice_name))
  where invoice_name is not null and invoice_name <> '';
-- (migration 0050): supports the left-anchored `invoice_name LIKE 'prefix%'` prefix
-- scan in billingReads.nextInvoiceNumber's non-authoritative next-number preview.
create index if not exists invoices_name_prefix_idx
  on invoices (law_firm_id, invoice_name text_pattern_ops)
  where invoice_name is not null;
-- invoices_firm_due_idx removed by migration 0195: its `status <> 'paid'` predicate is
-- unreachable (no query uses it) and invoices_firm_due_all_idx covers the columns.
-- (migration 0125): unpartitioned twin of the above, for the calendar's date-window
-- probe. That probe has no status predicate and must see paid invoices too, so the
-- partial index cannot serve it.
create index if not exists invoices_firm_due_all_idx on invoices (law_firm_id, due_date);
create index if not exists invoices_outstanding_idx on invoices (law_firm_id) where balance_due_cents > 0;
-- FK probe support (see migration 0130): deleting a client or a billing plan.
create index if not exists invoices_client_fk_idx
  on invoices (client_id) where client_id is not null;
create index if not exists invoices_billing_plan_idx
  on invoices (billing_plan_id) where billing_plan_id is not null;
create index if not exists invoices_billing_plan_period_idx
  on invoices (billing_plan_period_id) where billing_plan_period_id is not null;
-- (migration 0122): the matters list sums each row's invoices for its outstanding
-- balance and billed-to-date figures, correlating on (law_firm_id, matter_id).
-- Without this the nearest index is (law_firm_id, id), so every invoice in the firm
-- is read once per row on the page. Costs scale with firm invoice count, not page size.
create index if not exists invoices_firm_matter_idx
  on invoices (law_firm_id, matter_id)
  where matter_id is not null;




-- One row per time-entry / flat-fee / expense line on an invoice. Every field
-- the app reads by name is a real column (split allocations, recurring plan
-- fees, LEDES utbms task/activity codes…); there is no value-bag jsonb.
-- source_id is text because line ids aren't always uuids.
create table if not exists invoice_line_items (
  id                 uuid primary key default gen_random_uuid(),
  invoice_id         uuid not null references invoices(id) on delete cascade,
  law_firm_id        uuid not null references law_firms(id) on delete cascade,
  -- The formulation that makes a child pointing at an invoice in another firm
  -- impossible rather than merely unusual (migration 0246).
  foreign key (law_firm_id, invoice_id) references invoices (law_firm_id, id) on delete cascade,
  kind               text not null check (kind in ('time_entry','flat_fee','expense')),
  sort_order         int not null default 0,
  source_id          text,
  name               text,
  description        text,
  line_date          date,
  quantity           numeric,
  rate_cents         bigint,
  amount_cents       bigint not null default 0,
  user_id            text references users(id) on delete restrict,
  user_name          text,
  charge_code_id     uuid,
  allocation_percent numeric,
  allocation_amount_cents bigint,
  utbms_task_code     text,                 -- LEDES 1998B task code
  utbms_activity_code text                  -- LEDES 1998B activity code
);
create index if not exists invoice_line_items_invoice_idx on invoice_line_items (invoice_id, kind, sort_order);
create index if not exists invoice_line_items_firm_invoice_idx on invoice_line_items (law_firm_id, invoice_id);
-- "Is this entry already billed?" is answered by looking for a line item whose
-- (kind, source_id) points back at the row; the work tables' own billed columns
-- are never maintained (billingReads.isSourceBilled). NOT unique: billingReads
-- documents that a source may appear on more than one line and that the first
-- row wins, so uniqueness would refuse a write the code tolerates (0206).
create index if not exists invoice_line_items_source_idx
  on invoice_line_items (kind, source_id)
  where source_id is not null;

-- payments[] -- ordered; expectedPayments.matchedPaymentIndex is the array
-- position, so sort_order is the index consumers rely on.
create table if not exists invoice_payments (
  id                       uuid primary key default gen_random_uuid(),
  invoice_id               uuid not null references invoices(id) on delete cascade,
  law_firm_id              uuid not null references law_firms(id) on delete cascade,
  -- The formulation that makes a child pointing at an invoice in another firm
  -- impossible rather than merely unusual (migration 0246).
  foreign key (law_firm_id, invoice_id) references invoices (law_firm_id, id) on delete cascade,
  sort_order               int not null default 0,
  amount_cents             bigint not null,
  payment_date             date,
  payment_source           text,
  note                     text,
  recorded_by              text references users(id) on delete restrict,
  invoice_number           text,
  trust_transaction_id     uuid,
  trust_account_id         uuid,
  stripe_session_id        text,
  stripe_invoice_id        text,
  stripe_payment_intent_id text,
  -- Cumulative amount reversed by Stripe (refund/dispute) for this payment. Stripe's
  -- charge.amount_refunded is cumulative, so tracking what we've already reversed lets
  -- the reversal converge to (original - amount_refunded) idempotently across multiple
  -- partial refunds and out-of-order webhook deliveries.
  stripe_refunded_cents    bigint not null default 0 check (stripe_refunded_cents >= 0),
  -- Connect charge model this payment was collected under (docs/DIRECT_CHARGE_MIGRATION.md).
  -- 'destination' = destination charge on the platform (platform bears disputes, current
  -- default); 'direct' = direct charge on the firm's connected account (firm bears them).
  -- Webhook refund/dispute handlers branch on this during the coexistence window.
  -- Only ever written as 'destination' today: Phase 0 of that migration lands the
  -- column ahead of the behaviour, so an unused value here is expected.
  charge_model             text not null default 'destination' check (charge_model in ('destination','direct')),
  -- The part of stripe_refunded_cents that a dispute took, so a won dispute
  -- restores only what it removed and never a refund that really went back.
  stripe_disputed_cents    bigint not null default 0,
  -- The processing fee the client paid on top of this payment, kept apart from
  -- amount_cents so it never counts toward the invoice balance (migration 0041).
  surcharge_cents          bigint not null default 0,
  -- Fee reversals are separate from invoice money. The disputed portion is
  -- restored only when Stripe reports the dispute won.
  surcharge_refunded_cents bigint not null default 0,
  surcharge_disputed_cents bigint not null default 0,
  constraint invoice_payments_stripe_disputed_cents_check
    check (stripe_disputed_cents >= 0 and stripe_disputed_cents <= stripe_refunded_cents),
  constraint invoice_payments_surcharge_cents_check check (surcharge_cents >= 0),
  constraint invoice_payments_surcharge_refunded_cents_check
    check (surcharge_refunded_cents >= 0 and surcharge_refunded_cents <= surcharge_cents),
  constraint invoice_payments_surcharge_disputed_cents_check
    check (surcharge_disputed_cents >= 0 and surcharge_disputed_cents <= surcharge_refunded_cents)
);
create index if not exists invoice_payments_invoice_idx on invoice_payments (invoice_id, sort_order);
create index if not exists invoice_payments_firm_invoice_idx on invoice_payments (law_firm_id, invoice_id);
create index if not exists invoice_payments_trust_txn_idx on invoice_payments (law_firm_id, trust_transaction_id);
-- The calendar's window probe compares payment_date against a date range. It was an
-- expression index on left(payment_date, 10) while the column was text (migration
-- 0125); migration 0196 made the column a date, so it indexes the column directly.
create index if not exists invoice_payments_paid_day_idx on invoice_payments (payment_date);

-- paymentPlan.expectedPayments[] -- installment schedule. installment_id is the
-- string `inst_<hex>` id; matched_payment_index is the integer index into payments[].
create table if not exists invoice_expected_payments (
  id                       uuid primary key default gen_random_uuid(),
  invoice_id               uuid not null references invoices(id) on delete cascade,
  law_firm_id              uuid not null references law_firms(id) on delete cascade,
  -- The formulation that makes a child pointing at an invoice in another firm
  -- impossible rather than merely unusual (migration 0246).
  foreign key (law_firm_id, invoice_id) references invoices (law_firm_id, id) on delete cascade,
  sort_order               int not null default 0,
  installment_id           text,
  due_date                 date,
  amount_cents             bigint not null default 0,
  -- 'overdue' is derived at read time and never written back, so it is absent.
  status                   text not null default 'pending'
    check (status in ('pending', 'paid', 'unpaid')),
  matched_payment_index    int,
  is_down_payment          boolean not null default false,
  pre_due_reminder_sent_at timestamptz,
  stripe_invoice_id        text,
  -- Account stripe_invoice_id was created on: 'platform' or an acct_ id. Null =
  -- unknown (row predates the column); teardown then uses the firm's current
  -- charge setup.
  stripe_invoice_account_id text,
  stripe_payment_status    text
    check (stripe_payment_status is null or stripe_payment_status in ('completed', 'pending', 'voided', 'failed'))
);
create index if not exists invoice_expected_invoice_idx on invoice_expected_payments (invoice_id, sort_order);
create index if not exists invoice_expected_firm_invoice_idx on invoice_expected_payments (law_firm_id, invoice_id);
-- Same story as invoice_payments_paid_day_idx: an expression index on
-- left(due_date, 10) until migration 0196 made the column a date.
create index if not exists invoice_expected_due_day_idx on invoice_expected_payments (due_date);

-- The credits and charges applied to an invoice after its lines were set:
-- `creditNotes[]` are the `credit` rows, `amountAdjustmentNotes[]` the `charge`
-- rows (migration 0230 merged the two tables that held them). Rewritten
-- whole on every invoice save, like the other children.
create table if not exists invoice_adjustments (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  invoice_id    uuid not null,
  direction     text not null check (direction in ('credit', 'charge')),
  kind          text check (kind is null or kind in ('write_off', 'discount', 'adjustment', 'late_fee')),
  external_id   text,
  amount_cents  bigint not null,
  description   text,
  sort_order    int not null default 0,
  created_by    text references users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  constraint invoice_adjustments_kind_matches_direction check (
    (direction = 'credit' and (kind is null or kind in ('write_off', 'discount', 'adjustment')))
    or (direction = 'charge' and (kind is null or kind = 'late_fee'))
  ),
  foreign key (law_firm_id, invoice_id) references invoices (law_firm_id, id) on delete cascade
);
create index if not exists invoice_adjustments_invoice_idx
  on invoice_adjustments (law_firm_id, invoice_id, direction, sort_order);


create table if not exists billing_plans (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  matter_id             uuid,
  client_id           uuid references clients(id) on delete restrict,
  plan_type           text not null default 'retainer' check (plan_type in ('retainer')),
  name                text not null,
  status              text not null default 'active' check (status in ('active','paused','ended')),
  interval_unit       text check (interval_unit in ('week','month')),
  interval_count      int check (interval_count is null or interval_count > 0),
  start_date          date,
  next_run_date       date,
  end_condition       text default 'manual' check (end_condition in ('manual','matter_closed','date')),
  end_date            date,
  amount_cents        bigint check (amount_cents is null or amount_cents >= 0),
  included_hours      numeric check (included_hours is null or included_hours >= 0),
  billing_email       citext,
  default_due_days    int,
  default_client_id   uuid references clients(id) on delete set null,
  notes               text,
  created_by          text references users(id) on delete restrict,
  updated_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  check ( (matter_id is not null) <> (client_id is not null) )
);
-- Serves the on-delete walk of billing_plans_client_id_fkey (migration 0225).
create index if not exists billing_plans_client_id_idx on billing_plans (client_id);
-- Serves the on-delete walk of billing_plans_default_client_id_fkey (migration 0225).
create index if not exists billing_plans_default_client_id_idx on billing_plans (default_client_id);

create table if not exists billing_plan_periods (
  id                  uuid primary key default gen_random_uuid(),
  billing_plan_id     uuid not null references billing_plans(id) on delete cascade,
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  period_start_date   date,
  period_end_date     date,
  due_date            date,
  status              text not null default 'ready_to_bill'
                        check (status in ('ready_to_bill','draft_created','skipped')),
  amount_cents        bigint check (amount_cents is null or amount_cents >= 0),
  included_hours      numeric,
  consumed_hours      numeric,
  overage_hours       numeric,
  generated_invoice_id uuid,
  generated_at        timestamptz,
  generated_invoice_context_type text
    check (generated_invoice_context_type is null or generated_invoice_context_type in ('matter', 'client')),
  generated_invoice_entity_id    uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (billing_plan_id, period_start_date)
);

-- =====================================================================
-- ACTIVITIES: the firm's billable and non-billable work, one table
-- =====================================================================
-- Time entries, expenses and flat fees are rows of one table told apart by
-- `kind` (migration 0232). The three route files each filter on their kind,
-- so the API did not change. Ids were preserved across the merge, which is
-- what keeps `invoice_line_items.source_id` valid.
--
-- `amount_cents` is generated: hours times the EXPLICIT rate for time (zero
-- when the rate is resolved at read time, so never sum it for revenue), and
-- the entered `charge_cents` for an expense or fee. A CHECK per kind pins
-- which columns that kind may set. A retainer period's coverage is
-- `billing_plan_period_id` + `coverage` on the row; an activity belongs to at
-- most one period. `source_event_id`'s key to `events` is attached in the
-- deferred block further down, because `events` is created later.
--
-- An activity that is on an invoice is frozen where it counts and cannot be
-- deleted: `activities_billed_immutable` below mirrors the services'
-- FROZEN_ONCE_BILLED lists column for column. Billed means a line item of the
-- matching kind names the row, on any non-voided invoice of the firm; voiding an
-- invoice releases what it held.
create table if not exists activities (
  id                     uuid primary key default gen_random_uuid(),
  law_firm_id            uuid not null references law_firms(id) on delete cascade,
  kind                   text not null check (kind in ('time', 'expense', 'flat_fee')),
  -- Exactly one billing context.
  matter_id              uuid,
  client_id              uuid references clients(id) on delete restrict,
  -- The timekeeper for time, the member who incurred an expense.
  user_id                text references users(id) on delete restrict,
  -- The day the work happened or the cost was incurred. Required for time; an
  -- expense or fee may be recorded without one.
  activity_date          date,
  description            text,
  name                   text,
  billable               boolean not null default true,
  -- Time only.
  hours                  numeric(6,2) check (hours is null or hours >= 0),
  -- The explicit override the member typed, if any.
  rate_cents             bigint check (rate_cents is null or rate_cents >= 0),
  -- The rate the entry was resolved at when written (migration 0233), and which
  -- of the eight sources supplied it. Written again only when the entry's
  -- inputs change or the firm asks to re-rate, so a rate change stops moving
  -- old work. Both null on a row nothing has resolved yet, which readers treat
  -- as "resolve live"; `'none'` with no cents is a resolution that found no
  -- rate at all.
  resolved_rate_cents    bigint check (resolved_rate_cents is null or resolved_rate_cents >= 0),
  rate_source            text check (rate_source is null or rate_source in (
    'time entry override', 'matter member rate', 'client member rate', 'client default rate',
    'charge code member rate', 'charge code default', 'user default rate', 'firm default rate', 'none')),
  -- Expense and flat fee only: the amount as entered.
  charge_cents           bigint check (charge_cents is null or charge_cents >= 0),
  -- What the row is worth. Generated so it cannot disagree with its inputs: hours
  -- times the resolved rate for time, so it CAN be summed for unbilled value; the
  -- entered amount for an expense or fee.
  amount_cents           bigint generated always as (
    case when kind = 'time' then round(coalesce(hours, 0) * coalesce(resolved_rate_cents, rate_cents, 0))::bigint
         else coalesce(charge_cents, 0) end
  ) stored,
  -- The charge code (time) or expense category (expense).
  billing_code_id        uuid,
  -- Time only: which clients on the matter the work was for, validated against
  -- matter_clients on write; the UTBMS codes; where the time came from.
  matter_client_ids      jsonb,
  utbms_task_code        text,
  utbms_activity_code    text,
  source                 text,
  source_task_id         uuid references tasks (id) on delete set null,
  source_event_id        uuid,
  linked_note_id         uuid,
  -- Expense only.
  vendor                 text,
  category               text,
  receipt_object_path    text,
  -- The retainer period this activity was counted against, if any, and
  -- whether it fell inside the allowance or over it. Both set or both null.
  billing_plan_period_id uuid references billing_plan_periods(id) on delete set null,
  coverage               text check (coverage is null or coverage in ('covered', 'overage')),
  created_by             text references users(id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  -- Composite so a row can only name its own firm's code; deleting the code
  -- clears billing_code_id and nothing else.
  foreign key (law_firm_id, billing_code_id) references billing_codes (law_firm_id, id) on delete set null (billing_code_id),
  check ( (matter_id is not null) <> (client_id is not null) ),
  check ( source_task_id is null or source_event_id is null ),
  check ( (billing_plan_period_id is null) = (coverage is null) ),
  constraint activities_rate_only_on_time check (
    kind = 'time' or (resolved_rate_cents is null and rate_source is null)
  ),
  constraint activities_time_shape check (
    kind <> 'time' or (activity_date is not null and charge_cents is null and vendor is null and category is null and receipt_object_path is null)
  ),
  constraint activities_expense_shape check (
    kind <> 'expense' or (hours is null and rate_cents is null and matter_client_ids is null and utbms_task_code is null
      and utbms_activity_code is null and source is null and source_task_id is null and source_event_id is null
      and linked_note_id is null and billing_plan_period_id is null)
  ),
  constraint activities_flat_fee_shape check (
    kind <> 'flat_fee' or (hours is null and rate_cents is null and matter_client_ids is null and utbms_task_code is null
      and utbms_activity_code is null and source is null and source_task_id is null and source_event_id is null
      and linked_note_id is null and billing_plan_period_id is null and billing_code_id is null and vendor is null
      and category is null and receipt_object_path is null and user_id is null)
  )
);
-- Reads: a context's work of one kind, a member's time on a matter, a firm's
-- work by day, and the retainer period's coverage.
create index if not exists activities_firm_kind_matter_idx on activities (law_firm_id, kind, matter_id, user_id);
create index if not exists activities_firm_kind_client_idx on activities (law_firm_id, kind, client_id);
create index if not exists activities_firm_kind_date_idx on activities (law_firm_id, kind, activity_date);
create index if not exists activities_firm_matter_hours_idx on activities (law_firm_id, matter_id) include (hours) where kind = 'time';
create index if not exists activities_period_idx on activities (law_firm_id, billing_plan_period_id) where billing_plan_period_id is not null;
create index if not exists activities_linked_note_idx on activities (law_firm_id, linked_note_id) where linked_note_id is not null;
-- Foreign-key probes: a parent delete supplies only its own column.
create index if not exists activities_client_fk_idx on activities (client_id) where client_id is not null;
create index if not exists activities_user_fk_idx on activities (user_id) where user_id is not null;
create index if not exists activities_firm_billing_code_fk_idx on activities (law_firm_id, billing_code_id) where billing_code_id is not null;
create index if not exists activities_source_task_fk_idx on activities (source_task_id) where source_task_id is not null;
create index if not exists activities_source_event_fk_idx on activities (source_event_id) where source_event_id is not null;
create index if not exists activities_period_fk_idx on activities (billing_plan_period_id) where billing_plan_period_id is not null;

create or replace function activity_billed_immutable() returns trigger
  language plpgsql as $$
declare
  line_kind text := case old.kind when 'time' then 'time_entry' else old.kind end;
  placed boolean;
begin
  -- A voided invoice was cancelled by the firm, so its line items no longer
  -- hold the work they name.
  select exists (
    select 1 from invoice_line_items li
      join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
     where li.law_firm_id = old.law_firm_id
       and li.kind = line_kind
       and li.source_id = old.id::text
       and i.status <> 'voided'
  ) into placed;
  if not placed then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'this % is on an invoice and cannot be deleted (id=%)', line_kind, old.id
      using errcode = 'restrict_violation';
  end if;

  if old.kind = 'time' then
    if new.hours is distinct from old.hours
       or new.rate_cents is distinct from old.rate_cents
       or new.resolved_rate_cents is distinct from old.resolved_rate_cents
       or new.activity_date is distinct from old.activity_date
       or new.billing_code_id is distinct from old.billing_code_id
       or new.matter_client_ids is distinct from old.matter_client_ids
       or new.billable is distinct from old.billable
       or new.matter_id is distinct from old.matter_id then
      raise exception 'this time entry is on an invoice: its hours, rate, date, charge code, client split, billable flag and matter are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  elsif old.kind = 'flat_fee' then
    if new.charge_cents is distinct from old.charge_cents
       or new.activity_date is distinct from old.activity_date then
      raise exception 'this flat fee is on an invoice: its amount and date are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  else
    if new.charge_cents is distinct from old.charge_cents
       or new.activity_date is distinct from old.activity_date
       or new.billable is distinct from old.billable then
      raise exception 'this expense is on an invoice: its amount, date and billable flag are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_billed_immutable on activities;
create trigger activities_billed_immutable before update or delete on activities
  for each row execute function activity_billed_immutable();

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column invoices.billing_client_address is 'Billing address, frozen at first external issue. Plain text, mirroring clients.address.';
comment on column invoices.billing_client_name is 'Client display/legal name, frozen at first external issue. Distinct from billing_contact_name (the attention contact). Empty until snapshotted.';
comment on column invoices.billing_contact_email is 'Primary billing email, frozen at first external issue.';
comment on column invoices.billing_contact_name is 'Attention contact name, frozen at first external issue.';
comment on column invoices.billing_contact_title is 'Attention contact title/role, frozen at first external issue.';
comment on column invoices.billing_emails is 'Complete billing email list, frozen at first external issue. Empty until snapshotted.';
comment on column invoices.billing_snapshot_at is 'When the billing recipient / bill-to snapshot was taken. Null = never snapshotted (draft, or predates this feature).';
comment on column invoices.stripe_invoice_account_id is 'Stripe account stripe_invoice_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
comment on column invoices.stripe_card_payment_intent_id is 'PaymentIntent of a card-form payment not yet settled; cleared when it succeeds, fails or is cancelled.';
comment on column invoices.stripe_card_payment_intent_account_id is 'Stripe account stripe_card_payment_intent_id was created on (an acct_ id).';
comment on column invoices.stripe_checkout_session_account_id is 'Stripe account stripe_checkout_session_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
comment on column invoice_expected_payments.stripe_invoice_account_id is 'Stripe account stripe_invoice_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
comment on column invoice_payments.stripe_disputed_cents is 'The part of stripe_refunded_cents that a dispute took (cumulative reversal minus refunds). A won dispute restores at most this much.';
