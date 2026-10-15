# Webhooks

The inbound provider webhooks Paralegix accepts, how each authenticates, and how
they stay idempotent under retries.

## Summary

Four external providers push events into the backend: **Stripe** (three endpoints on
two routes: client payments, connected-account events, and subscriptions), **Google Calendar**, and
**Microsoft Outlook / Graph**. Each is an unauthenticated-by-bearer-token route
(providers cannot mint Paralegix Firebase tokens), so each carries its own
provider-native verification: a signed payload for Stripe, a channel token for
Google, a `clientState` (plus a validation handshake) for Outlook.

The two Stripe endpoints are mounted **before** `express.json()` in
`backend/src/app.ts:361`-`362` because Stripe signature verification requires the
raw request body; they use `express.raw({ type: 'application/json' })`. All webhooks
are mounted so they sit **outside** the IP rate limiter, and both Stripe endpoints
run a Postgres-backed exactly-once idempotency gate before touching money. If
`STRIPE_SECRET_KEY` is unset, both Stripe endpoints answer `503 Stripe is not
configured` before verifying anything.

## Key Takeaways

- **Five endpoints, four verification schemes.** Stripe signature (three secrets),
  Google `X-Goog-Channel-Token`, Outlook `clientState` + `validationToken`
  handshake. None use `verifyToken`.
- **Stripe needs the raw body.** Mounted with `express.raw` before `express.json()`;
  a wrong mount order silently breaks signature verification.
- **Exactly-once on money.** Both Stripe webhooks claim the event id in their own
  endpoint's half of the `stripe_events` ledger before processing. A finished event
  acks `200` as a duplicate, one still being processed gets `409` so Stripe retries
  it, a processing error releases the claim, and a claim abandoned by a dead process
  is reclaimed after `STRIPE_EVENT_CLAIM_STALE_SECONDS` (default 600).
- **Ack fast, work async (calendar).** Google/Outlook webhooks respond immediately
  (`200`/`202`) then process in the background; a failed async sync persists a
  durable retry row drained by the `calendar-watch` cron (see /dev/ops/cron-jobs).
- **Webhooks skip rate limiting on purpose.** Their signature/secret gate *is* the
  control, and legitimate provider push can be high-frequency.
- **Calendar webhooks are dropped from request logs.** They are routine, noisy sync
  pings; failures still surface via handler/error logs.

## Endpoints

| Path | Provider | Auth | Body | Ack |
|---|---|---|---|---|
| `POST /api/webhooks/stripe` | Stripe (payments) | Signature via `STRIPE_WEBHOOK_SECRET` | raw | `200 { received }` |
| `POST /api/webhooks/stripe` | Stripe (Connect: `account.updated` from connected accounts) | Signature via `STRIPE_CONNECT_WEBHOOK_SECRET`, and the event must carry `account` | raw | `200 { received }` |
| `POST /api/webhooks/stripe-subscriptions` | Stripe (subscriptions) | Signature via `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` | raw | `200 { received }` |
| `POST /api/webhooks/google-calendar` | Google Calendar | `X-Goog-Channel-Token` (timing-safe) | headers only | `200` empty |
| `POST /api/webhooks/outlook-calendar` | Microsoft Graph | `clientState` + `?validationToken` handshake | JSON `value[]` | `202` / `200` |

## Stripe — payments (`/api/webhooks/stripe`)

`backend/src/modules/stripe/stripe.webhook.routes.ts`. Mounted at
`backend/src/app.ts:361`.

**Authentication.** Two Stripe endpoints deliver to this route, so it verifies the
`stripe-signature` header against the raw body with `STRIPE_WEBHOOK_SECRET` first and,
when that fails, `STRIPE_CONNECT_WEBHOOK_SECRET`. Stripe will not send your own events
and connected-account events through one snapshot endpoint, which is why the Connect
endpoint exists at all. An event that only the Connect secret verifies must name the
connected account it came from (`event.account`, which Stripe sets on every Connect
event); otherwise it is refused, so a leaked Connect secret cannot forge a platform
event such as a paid checkout. A verification failure returns `400` and the event is
never processed. `STRIPE_CONNECT_WEBHOOK_SECRET` is optional: unset, only the first
secret is tried. Covered by `backend/tests/stripe/webhookConnectSecret.test.ts`.

**Idempotency.** After the signature check, `claimStripeEvent(event.id, endpoint)`
(`backend/src/modules/stripe/stripe.service.ts`) claims the event in the
`stripe_events` ledger. The ledger is keyed by `(endpoint, event_id)`, with
`endpoint` either `payments` or `subscriptions`, because Stripe delivers the same
event id to every endpoint subscribed to it (both receive `invoice.paid`) and each
endpoint has to run its own handler. Each row is `processing` while a delivery holds
it and `done` once the handler succeeded. The claim is one statement with four
outcomes:

