-- =====================================================================
-- TRUST (append-only ledger)
-- =====================================================================

create table if not exists trust_accounts (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid not null references law_firms(id) on delete cascade,
  name                 text not null,
  bank_name            text,
  account_number_last4 text check (account_number_last4 is null or account_number_last4 ~ '^[0-9]{4}$'),
  routing_number_last4 text,
  -- 'iolta' = pooled interest-to-bar-foundation account; 'trust' = non-IOLTA
  -- retainer/escrow account; 'separate_interest' = client-specific
  -- interest-bearing account (interest to the client).
  account_type         text not null default 'iolta'
    check (account_type in ('iolta','trust','separate_interest')),
  iolta_tin            text,
  interest_beneficiary text
    check (interest_beneficiary is null or interest_beneficiary in ('bar_foundation','client','firm')),
  -- Period lock: transactions dated on/before this are in a closed period and
  -- cannot be posted or voided (enforced in the application layer).
  book_close_date      date,
  status               text not null default 'active' check (status in ('active','inactive')),
  book_balance_cents   bigint not null default 0
    constraint trust_accounts_book_balance_nonneg check (book_balance_cents >= 0),
  -- Stripe connected account dedicated to this trust/IOLTA bank account. Electronic
  -- (ACH) trust deposits are destination charges routed here so client funds settle
  -- into the trust bank account, never the firm's operating account. Separate from
  -- law_firms.stripe_account_id (the operating account).
  stripe_connected_account_id text,
  stripe_charges_enabled      boolean not null default false,
  stripe_onboarding_complete  boolean not null default false,
  created_by           text references users(id) on delete restrict,
  updated_by           text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create unique index if not exists trust_accounts_stripe_acct_uidx
  on trust_accounts (stripe_connected_account_id)
  where stripe_connected_account_id is not null;

-- Processing fees for electronic (ACH) trust deposits. The deposit posts to trust
-- in full; the fee Paralegix fronts is billed back to the firm's operating side via
-- an invoice item on their subscription customer. One row per deposit (idempotent).
create table if not exists trust_deposit_fees (
  id                     uuid not null default gen_random_uuid(),
  law_firm_id            uuid not null references law_firms(id) on delete cascade,
  trust_transaction_id   uuid not null,
  fee_cents              bigint not null check (fee_cents >= 0),
  stripe_invoice_item_id text,
  -- The one-off fee invoice, persisted at finalize time (before pay) so a retry
  -- reuses it instead of creating a second charge once the Stripe idempotency key
  -- (24h TTL) has expired.
  stripe_invoice_id      text,
  status                 text not null default 'accrued'
                           check (status in ('accrued','billed','waived')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, trust_transaction_id)
);

-- Cash automatic Stripe recovery took back for a clawed-back payment (a trust
-- deposit or an invoice payment), one row per Stripe object that moved it, and
-- how much of it has been given back. A won dispute or a failed refund returns
-- exactly this, to where it came from, whatever the ledger or the invoice did
-- (migration 0046).
create table if not exists stripe_fund_recoveries (
  id                        uuid not null default gen_random_uuid(),
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  stripe_payment_intent_id  text not null,
  -- trust_transfer / firm_transfer: reversed out of that connected account;
  -- firm_card: charged to the firm's operating card on file.
  source                    text not null
                              check (source in ('trust_transfer', 'firm_transfer', 'firm_card')),
  -- The transfer reversal, or the recovery payment intent a refund is made against.
  stripe_object_id          text not null,
  recovered_cents           bigint not null check (recovered_cents > 0),
  restored_cents            bigint not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  unique (stripe_object_id),
  constraint stripe_fund_recoveries_restored_cents_check
    check (restored_cents >= 0 and restored_cents <= recovered_cents)
);
create index if not exists stripe_fund_recoveries_payment_idx
  on stripe_fund_recoveries (law_firm_id, stripe_payment_intent_id);

create table if not exists trust_transactions (
  id                          uuid primary key default gen_random_uuid(),
  law_firm_id                 uuid not null references law_firms(id) on delete cascade,
  trust_account_id            uuid not null,
  type                        text not null check (type in ('deposit','withdrawal','transfer','refund')),
  amount_cents                bigint not null check (amount_cents > 0),
  client_id                   uuid references clients(id) on delete restrict,
  matter_id                     uuid,
  txn_date                    date not null,
  description                 text,
  reference_number            text,
  payee                       text,
  transfer_to                 text check (transfer_to in ('operating','other')),
  -- Double-entry trust→trust transfer: when a transfer targets another trust
  -- account, two linked legs are posted (withdrawal from source, deposit into
  -- destination) sharing one transfer_group_id. transfer_to_account_id is the
  -- destination account on the source (withdrawal) leg.
  transfer_to_account_id      uuid,
  transfer_group_id           uuid,
  source                      text check (source in ('check','wire','ach','cash','credit_card','interest','stripe','other')),
  invoice_id                  uuid,
  -- Stripe-funded deposit linkage (electronic trust payments). The partial
  -- unique index below makes a replayed webhook idempotent.
  stripe_session_id           text,
  stripe_payment_intent_id    text,
  -- Connect charge model for a Stripe-funded deposit (docs/DIRECT_CHARGE_MIGRATION.md).
  -- 'destination' (default) = destination charge on the platform; 'direct' = direct
  -- charge on the trust connected account. Clawback handling branches on this.
  -- Only ever written as 'destination' today: Phase 0 of that migration lands the
  -- column ahead of the behaviour, so an unused value here is expected.
  charge_model                text not null default 'destination' check (charge_model in ('destination','direct')),
  -- restrict, not cascade: a reversing entry must never outlive the entry it
  -- reverses, because the pair is the void lineage the ledger rests on.
  reverses_transaction_id     uuid references trust_transactions(id) on delete restrict,
  status                      text not null default 'completed' check (status in ('completed','pending','void')),
  client_balance_after_cents  bigint,
  account_balance_after_cents bigint,
  -- Bank-reconciliation tracking: a completed entry is `cleared` once a
  -- reconciliation that did not flag it as outstanding is recorded. "Currently
  -- outstanding" = completed rows with cleared_at IS NULL. (No FK on
  -- cleared_in_reconciliation_id: reconciliations are append-only and never
  -- deleted, so it is a soft audit link.)
  cleared_at                  timestamptz,
  cleared_in_reconciliation_id uuid,
  voided_by                   text references users(id) on delete restrict,
  voided_at                   timestamptz,
  void_reason                 text,
  created_by                  text references users(id) on delete restrict,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- restrict: an account with ledger entries against it cannot be deleted.
  foreign key (law_firm_id, trust_account_id) references trust_accounts (law_firm_id, id) on delete restrict,
  foreign key (law_firm_id, transfer_to_account_id) references trust_accounts (law_firm_id, id) on delete restrict,
  foreign key (law_firm_id, matter_id)          references matters (law_firm_id, id) on delete set null,
  -- tenant-scoped FK on the billing→trust link (migration 0064). SET NULL only
  -- nulls invoice_id (not law_firm_id) on invoice delete -- column-list form, PG 15+.
  constraint trust_txn_invoice_fk
    foreign key (law_firm_id, invoice_id)     references invoices (law_firm_id, id) on delete set null (invoice_id)
);
-- Serves the on-delete walk of trust_transactions_client_id_fkey (migration 0225).
create index if not exists trust_transactions_client_id_idx on trust_transactions (client_id);
-- Firm-leading: every read in trust.repository.ts filters law_firm_id together
-- with the account or client and orders by txn_date desc, so these seek on both
-- columns instead of seeking on one and filtering the other (migration 0206).
create index if not exists trust_txn_firm_account_date_idx
  on trust_transactions (law_firm_id, trust_account_id, txn_date desc);
