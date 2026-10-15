---
name: stripe-dev
description: Start Stripe webhook forwarding and test billing or subscriptions locally.
disable-model-invocation: true
---

# Stripe Local Dev

Sets up and runs the Stripe CLI webhook forwarding needed for local billing development.

## Step 1 — Env var check

Read `backend/.env` and check for the following variables. **Only mention a variable if it is missing or empty.** If everything is present, say nothing about env vars and move straight to Step 2.

Required vars:
- `STRIPE_SECRET_KEY` — starts with `sk_test_` or `sk_live_`
- `STRIPE_WEBHOOK_SECRET` — starts with `whsec_`
- `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` — starts with `whsec_`
- `STRIPE_BASIC_MONTHLY_PRICE_ID`
- `STRIPE_BASIC_ANNUAL_PRICE_ID`
- `STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID`
- `STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID`
- `STRIPE_ENTERPRISE_MONTHLY_PRICE_ID`
- `STRIPE_ENTERPRISE_ANNUAL_PRICE_ID`

If any are missing, list only the missing ones and stop — the user needs to add them before continuing.

## Step 2 — Check Stripe CLI

Run:
```bash
stripe --version
```

If the command is not found, tell the user to install the Stripe CLI for their platform —
macOS `brew install stripe/stripe-cli/stripe`, Linux via the apt/yum repo, Windows
`scoop install stripe` — or download a binary from https://docs.stripe.com/stripe-cli.
Then `stripe login` to authenticate. Do not install it for them without asking.

If already installed, check it is logged in to the SAME Stripe account as `STRIPE_SECRET_KEY`.
Every CLI command prints the account it runs in (`Running in <name> (acct_...)`). A price ID from
`backend/.env` must resolve there:

```bash
stripe prices retrieve <STRIPE_BASIC_MONTHLY_PRICE_ID value>
```

A `No such price` means the CLI is in another account, often a separate sandbox. `stripe listen`
then forwards that account's events, never the ones the app creates, and every local checkout
silently stays unpaid. Ask the user to run `stripe login` and pick the account the app's keys
belong to. Never compare or print the secret key itself.

## Step 3 — Start the two webhook listeners

Two separate listeners are required — one for each webhook endpoint. Start both as background processes.

**Listener 1 — Stripe Connect / client invoice payments:**
```bash
stripe listen --forward-to localhost:5001/api/webhooks/stripe \
  --forward-connect-to localhost:5001/api/webhooks/stripe \
  --events account.updated,charge.dispute.closed,charge.dispute.created,charge.refund.updated,charge.refunded,checkout.session.async_payment_failed,checkout.session.async_payment_succeeded,checkout.session.completed,checkout.session.expired,invoice.paid,invoice.voided,payment_intent.payment_failed,payment_intent.succeeded
```

`--forward-connect-to` delivers every event Stripe raises on a firm's connected account rather
than on the platform. That covers `account.updated` (without it a firm whose charges Stripe
disables still shows as able to take payments until someone opens the payments settings page) and
every invoice payment event for a firm on a Standard account: those are direct charges made on the
firm's own account (`invoiceChargeScope` in `stripe.service.ts`). Legacy Express firms and trust
deposits still use destination charges, whose events land on the platform account.

**Listener 2 — Subscription lifecycle events:**
```bash
stripe listen --forward-to localhost:5001/api/webhooks/stripe-subscriptions \
  --events customer.subscription.created,customer.subscription.deleted,customer.subscription.trial_will_end,customer.subscription.updated,invoice.paid,invoice.payment_failed
```

Stripe CLI 1.51 and later refuses to start without `--events` (or `--all-snapshot`). The two lists
are exactly the events each route handles, the same lists the staging endpoints subscribe to.
`stripe trigger payment_intent.succeeded` then proves delivery: listener 1 logs `[200]`.

Start both with `run_in_background: true`. Each will print a webhook signing secret like:
```
> Ready! Your webhook signing secret is whsec_...
```

These printed secrets are for the current session only. If `STRIPE_WEBHOOK_SECRET` and `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` in `backend/.env` already have values, they're already set from a prior session — do not overwrite them unless the user asks.

Once both are running, tell the user:
- Both listeners are active
- Listener 1 handles: `checkout.session.*`, `payment_intent.*`, `charge.*`, `invoice.paid`, `invoice.voided` (client invoice payments via Stripe Connect)
- Listener 2 handles: `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed` (plan subscriptions)

## Step 4 — Testing tips (show on request or first run)

**Test a subscription checkout:**
1. Go to `http://localhost:3000/lawfirm/<id>/settings/billing`
2. Click a plan's Subscribe button
3. In Stripe Checkout use card `4242 4242 4242 4242`, any future expiry, any CVC
4. After redirect, the subscription webhook fires and the firm's plan updates

**Test plan limit enforcement:**
- Temporarily set `limitOverrides` on the firm via SQL:
  ```sql
  UPDATE law_firms
  SET plan = jsonb_set(plan, '{limitOverrides}', '{"maxMatters": 1, "maxMembers": 1}')
  WHERE id = '<law_firm_id>';
  ```
- Try to create a matter or invite a member — the UpgradePrompt should appear
- Clean up afterwards:
  ```sql
  UPDATE law_firms SET plan = plan - 'limitOverrides' WHERE id = '<law_firm_id>';
  ```

**Test cards:**
- `4242 4242 4242 4242` — successful payment
- `4000 0000 0000 9995` — card declined
- `4000 0025 0000 3155` — requires 3D Secure auth
