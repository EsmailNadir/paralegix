const express = require('express');
const router = express.Router();
const stripe = require('./stripe.config');
const stripeService = require('./stripe.service');
const cardPayment = require('./cardPayment.service');

function buildWebhookLogContext(event: any) {
  const object = event?.data?.object || {};
  const metadata = object.metadata || {};
  return {
    eventId: event?.id || null,
    eventType: event?.type || null,
    stripeObjectId: object.id || null,
    stripeInvoiceId: object.object === 'invoice' ? object.id : (object.invoice || null),
    checkoutSessionId: object.object === 'checkout.session' ? object.id : null,
    paymentIntentId: object.payment_intent || null,
    paralegixInvoiceId: metadata.invoiceId || null,
    lawFirmId: metadata.lawFirmId || null,
    contextType: metadata.contextType || null,
    entityId: metadata.entityId || null,
  };
}

/**
 * Log an event the route acknowledges without acting on, with what is needed to
 * find it in Stripe and see why it was refused.
 */
function logIgnoredEvent(event: any, reason: string) {
  console.warn('Stripe webhook event ignored:', {
    ...buildWebhookLogContext(event),
    connectedAccountId: event?.account || null,
    livemode: event?.livemode ?? null,
    chargeModel: event?.data?.object?.metadata?.chargeModel || null,
    reason,
  });
}

/** Whether STRIPE_SECRET_KEY is a live key, so only live-mode events are ours. */
function stripeKeyIsLive() {
  return /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
}

/** Run a checkout handler only when the event may act on the firm its metadata names. */
async function checkoutInScope(event: any, connectedAccountId: string | null) {
  const refusal = await stripeService.checkoutEventScopeRefusal(event.data.object, connectedAccountId);
  if (refusal) logIgnoredEvent(event, refusal);
  return !refusal;
}

/**
 * charge.dispute.created and charge.dispute.funds_withdrawn. Both converge on
 * the same cumulative target, so a real dispute that sends both reverses once.
 * The target adds what was already refunded on the charge to the disputed
 * amount, because the handlers treat it as the total reversed so far. A trust
 * deposit is a platform charge, so a Connect event never reaches its handler.
 */
async function reverseDisputedFunds(event: any, connectedAccountId: string | null) {
  const dispute = event.data.object || {};
  const target = await stripeService.disputeReversalTargetCents(dispute, connectedAccountId);
  if (!connectedAccountId) {
    await stripeService.handleTrustDepositReversal(
      { payment_intent: dispute.payment_intent, amount_refunded: target, created: event.created },
      'ACH dispute',
      event.created,
    );
  }
  await stripeService.handleInvoicePaymentReversal(
    { payment_intent: dispute.payment_intent, amount_refunded: target },
    'dispute',
    connectedAccountId,
  );
}

