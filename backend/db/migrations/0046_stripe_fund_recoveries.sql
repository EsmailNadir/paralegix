-- migration-mode: expand
--
-- A record of the cash automatic Stripe recovery actually took, per clawed-back
-- payment, and where it took it from.
--
-- Pre-condition: no `stripe_fund_recoveries` table. When a dispute or refund on a
-- destination charge is recovered, nothing local records how much was pulled
-- back or from where: a transfer reversal on the trust connected account, a
-- transfer reversal on the firm's operating connected account, or a charge to
-- the firm's operating card. A won dispute or a failed refund therefore had to
-- guess what to give back, from the trust ledger or the invoice, which is not
-- the same figure: the ledger can refuse a reversal while cash was still taken,
-- and a transfer reversal is capped below the charge by the application fee.
--
-- Post-condition: one row per Stripe object that moved recovered cash (a
-- transfer reversal `trr_` or the recovery payment intent `pi_` charged to the
-- firm's card), unique on that object id so a replay records nothing twice.
-- `restored_cents` counts how much of it has been given back, never more than
-- was recovered. Restores read this table, not the ledger.
--
-- Expand only. Nothing reads or writes it until the code that ships with it.

create table if not exists stripe_fund_recoveries (
  id                        uuid not null default gen_random_uuid(),
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  -- The clawed-back payment: a trust deposit's or an invoice payment's intent.
  stripe_payment_intent_id  text not null,
  -- Where the cash came from, which is where a restore must send it back.
  --   trust_transfer: reversed out of the trust account's connected account
  --   firm_transfer:  reversed out of the firm's operating connected account
  --   firm_card:      charged to the firm's operating card on file
  source                    text not null
                              check (source in ('trust_transfer', 'firm_transfer', 'firm_card')),
  -- The Stripe object that moved it: the transfer reversal or the recovery
  -- payment intent. A refund of a firm_card row is made against this id.
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

-- Recovery and restore both read one payment's rows within one firm.
create index if not exists stripe_fund_recoveries_payment_idx
  on stripe_fund_recoveries (law_firm_id, stripe_payment_intent_id);

drop trigger if exists set_updated_at on stripe_fund_recoveries;
create trigger set_updated_at before update on stripe_fund_recoveries
  for each row execute function set_updated_at();
