import type { Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const router = express.Router();
const stripe = require('../stripe/stripe.config');
const stripeService = require('../stripe/stripe.service');
const subscriptionService = require('./subscriptions.service');

// POST /api/webhooks/stripe-subscriptions
// Receives raw body. Must be mounted before express.json() in app.js
router.post('/', async (req: AuthedRequest, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET,
    );
  } catch (err: any) {
    console.error('Subscription webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  // Idempotency gate (mirrors the payment webhook): claim the event id in this
  // endpoint's own ledger before processing, so a Stripe retry or replayed event
  // can't re-apply a stale plan / billing-status write. The ledger is per
  // endpoint because the payments webhook also receives invoice.paid under the
  // same event id. A finished event acks 200 as a duplicate; one still being
  // processed by another delivery gets a 409 so Stripe retries it later; a
  // failed claim 500s so Stripe retries rather than processing unguarded.
  let claim;
  try {
    claim = await stripeService.claimStripeEvent(event.id, 'subscriptions');
  } catch (err: any) {
    console.error('Subscription webhook idempotency claim failed:', {
      eventId: event.id,
      eventType: event.type,
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
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await subscriptionService.handleSubscriptionChange(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await subscriptionService.handleSubscriptionDeleted(event.data.object);
        break;

      case 'customer.subscription.trial_will_end':
        await subscriptionService.handleTrialEnding(event.data.object);
        break;

      case 'invoice.paid':
        // Only handle subscription invoices (not one-off)
        if (subscriptionService.subscriptionIdFromInvoice(event.data.object)) {
          await subscriptionService.handleSubscriptionInvoicePaid(event.data.object);
        }
        break;

      case 'invoice.payment_failed':
        if (subscriptionService.subscriptionIdFromInvoice(event.data.object)) {
          await subscriptionService.handlePaymentFailed(event.data.object);
        }
        break;

      default:
        break;
    }
  } catch (err: any) {
    console.error('Subscription webhook processing failed:', {
      eventType: event.type,
      eventId: event.id,
      error: err.message,
    });
    // Release the idempotency claim so Stripe's retry can re-process this event.
    await stripeService.releaseStripeEvent(event.id, 'subscriptions', claim.claimToken);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  await stripeService.finishStripeEvent(event.id, 'subscriptions', claim.claimToken);
  res.json({ received: true });
});

export = router;
