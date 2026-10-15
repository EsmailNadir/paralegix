-- migration-mode: expand
-- Pre: invoice_payments records a client-paid surcharge but not its cumulative
--      refund or the disputed portion that a won dispute must restore.
-- Post: fee refund/dispute counters exist with zero defaults for old writers,
--       and enforce 0 <= disputed <= refunded <= the original surcharge.

alter table invoice_payments
  add column surcharge_refunded_cents bigint not null default 0,
  add column surcharge_disputed_cents bigint not null default 0;

alter table invoice_payments
  add constraint invoice_payments_surcharge_refunded_cents_check
    check (surcharge_refunded_cents >= 0 and surcharge_refunded_cents <= surcharge_cents),
  add constraint invoice_payments_surcharge_disputed_cents_check
    check (surcharge_disputed_cents >= 0 and surcharge_disputed_cents <= surcharge_refunded_cents);