// POST /api/webhooks/stripe
// This route receives raw body (mounted before express.json() in app.js)
router.post('/', async (req: any, res: any) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  const sig = req.headers['stripe-signature'];
  let event;

  // Two Stripe endpoints deliver here. Stripe will not send platform events and
  // connected-account events through one snapshot endpoint, so `account.updated`
  // for a firm's connected account arrives on a separate Connect endpoint with its
  // own secret. An event only that secret verifies must name the connected account
  // it came from (`event.account`), so the Connect secret cannot pass off a
  // platform event such as a completed checkout.
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    let connectEvent = null;
    if (connectSecret) {
      try {
        connectEvent = stripe.webhooks.constructEvent(req.body, sig, connectSecret);
      } catch {
        connectEvent = null;
      }
    }
    if (!connectEvent || !connectEvent.account) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }
    event = connectEvent;
  }

  // Stripe delivers test-mode Connect events to live Connect endpoints, and a
  // firm with a Standard account can create test-mode objects on it carrying
  // any metadata. Only events in the mode of our own key are ours; the rest are
  // acknowledged so Stripe stops sending them, and never claimed or acted on.
  if (Boolean(event.livemode) !== stripeKeyIsLive()) {
    logIgnoredEvent(event, 'the event mode does not match STRIPE_SECRET_KEY');
    return res.json({ received: true });
  }
  // Set on every Connect event: the connected account whose objects it describes.
  const connectedAccountId: string | null = typeof event.account === 'string' && event.account ? event.account : null;

  // Idempotency gate: claim the event id in this endpoint's ledger before
  // processing, so a retry or parallel delivery cannot double-apply a payment.
  // A finished event is acked 200 as a duplicate. One another delivery is still
  // processing gets a 409, not a 200: that attempt may yet fail, and a 2xx would
  // stop Stripe from ever sending the event again.
  let claim;
  try {
    claim = await stripeService.claimStripeEvent(event.id, 'payments');
  } catch (err: any) {
    // If the idempotency claim itself fails, surface a 500 so Stripe retries
    // rather than risk processing without the guard.
    console.error('Stripe webhook idempotency claim failed:', {
      ...buildWebhookLogContext(event),
      error: err.message,
    });
    return res.status(500).json({ error: 'Webhook idempotency check failed' });
  }
  if (claim.status === 'duplicate') {
    return res.json({ received: true, duplicate: true });
  }
  if (claim.status === 'in_flight') {
    return res.status(409).json({ error: 'Webhook event is already being processed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        // Invoice payments post here: a card on completion, a delayed method
        // (e.g. bank debit) when it settles (the handler requires payment_status
        // 'paid'). Trust deposits are ACH and post on payment_intent.succeeded
        // instead (ACH can still fail after checkout), so a trust deposit session
        // is intentionally not acted on here.
        const md = event.data.object?.metadata || {};
        if (md.depositType !== 'trust' && await checkoutInScope(event, connectedAccountId)) {
          await stripeService.handleCheckoutCompleted(event.data.object);
        }
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const md = event.data.object?.metadata || {};
        if (md.depositType !== 'trust' && await checkoutInScope(event, connectedAccountId)) {
          await stripeService.handleCheckoutAsyncPaymentFailed(event.data.object);
        }
        break;
      }
      case 'checkout.session.expired':
        if (await checkoutInScope(event, connectedAccountId)) {
          await stripeService.handleCheckoutExpired(event.data.object);
        }
        break;
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        // On a connected account only a card-form invoice payment is acted on:
        // it is a direct charge on the firm's own account, recorded when it
        // succeeds and releasing the invoice when it fails or is cancelled. The
        // recorder checks the account belongs to the firm the metadata names.
        // A trust deposit is a platform destination charge, so a Connect event
        // is never one, whatever its metadata says.
        if (connectedAccountId) {
          const md = event.data.object?.metadata || {};
          if (md.depositType === 'trust') {
            logIgnoredEvent(event, 'a trust deposit is never a connected-account event');
          } else if (md.payChannel === cardPayment.CARD_FORM_PAY_CHANNEL) {
            if (event.type === 'payment_intent.succeeded') {
              await cardPayment.recordCardPaymentIntent(event.data.object, connectedAccountId);
            } else {
              await cardPayment.releaseCardPaymentIntent(event.data.object, connectedAccountId);
            }
          }
          break;
        }
        // On the platform only trust (ACH) deposits are acted on; the handlers
        // no-op for other payment intents. A cancelled one never posted.
        if (event.type === 'payment_intent.canceled') break;
        if (event.type === 'payment_intent.succeeded') {
          // The event time (settlement) dates the ledger entry, not the payment
          // intent creation time (checkout, ~4 business days earlier for ACH).
          await stripeService.handleTrustDepositPaymentSucceeded(event.data.object, event.created);
        } else {
          await stripeService.handleTrustDepositPaymentFailed(event.data.object);
        }
        break;
      }
      case 'charge.refunded':
        // A refunded charge could be a trust deposit OR an invoice payment. Attempt
        // both reversal paths; each no-ops if the charge isn't theirs. The reversal
        // is dated at the event time, not the original charge date. A Connect
        // refund can only be a direct-charge invoice payment.
        if (!connectedAccountId) {
          await stripeService.handleTrustDepositReversal(event.data.object, 'ACH return / refund', event.created);
        }
        await stripeService.handleInvoicePaymentReversal(event.data.object, 'refund', connectedAccountId);
        break;
      case 'charge.dispute.created':
        // An inquiry (`warning_*`) withdraws no funds and closes as
        // `warning_closed`, which restores nothing, so reversing on it would be
        // permanent. If it escalates, charge.dispute.funds_withdrawn reverses then.
        if (String(event.data.object?.status || '').startsWith('warning_')) break;
        await reverseDisputedFunds(event, connectedAccountId);
        break;
      case 'charge.dispute.funds_withdrawn':
        await reverseDisputedFunds(event, connectedAccountId);
        break;
      case 'charge.dispute.closed':
        // A won dispute returns the funds, so the reversal is undone; a lost one
        // leaves it and tells the client the payment was returned.
        await stripeService.handleDisputeClosed(event.data.object, event.created, connectedAccountId);
        break;
      case 'charge.refund.updated':
        // A refund we reversed on charge.refunded can later fail (e.g. an ACH refund
        // bounces); restore the funds when that happens (no-op otherwise).
        await stripeService.handleRefundUpdated(event.data.object, connectedAccountId);
        break;
      case 'invoice.paid':
      case 'invoice.voided':
        // Acknowledged and ignored. Invoice payments are collected through a
        // checkout session opened from the payment link, never a hosted Stripe
        // invoice. The Stripe invoices that still reach this endpoint (the trust
        // ACH fee invoices `chargeAccruedTrustFee` creates, and subscription
        // invoices when the dashboard subscribes this endpoint to them) are not
        // ours to process here; refusing one would make Stripe retry for days.
        break;
      case 'account.updated':
        await stripeService.handleAccountUpdated(event.data.object);
        break;
      default:
        break;
    }
  } catch (err: any) {
    console.error('Stripe webhook processing failed:', {
      ...buildWebhookLogContext(event),
      error: err.message,
      code: err.code || null,
    });
    // Release the idempotency claim so Stripe's retry can re-process.
    await stripeService.releaseStripeEvent(event.id, 'payments', claim.claimToken);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  await stripeService.finishStripeEvent(event.id, 'payments', claim.claimToken);
  res.json({ received: true });
});

export = router;
