-- migration-mode: expand
-- A secure payment link for an invoice that needs no login: the token in the
-- link is the only credential. It opens a Paralegix pay page where the client
-- chooses card or bank transfer and sees any processing fee the firm passed on.
--
-- Pre:  invoices has no pay link token.
-- Post: invoices.pay_link_token exists, text, null until the firm requests
--       payment, unique when set. A new request replaces it; voiding the
--       request clears it.

alter table invoices
  add column if not exists pay_link_token text;

create unique index if not exists invoices_pay_link_token_key
  on invoices (pay_link_token)
  where pay_link_token is not null;
