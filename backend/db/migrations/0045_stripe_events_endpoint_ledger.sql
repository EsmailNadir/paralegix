-- migration-mode: contract
-- Splits the Stripe webhook idempotency ledger per endpoint and records whether
-- a claimed event finished.
--
-- Both webhook endpoints (payments at /api/webhooks/stripe, subscriptions at
-- /api/webhooks/stripe-subscriptions) are subscribed to invoice.paid, and Stripe
-- delivers the same event id to each. Keyed on event_id alone, the first claim
-- won and the other endpoint answered "duplicate" without running its handler.
-- The ledger also could not tell a finished event from one still in flight or
-- abandoned by a process that died mid-handler, so either was acknowledged as a
-- duplicate and never retried.
--
-- CONTRACT, not expand: the primary key moves from (event_id) to
-- (endpoint, event_id), so the deployed claim statement
-- `insert ... on conflict (event_id) do nothing` no longer names a unique
-- constraint and fails. That code answers 500 on a failed claim, so Stripe
-- retries every event until the new code is live, but no webhook is processed
-- in between.
--
-- Pre:  stripe_events(event_id text primary key, processed_at timestamptz not
--       null default now()); every row is a finished event.
-- Post: stripe_events has endpoint ('payments' | 'subscriptions', not null),
--       status ('processing' | 'done', not null), claimed_at (timestamptz not
--       null) and a nullable processed_at that is set exactly when status is
--       'done'. Primary key (endpoint, event_id). Every pre-existing row is
--       endpoint 'payments', status 'done', processed_at unchanged.

alter table stripe_events
  add column if not exists endpoint text not null default 'payments';

-- Existing rows are finished events; new claims start as 'processing'.
alter table stripe_events
  add column if not exists status text not null default 'done';
alter table stripe_events
  alter column status set default 'processing';

alter table stripe_events
  add column if not exists claimed_at timestamptz not null default now();

alter table stripe_events
  alter column processed_at drop not null,
  alter column processed_at drop default;

alter table stripe_events
  add constraint stripe_events_endpoint_check
    check (endpoint in ('payments', 'subscriptions')),
  add constraint stripe_events_status_check
    check (status in ('processing', 'done')),
  add constraint stripe_events_processed_when_done
    check ((status = 'done') = (processed_at is not null));

alter table stripe_events drop constraint stripe_events_pkey;
alter table stripe_events add primary key (endpoint, event_id);
