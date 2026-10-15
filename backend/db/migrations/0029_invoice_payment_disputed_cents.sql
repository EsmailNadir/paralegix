-- migration-mode: expand
--
-- Track how much of a Stripe payment's reversal came from a dispute.
--
-- Pre:  invoice_payments.stripe_refunded_cents is one cumulative figure for
--       everything Stripe took back on the payment, refund and dispute alike.
--       A won dispute therefore cannot tell the money it returns from money a
--       real refund already sent back to the customer, and restores both.
-- Post: invoice_payments.stripe_disputed_cents, the part of
--       stripe_refunded_cents that an open or lost dispute accounts for. A won
--       dispute restores at most this much and lowers it by the same amount.
--       It never exceeds stripe_refunded_cents. Existing rows read 0, which is
--       what a payment with no dispute on record means; no data changes, and the
--       deployed code neither reads nor writes the column.

alter table invoice_payments
  add column if not exists stripe_disputed_cents bigint not null default 0;

alter table invoice_payments
  add constraint invoice_payments_stripe_disputed_cents_check
  check (stripe_disputed_cents >= 0 and stripe_disputed_cents <= stripe_refunded_cents);

comment on column invoice_payments.stripe_disputed_cents is
  'The part of stripe_refunded_cents that a dispute took (cumulative reversal minus refunds). A won dispute restores at most this much.';
