-- migration-mode: expand
-- Online payment processing fees a firm can pass on to its client.
--
-- Pre:  invoices has no record of who pays the processing fee on its online
--       payment request, and invoice_payments has no record of a fee paid on
--       top of an invoice payment.
-- Post: invoices.is_card_fee_passed_on and invoices.is_bank_fee_passed_on exist,
--       boolean not null default false, set when the firm requests payment.
--       invoice_payments.surcharge_cents exists, bigint not null default 0,
--       never negative, holding the fee a client paid on top of the amount that
--       counts toward the invoice.

alter table invoices
  add column if not exists is_card_fee_passed_on boolean not null default false,
  add column if not exists is_bank_fee_passed_on boolean not null default false;

alter table invoice_payments
  add column if not exists surcharge_cents bigint not null default 0;

alter table invoice_payments
  drop constraint if exists invoice_payments_surcharge_cents_check;
alter table invoice_payments
  add constraint invoice_payments_surcharge_cents_check check (surcharge_cents >= 0);