| Ledger state for this endpoint and event id | Outcome | Response |
|---|---|---|
| No row | Inserted as `processing`; the handler runs | handler result |
| `done` | Duplicate, skipped | `200 { received: true, duplicate: true }` |
| `processing`, claimed within the stale threshold | In flight elsewhere, skipped | `409`, so Stripe retries later |
| `processing`, claimed longer ago than the threshold | Reclaimed; the handler runs | handler result |

The stale threshold is `STRIPE_EVENT_CLAIM_STALE_SECONDS` (default 600). It is what
recovers an event whose holder died mid-handler (a deploy SIGTERM, an OOM kill):
nothing releases that row, so without the threshold every retry would be refused.
An in-flight duplicate is not acknowledged with a `200`, because the first attempt
may still fail, and a `2xx` would stop Stripe from ever sending the event again.

On success the route calls `finishStripeEvent`, which marks the row `done`. On a
processing error it calls `releaseStripeEvent`, which deletes the claim so Stripe's
retry processes the event at once, and answers `500`. Both match the claim's token
(its `claimed_at`), so a slow holder whose claim was reclaimed cannot finish or
delete the claim that replaced it. Neither throws: a failed release is logged as an
error and the event waits out the stale threshold instead of being lost, and a
failed finish is logged and still answers `200`, because the handler's work is
committed. If the claim query itself throws, the route returns `500` so Stripe
retries rather than processing unguarded. Money mutations additionally run under a
`SELECT ... FOR UPDATE` row lock with fully JS-computed writes (no in-database
increment), so a re-apply is a no-op. Covered by
`backend/tests/stripe/webhookEventLedger.test.ts`.

**Events handled** (`stripe.webhook.routes.ts:62`):

| Event | Effect |
|---|---|
| `checkout.session.completed` | Records an invoice payment **only when `payment_status === 'paid'`** (a synchronous card payment). A delayed method fires this while still unpaid; recording then would mark the invoice paid before funds arrive. Trust deposits (`metadata.depositType === 'trust'`) are intentionally skipped here — ACH can still fail post-checkout, so they post on `payment_intent.succeeded` |
| `checkout.session.async_payment_succeeded` | A delayed (e.g. bank-debit) invoice payment settled after the fact; records it via the same paid-only path. Trust deposits skipped |
| `checkout.session.async_payment_failed` | A delayed invoice payment failed; nothing was recorded, so just clears the pending checkout-session marker so the invoice can be re-requested. Trust deposits skipped |
| `checkout.session.expired` | Cleans up an expired checkout |
| `payment_intent.succeeded` | On the platform, posts a trust (ACH) deposit and no-ops for non-trust intents. On a connected account, records a card-form invoice payment (`metadata.payChannel === 'card_form'`), with the client-paid credit card fee kept apart from the invoice money, when the firm the metadata names owns `event.account`. Idempotent on the payment intent id, so the immediate record at confirm and this event apply once |
| `payment_intent.payment_failed` | On the platform, a trust (ACH) deposit failed at the bank after checkout. Nothing was posted, so there is no ledger work; the firm's trust managers (owners and `trust.manage`) get a non-muteable `trust_deposit_failed` notification naming the amount, the client and the bank's reason. On a connected account, a card-form payment failed: it is cancelled so its client secret cannot confirm it with another card, and the invoice's `stripe_card_payment_intent_id` is cleared if it still points at it |
| `payment_intent.canceled` | On a connected account, releases the invoice a cancelled card-form payment was holding. Ignored on the platform |
| `charge.refunded` | Reverses a trust deposit and/or an invoice payment (each path no-ops if not theirs) |
| `charge.dispute.created` | Reverses trust deposit and/or invoice payment for the disputed charge. The reversal target is the charge's `amount_refunded` (read from the charge, on the connected account for a Connect event) plus the disputed amount, capped at the charge, because Stripe's dispute amount does not include earlier refunds. An inquiry (`status` starting `warning_`) withdraws no funds and closes as `warning_closed`, so it reverses nothing |
| `charge.dispute.funds_withdrawn` | The same reversal as `charge.dispute.created`, on the event Stripe sends when it actually debits the funds (including when an inquiry escalates). Both converge on one cumulative target, so a dispute that sends both reverses once |
| `charge.dispute.closed` | Restores funds reversed on dispute if the dispute was won. A lost dispute leaves the reversal and emails the client that the payment was returned (the only client email a dispute sends). For a trust deposit with automatic recovery on, it first refunds any charge made to the firm's operating card for the shortfall, then returns only the rest to the trust connected account |
| `charge.refund.updated` | Restores funds if a previously-successful refund later fails (e.g. an ACH refund bounces) |
| `invoice.paid` | Marks a Stripe-hosted invoice paid. **Ignored unless `metadata.invoiceId` is present**: the trust ACH fee invoices this module creates itself carry `{ lawFirmId, trustTransactionId }`, and subscription invoices carry neither. Handing one of those to the invoice handler threw, answered 500, and Stripe retried for three days |
| `invoice.voided` | Marks a Stripe-hosted invoice voided, under the same `metadata.invoiceId` gate. Ignored when the event names an invoice the firm no longer points at: `requestPayment` voids the old hosted invoice and stores a new id, and the old one's void must not clear the live link |
| `account.updated` | Syncs connected-account (Connect) capability/onboarding state. Arrives on the separate **Connect endpoint** (see below). Without it, a firm whose charges Stripe disables keeps `stripe_charges_enabled = true` until somebody opens the settings page, which refreshes from Stripe on read |