create index if not exists trust_txn_firm_client_date_idx
  on trust_transactions (law_firm_id, client_id, txn_date desc);
-- trust_txn_firm_date_idx removed by migration 0195: covered by
-- trust_txn_firm_date_created_idx; the `status <> 'void'` predicate excludes almost nothing.
create index if not exists trust_txn_uncleared_idx on trust_transactions (law_firm_id, trust_account_id) where status = 'completed' and cleared_at is null;
-- FK probe support (see migration 0130): deleting a matter or an invoice.
create index if not exists trust_transactions_matter_idx
  on trust_transactions (law_firm_id, matter_id) where matter_id is not null;
create index if not exists trust_transactions_invoice_idx
  on trust_transactions (law_firm_id, invoice_id) where invoice_id is not null;
create index if not exists trust_txn_transfer_group_idx on trust_transactions (transfer_group_id) where transfer_group_id is not null;
create unique index if not exists trust_txn_stripe_session_uidx on trust_transactions (law_firm_id, stripe_session_id) where stripe_session_id is not null;
-- ACH deposits post on payment_intent.succeeded (no session id in that event), so
-- the payment intent id is the idempotency key. Void reversals carry no PI id.
create unique index if not exists trust_txn_stripe_pi_uidx on trust_transactions (law_firm_id, stripe_payment_intent_id) where stripe_payment_intent_id is not null and status <> 'void';

