-- migration-mode: expand
--
-- Record the Stripe account each hosted invoice and checkout session lives on.
--
-- Pre:  invoices.stripe_invoice_id, invoices.stripe_checkout_session_id and
--       invoice_expected_payments.stripe_invoice_id name a Stripe object but not
--       the account it was created on. Teardown re-reads the firm's CURRENT
--       charge setup, so a firm that switched between platform (destination)
--       charges and direct charges since the link was made addresses the wrong
--       account, Stripe answers "No such object", and the link stays payable.
-- Post: three nullable text columns beside those ids. 'platform' means the
--       link was created on the platform account; an acct_ id means it was
--       created on that connected account (a direct charge). Null means the
--       row predates the column, and teardown falls back to the firm's current
--       setup exactly as it did before. No data changes; the deployed code
--       neither reads nor writes the columns.

alter table invoices
  add column if not exists stripe_invoice_account_id text,
  add column if not exists stripe_checkout_session_account_id text;

alter table invoice_expected_payments
  add column if not exists stripe_invoice_account_id text;

comment on column invoices.stripe_invoice_account_id is
  'Stripe account stripe_invoice_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
comment on column invoices.stripe_checkout_session_account_id is
  'Stripe account stripe_checkout_session_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
comment on column invoice_expected_payments.stripe_invoice_account_id is
  'Stripe account stripe_invoice_id was created on: ''platform'' or an acct_ id. Null = unknown (row predates the column); teardown then uses the firm''s current charge setup.';
