-- migration-mode: expand
-- A card payment taken through the card form that is waiting on the client (a
-- bank verification step) or on Stripe. Nothing else may charge the invoice
-- while it is set, and closing the invoice's payment surfaces cancels it.
--
-- Pre:  invoices has no pointer to an in-flight card-form PaymentIntent.
-- Post: invoices.stripe_card_payment_intent_id and
--       invoices.stripe_card_payment_intent_account_id exist, text, nullable,
--       no default. Old code never reads them, and every existing invoice
--       reads as having no card payment in flight.

alter table invoices
  add column if not exists stripe_card_payment_intent_id text;
alter table invoices
  add column if not exists stripe_card_payment_intent_account_id text;

comment on column invoices.stripe_card_payment_intent_id is 'PaymentIntent of a card-form payment not yet settled; cleared when it succeeds, fails or is cancelled.';
comment on column invoices.stripe_card_payment_intent_account_id is 'Stripe account stripe_card_payment_intent_id was created on (an acct_ id).';