create table if not exists trust_reconciliations (
  id                            uuid primary key default gen_random_uuid(),
  law_firm_id                   uuid not null references law_firms(id) on delete cascade,
  trust_account_id              uuid not null,
  reconciliation_date           date not null,
  bank_statement_balance_cents  bigint not null,
  book_balance_cents            bigint not null,
  client_ledger_total_cents     bigint not null,
  is_reconciled                 boolean not null default false,
  discrepancy_cents             bigint not null,
  adjustments                   jsonb not null default '[]',
  outstanding_transaction_ids   uuid[],
  notes                         text,
  reconciled_by                 text references users(id) on delete restrict,
  reconciled_at                 timestamptz,
  created_by                    text references users(id) on delete restrict,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- restrict: an account with a reconciliation against it cannot be deleted.
  foreign key (law_firm_id, trust_account_id) references trust_accounts (law_firm_id, id) on delete restrict
);

-- Evergreen retainer thresholds: the minimum balance a client should keep in an
-- account before a replenishment alert fires. Absent row = no minimum.
create table if not exists trust_minimum_balances (
  id               uuid primary key default gen_random_uuid(),
  law_firm_id      uuid not null references law_firms(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete restrict,
  trust_account_id uuid not null,
  minimum_cents    bigint not null default 0 check (minimum_cents >= 0),
  created_by       text references users(id) on delete restrict,
  updated_by       text references users(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (law_firm_id, client_id, trust_account_id),
  foreign key (law_firm_id, trust_account_id) references trust_accounts (law_firm_id, id) on delete cascade
);
-- Serves the on-delete walk of trust_minimum_balances_client_id_fkey (migration 0225).
create index if not exists trust_minimum_balances_client_id_idx on trust_minimum_balances (client_id);

-- IOLTA interest remittance tracking: interest earned on a pooled account and
-- the remittance of that interest to the state bar foundation / IOLTA program.
create table if not exists trust_interest_remittances (
  id                    uuid primary key default gen_random_uuid(),
  law_firm_id           uuid not null references law_firms(id) on delete cascade,
  trust_account_id      uuid not null,
  period_start          date,
  period_end            date,
  interest_earned_cents bigint not null default 0,
  amount_remitted_cents bigint not null default 0,
  remitted_to           text,
  remittance_date       date,
  reference_number      text,
  notes                 text,
  status                text not null default 'pending' check (status in ('pending','remitted')),
  created_by            text references users(id) on delete restrict,
  updated_by            text references users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (law_firm_id, trust_account_id) references trust_accounts (law_firm_id, id) on delete cascade
);
create index if not exists trust_interest_remit_account_idx
  on trust_interest_remittances (law_firm_id, trust_account_id, period_end desc);

-- =====================================================================
-- TRUST LEDGER IMMUTABILITY (upgrade #3)
--   completed transactions cannot be UPDATEd or DELETEd; corrections are
--   posted as reversing entries.
-- =====================================================================
create or replace function trust_txn_immutable() returns trigger as $$
declare
  frozen trust_transactions%rowtype;
  declared_remap text;
begin
  if (tg_op = 'DELETE') then
    -- Both completed and void entries are permanent: the void lineage rows are the
    -- correction trail the ledger depends on, so deleting them would destroy
    -- tamper-evidence. Only a non-terminal row (should never exist today) may be deleted.
    if old.status in ('completed', 'void') then
      raise exception 'trust_transactions are append-only: % entries cannot be deleted (id=%)', old.status, old.id;
    end if;
    return old;
  end if;

  -- A void entry is terminal and fully immutable. In particular it can never be
  -- flipped back to completed, which would resurrect a reversed entry and silently
  -- inflate every SUM-derived balance without touching book_balance_cents.
  if old.status = 'void' then
    raise exception 'trust_transactions are append-only: void entries are immutable (id=%)', old.id;
  end if;

  -- A completed entry may only stay completed or transition to void; no other target
  -- status (e.g. pending) is allowed.
  if old.status = 'completed' and new.status not in ('completed', 'void') then
    raise exception 'trust_transactions are append-only: completed entries may only be voided (id=%)', old.id;
  end if;

  -- A completed entry that remains completed is frozen in place: the only fields
  -- that may change are the bank-clearing stamps (cleared_at,
  -- cleared_in_reconciliation_id) and updated_at. Normalize those, then require
  -- the rest of the row to be byte-for-byte identical, so attribution
  -- (client/matter/date), amount, and every other field stay tamper-evident.
  -- Corrections must be reversing entries, not in-place edits.
  if old.status = 'completed' and new.status = 'completed' then
    frozen := new;
    frozen.cleared_at := old.cleared_at;
    frozen.cleared_in_reconciliation_id := old.cleared_in_reconciliation_id;
    frozen.updated_at := old.updated_at;

    -- The single declared exception (migration 0183): a client-identity merge
    -- folding a duplicate client row into the record that survives it. The two
    -- rows are the same person by construction (same email, one never claimed),
    -- so the money did not move between people, only the record it hangs off
    -- did. `mergePlaceholder` must repoint client_id before deleting the
    -- duplicate, because the FK to clients(id) has no delete action.
    --
    -- The caller names the exact pair it intends to remap, transaction-locally:
    --   select set_config('paralegix.trust_client_remap', '<from>:<to>', true);
    -- Anything else -- a different pair, no setting, or any other altered column
    -- -- still raises, and normalizing client_id here keeps every OTHER column
    -- inside the byte-for-byte comparison below.
    declared_remap := current_setting('paralegix.trust_client_remap', true);
    if declared_remap is not null
       and new.client_id is distinct from old.client_id
       and declared_remap = old.client_id::text || ':' || new.client_id::text then
      frozen.client_id := old.client_id;
    end if;

    if frozen is distinct from old then
      raise exception 'trust_transactions are append-only: post a reversing entry instead of editing (id=%)', old.id;
    end if;
  end if;

  -- The completed -> void transition may ONLY set the void bookkeeping fields; every
  -- other column (amount, client, matter, date, ...) must stay identical, so a void
  -- cannot smuggle in an edit alongside the status change.
  if old.status = 'completed' and new.status = 'void' then
    frozen := new;
    frozen.status := old.status;
    frozen.voided_by := old.voided_by;
    frozen.voided_at := old.voided_at;
    frozen.void_reason := old.void_reason;
    frozen.cleared_at := old.cleared_at;
    frozen.cleared_in_reconciliation_id := old.cleared_in_reconciliation_id;
    frozen.updated_at := old.updated_at;
    if frozen is distinct from old then
      raise exception 'trust_transactions are append-only: a void may only set the void fields (id=%)', old.id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trust_txn_immutable on trust_transactions;
create trigger trust_txn_immutable before update or delete on trust_transactions
  for each row execute function trust_txn_immutable();