Unrecognized event types fall through the `default` and ack `200` without work.

**Events acknowledged and ignored.** A valid signature proves Stripe sent an event, not
that it is about money Paralegix collected for the firm it names, so the route acks `200`
and logs (`Stripe webhook event ignored`) without acting on:

- an event whose `livemode` does not match the mode of `STRIPE_SECRET_KEY` (`sk_live_` or
  `rk_live_` is live). Stripe sends test-mode Connect events to live Connect endpoints, and a
  Standard-account firm can create test objects on its own account with any metadata.
  These are not claimed in the ledger;
- a Connect event (`event.account` set) for an invoice checkout unless
  `metadata.chargeModel` is `direct` and the named firm's `stripe_account_id` equals
  `event.account`;
- a platform event for an invoice checkout whose metadata says `chargeModel: 'direct'`;
- a Connect `payment_intent.*` event that is not a card-form invoice payment (a trust deposit
  is a platform destination charge), or a card-form one whose named firm does not own
  `event.account`;
- a Connect refund, dispute or refund update whose invoice payment is not a direct charge
  of the firm that owns `event.account`. The trust handlers never run for a Connect event.

A checkout session that is not an invoice payment (`mode` other than `payment`, or no
invoice metadata, such as a subscription checkout) is acknowledged without action rather
than failed.

## Stripe — subscriptions (`/api/webhooks/stripe-subscriptions`)

