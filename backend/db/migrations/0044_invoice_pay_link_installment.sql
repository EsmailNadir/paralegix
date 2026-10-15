-- migration-mode: expand
-- Which payment-plan installment the invoice's secure payment link asks for.
-- The value is the row's stable installment_id (invoice_expected_payments.
-- installment_id), not its uuid, because a plan edit deletes and reinserts the
-- rows. Null means the link asks for the full open balance.
--
-- Pre:  invoices has no pay link installment target.
-- Post: invoices.pay_link_installment_id exists, text, nullable, no default.
--       Old code never reads it, and every existing link keeps asking for the
--       full balance.

alter table invoices
  add column if not exists pay_link_installment_id text;