`backend/src/modules/subscriptions/subscriptions.webhook.routes.ts`. Mounted at
`backend/src/app.ts:362`. Same shape as the payments webhook but a **separate signing
secret** (`STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, `subscriptions.webhook.routes.ts:21`)
and the same idempotency gate, claiming in the ledger's `subscriptions` half.

**Events handled** (`subscriptions.webhook.routes.ts:47`):

| Event | Effect |
|---|---|
| `customer.subscription.created` / `.updated` | `handleSubscriptionChange`: retrieves the subscription from Stripe and applies its CURRENT state (status, plan, period), not the payload's, so a retried older event cannot overwrite newer state. A failed retrieve answers `500` so Stripe retries; a subscription Stripe no longer has is skipped |
| `customer.subscription.deleted` | `handleSubscriptionDeleted` — **locks the firm** (`billing_status = 'canceled'`, `comped = false`) so it hits the paywall; there is no free self-serve tier |
| `customer.subscription.trial_will_end` | `handleTrialEnding` — trial-ending notification |
| `invoice.paid` | `handleSubscriptionInvoicePaid` — only when `event.data.object.subscription` is set (ignores one-off invoices) |
| `invoice.payment_failed` | `handlePaymentFailed` — only for subscription invoices |

`handleSubscriptionChange`, `handleSubscriptionInvoicePaid` and `handlePaymentFailed`
ignore (and log) an event for a subscription other than the firm's stored one while
the stored one is still live at Stripe, so a duplicate subscription or a late event
from a replaced one cannot take over the firm's plan or mark it past due. Once Stripe
reports the stored subscription ended or gone, an event for a new subscription moves
the firm onto it.

These handlers are the same ones the `reconcile-billing` cron re-invokes as a safety
net when a webhook is missed (see /dev/ops/cron-jobs).

### Which endpoint gets which events

Three Stripe endpoints. The lists overlap on `invoice.paid`: the payments endpoint
acknowledges and ignores it, and the subscriptions endpoint records subscription
renewals from it. Stripe delivers that event to both under one event id, which is why
the idempotency ledger is keyed per endpoint; on a shared key the payments endpoint's
claim made the subscription endpoint answer "duplicate" and drop the renewal.

| Endpoint URL | Events from | Events (exact list) | Secret env var |
|---|---|---|---|
| `/api/webhooks/stripe` | your account | `account.updated`, `charge.dispute.closed`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.refund.updated`, `charge.refunded`, `checkout.session.async_payment_failed`, `checkout.session.async_payment_succeeded`, `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.voided`, `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.succeeded` | `STRIPE_WEBHOOK_SECRET` |
| `/api/webhooks/stripe` | connected accounts | the same 15 events as the row above: `account.updated` for every firm, and every payment event of a direct-charge firm (a Standard account, see `DIRECT_CHARGE_MIGRATION.md`), whose charges happen on its own account | `STRIPE_CONNECT_WEBHOOK_SECRET` |
| `/api/webhooks/stripe-subscriptions` | your account | `customer.subscription.created`, `.updated`, `.deleted`, `.trial_will_end`, `invoice.paid`, `invoice.payment_failed` | `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` |

**API version.** Stripe renders a webhook payload in the ENDPOINT's API version, not the
SDK's, and an endpoint's version cannot be changed after creation. Create every endpoint on
the version `backend/src/modules/stripe/stripe.config.ts` pins (`STRIPE_API_VERSION`,
currently `2026-08-26.dahlia`). To move an endpoint to a new version, create a new one,
put its secret on the service, then disable the old one. Duplicate deliveries during the
switch are harmless: both carry the same event id, and the `stripe_events` claim keeps one.

**Getting a signing secret.** A secret is returned once, in the response that creates a
v1 endpoint (`stripe webhook_endpoints create ...`). The v2 event-destinations API never
returns it, so create endpoints through v1 (with `connect=true` for the Connect one) or
reveal the secret in the Dashboard.

**Current state (staging, test mode).** The three endpoints above exist on `dahlia`, and the
staging service holds their three secrets. Production still runs the pre-Postgres stack
with one old endpoint; see `PRODUCTION_CUTOVER.md` for what the cutover needs.

## Google Calendar (`/api/webhooks/google-calendar`)

`backend/src/modules/calendar/google/google.webhook.routes.ts`. Mounted at
`backend/src/app.ts:884`.

**Transport.** Google Watch sends **headers, not a JSON body**: `X-Goog-Channel-ID`
(maps to a user), `X-Goog-Resource-State` (`sync` handshake or `exists` change), and
`X-Goog-Channel-Token` (the token we set when creating the channel). A request with no
`X-Goog-Channel-ID` is answered `400`.

**Authentication.** The channel id is looked up in `calendar_subscriptions`
(`provider = 'google'`, via `calendarSyncRepo.getWatchChannel`); the
stored token is compared against `X-Goog-Channel-Token` with a constant-time
`tokensMatch` (`google.webhook.routes.ts:9`) so a mismatch can't be timing-probed.
An unknown channel or token mismatch returns `200` (not an error) so Google does not
retry a request that will never succeed (`google.webhook.routes.ts:44`-`55`).

**Flow.** The initial `sync` state is acked `200` and ignored. For a real change the
route responds `200` immediately (Google requires a response within 30s), then
processes async. A **bounce-back short-circuit** skips processing if we pushed to
this user's calendar in the last 90s (the notification is the echo of our own write,
`google.webhook.routes.ts:66`). Otherwise it runs the user's incremental sync; on
failure it persists a durable retry row via `recordWebhookFailure` instead of
dropping the change.

**Retry.** The async sync is idempotent (upserts dedupe by provider event id). Failed
work items are drained by the `calendar-watch` cron with exponential backoff and
dead-lettering (see /dev/ops/cron-jobs).

## Outlook / Microsoft Graph (`/api/webhooks/outlook-calendar`)

`backend/src/modules/calendar/outlook/outlook.webhook.routes.ts`. Mounted at
`backend/src/app.ts:886`. Two modes:

1. **Validation handshake.** On subscription creation Microsoft sends
   `?validationToken=<token>`; the route echoes it back as `text/plain`
   (`outlook.webhook.routes.ts:35`). This proves endpoint ownership.
2. **Notification.** Microsoft POSTs JSON with `req.body.value[]` change
   notifications. The route responds `202` immediately (30s deadline), then processes
   async.

**Authentication.** Each notification's `clientState` is compared against the stored
subscription's `clientState` (`outlook.webhook.routes.ts:86`); a mismatch skips that
notification.

**Idempotency & efficiency.** Microsoft can deliver the same change multiple times in
one POST, so the batch is **deduped** by `(subscriptionId, eventId, changeType)`
(`outlook.webhook.routes.ts:46`), and subscription lookups and per-user tokens are
cached once per batch. `updated` notifications get the same 90s bounce-back
short-circuit as Google; `created`/`deleted` are always processed (rare and
important). A failed notification persists a durable, per-`(provider,user)`-coalesced
retry row (`outlook.webhook.routes.ts:123`).

## Rate limiting & logging

- **Exempt from IP rate limiting.** All four webhooks are mounted so the global
  limiter never sees them (the Stripe endpoints are registered before the limiter at
  `backend/src/app.ts:836`; the calendar endpoints are mounted after it but skipped by
  its `/api/webhooks/` path check in `rateLimiters.ts`). Their
  signature/secret gate is the real control, and provider push can legitimately
  burst. See /dev/admin/rate-limiting.
- **Calendar webhooks dropped from request logs.** `autoLogging.ignore` in the
  pino-http config (`backend/src/app.ts:449`-`456`) drops
  `/api/webhooks/google-calendar` and `/api/webhooks/outlook-calendar` completion
  lines because they are routine sync pings; handler/error logs still emit
  independently, so failures remain visible. **Stripe webhooks stay logged** (rare
  and billing-critical).

## Debugging

- **Stripe locally.** See /dev/getting-started/local-development for the full setup. The
  CLI must be logged in to the SAME Stripe account as `STRIPE_SECRET_KEY` (every CLI
  command prints `Running in <account>`; `stripe prices retrieve <a configured price id>`
  must succeed there), or `stripe listen` forwards another account's events and every
  local checkout silently stays unpaid. Stripe CLI 1.51 and later refuses to start without
  `--events`, so pass the two event lists above (the `stripe-dev` skill has both commands):
  ```bash
  stripe listen --forward-to localhost:5001/api/webhooks/stripe \
    --forward-connect-to localhost:5001/api/webhooks/stripe --events <payments list>
  stripe listen --forward-to localhost:5001/api/webhooks/stripe-subscriptions --events <subscriptions list>
  ```
  The CLI signs every forwarded event, platform or Connect, with one secret per account,
  so locally `STRIPE_WEBHOOK_SECRET` and `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` are equal and
  `STRIPE_CONNECT_WEBHOOK_SECRET` is not needed. `stripe trigger payment_intent.succeeded`
  proves delivery: the payments listener logs `[200]`.
  Trigger flows with the test cards `4242 4242 4242 4242` (success),
  `4000 0000 0000 9995` (decline), `4000 0025 0000 3155` (3D Secure).
- **A duplicate Stripe event acked `200 { duplicate: true }`** means the id is
  `done` in `stripe_events` for that endpoint. To force reprocessing in dev, delete
  that row: `delete from stripe_events where endpoint = '<payments|subscriptions>'
  and event_id = '<evt_...>'`.
- **A Stripe `409`** means another delivery of the same event is still processing it
  (or died while doing so less than `STRIPE_EVENT_CLAIM_STALE_SECONDS` ago). Stripe
  retries it; after the threshold the next retry reclaims it.
- **A Stripe `400`** is a signature failure — almost always a stale/wrong signing
  secret or a body that was JSON-parsed before reaching the raw-body route.
- **Calendar webhooks return `200`/`202` even on unknown channel/subscription** by
  design, so a missing sync is not visible in the response. Check handler error logs
  (`google.webhook:` / `outlook.webhook:` prefixes) and the
  `calendar_webhook_failures` table / `calendar-watch` cron summary for dropped and
  dead-lettered work.

## Source

- `backend/src/app.ts` — raw-body Stripe mounts, calendar mounts, rate-limiter skip, log-drop rules
- `backend/src/modules/stripe/stripe.webhook.routes.ts` — payments/Connect webhook
- `backend/src/modules/subscriptions/subscriptions.webhook.routes.ts` — subscription webhook
- `backend/src/modules/stripe/stripe.service.ts`: the `claimStripeEvent` / `finishStripeEvent` / `releaseStripeEvent` ledger
- `backend/src/modules/calendar/google/google.webhook.routes.ts` — Google Watch webhook
- `backend/src/modules/calendar/outlook/outlook.webhook.routes.ts` — Outlook/Graph webhook
- `.claude/skills/stripe-dev/SKILL.md`: local Stripe CLI forwarding setup
- `backend/tests/stripe/webhookConnectSecret.test.ts`: the two-secret rule on the payments route
