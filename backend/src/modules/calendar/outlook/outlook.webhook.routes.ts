import type { Response } from 'express';
import type { AuthedRequest } from '../../../shared/http/handler';
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const calendarSyncRepo = require('../shared/calendarSync.repository');
const calendarTokens = require('../shared/calendarTokens');
const outlookService = require('./outlook.service');

// Constant-time comparison of the stored/received clientState so a mismatch can't
// be probed byte-by-byte via response timing. Mirrors the Google webhook check.
function clientStatesMatch(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * POST /api/webhooks/outlook-calendar
 *
 * Receives push notifications from Microsoft Graph Subscriptions.
 *
 * Two modes:
 * 1. Validation: Microsoft sends ?validationToken=<token>. We must echo it back as plain text.
 * 2. Notification: Microsoft POSTs JSON with req.body.value[] containing change notifications.
 *
 * No auth middleware. Microsoft cannot send our bearer tokens.
 * Verification is done via the clientState field.
 */
router.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    // Validation handshake. Microsoft sends this when creating a subscription
    const validationToken = req.query.validationToken;
    if (validationToken) {
      return res.status(200).contentType('text/plain').send(validationToken);
    }

    const notifications = req.body?.value;
    if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
      return res.status(200).end();
    }

    // C3: dedupe notifications within the batch by (subscriptionId, eventId,
    // changeType). Microsoft can deliver the same change more than once in a
    // single POST; processing each copy re-runs 3-4 lookups + a cross-sync push.
    const seen = new Set();
    const deduped = [];
    for (const notification of notifications) {
      const { subscriptionId, changeType, resource, resourceData, lifecycleEvent } = notification || {};
      if (!subscriptionId) continue;
      const eventId = resourceData?.id || resource?.split('/')?.pop() || '';
      const key = `${subscriptionId}:${eventId}:${changeType}:${lifecycleEvent || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(notification);
    }

    // C3: per-batch caches. Resolve each subscription and each user's
    // tokens/settings at most once across the whole batch.
    const subCache = new Map();   // subscriptionId -> subData
    const tokenCache = new Map(); // userId -> Promise<{ userData, settings }>
    const repointed = new Map<string, boolean>(); // subscriptionId -> moved off a stale calendar

    for (const notification of deduped) {
      try {
        const { subscriptionId, changeType, resource, resourceData, clientState } = notification;
        if (!subscriptionId) continue;

        // Look up the subscription to find the user (cached per batch).
        if (!subCache.has(subscriptionId)) {
          subCache.set(subscriptionId, await calendarSyncRepo.getSubscription(subscriptionId));
        }
        const subData = subCache.get(subscriptionId);
        if (!subData) {
          console.warn('outlook.webhook: unknown subscription ID:', subscriptionId);
          continue;
        }

        // Verify clientState. Every subscription we create carries a random
        // clientState, so a stored value MUST be present AND match; a missing or
        // mismatched value means the delivery is unverified and is dropped. (The
        // previous check skipped verification entirely when the stored value was
        // falsy, processing spoofable notifications unconditionally.)
        if (!clientStatesMatch(subData.clientState, clientState)) {
          console.warn('outlook.webhook: clientState mismatch for subscription:', subscriptionId);
          continue;
        }
        // Graph can deliver lifecycle events here too. One carries no change to
        // fetch, so it goes to the lifecycle handler and never into the change
        // retry queue; a failure there is logged like on the lifecycle route.
        if (notification.lifecycleEvent) {
          await outlookService.handleSubscriptionLifecycleEvent(subData, notification.lifecycleEvent).catch((err: any) => {
            console.error(`outlook.webhook: lifecycle ${notification.lifecycleEvent} for subscription ${subscriptionId} failed:`, err?.message || err);
          });
          continue;
        }
        // Keep a replayable event before beginning any provider work.
        const queued = await calendarSyncRepo.recordWebhookFailure({
          provider: 'outlook', userId: subData.userId, lawFirmId: subData.lawFirmId, pending: true,
          changeType, eventId: resourceData?.id || resource?.split('/')?.pop() || null, resource,
        });

        // No "we just pushed to this calendar" skip for `updated`. It used to
        // drop every update for 90 s after any push, and Graph notifies once
        // per change, so a real edit to an unrelated event was lost until the
        // next poll. Our own echo is recognised per item inside the inbound
        // chain (the mapping's pushed version and modified time, and
        // last-writer-wins).

        if (!tokenCache.has(subData.userId)) {
          tokenCache.set(subData.userId, calendarTokens.getUserDataAndSettings(subData.userId).catch(() => null));
        }
        const preloaded = await tokenCache.get(subData.userId);

        // A subscription still on the calendar the user no longer targets is
        // moved and caught up once; its notifications, which came from that
        // calendar, are then dropped.
        if (!repointed.has(subscriptionId)) {
          repointed.set(subscriptionId, await outlookService.repointStaleSubscription(subData, preloaded || undefined));
        }
        if (repointed.get(subscriptionId)) {
          await calendarSyncRepo.resolveWebhookFailure(queued.dedupeKey, queued.leaseToken);
          continue;
        }

        await outlookService.processSubscriptionNotification({
          userId: subData.userId,
          lawFirmId: subData.lawFirmId,
          changeType,
          resource,
          resourceData,
          preloaded: preloaded || undefined,
        });
        await calendarSyncRepo.resolveWebhookFailure(queued.dedupeKey, queued.leaseToken);
      } catch (notifErr) {
        console.error('outlook.webhook: error processing notification:', notifErr);
        // Persist a durable retry instead of dropping the change. The retry
        // re-fetches the event by id (idempotent). Coalesced per (provider,user).
        const { subscriptionId, changeType, resource, resourceData } = notification || {};
        const subData = subscriptionId ? subCache.get(subscriptionId) : null;
        if (subData?.userId) {
          await calendarSyncRepo.recordWebhookFailure({
            provider: 'outlook',
            userId: subData.userId,
            lawFirmId: subData.lawFirmId,
            changeType,
            eventId: resourceData?.id || resource?.split('/')?.pop() || null,
            resource,
            error: notifErr,
          });
        }
      }
    }
    res.status(202).end();
  } catch (error) {
    console.error('outlook.webhook: error:', error);
    if (!res.headersSent) res.status(503).end();
  }
});

/**
 * POST /api/webhooks/outlook-calendar/lifecycle
 *
 * Receives Graph lifecycle notifications, the `lifecycleNotificationUrl` every
 * subscription is created with. Same two modes and the same gate as the change
 * route above: a `validationToken` handshake echoed as plain text, then
 * `value[]` items whose `clientState` must match the stored one. Each verified
 * item carries `lifecycleEvent` (reauthorizationRequired, subscriptionRemoved
 * or missed), handled by `handleSubscriptionLifecycleEvent`.
 *
 * No auth middleware. Microsoft cannot send our bearer tokens.
 */
router.post('/lifecycle', async (req: AuthedRequest, res: Response) => {
  const validationToken = req.query.validationToken;
  if (validationToken) {
    return res.status(200).contentType('text/plain').send(validationToken);
  }

  const notifications = Array.isArray(req.body?.value) ? req.body.value : [];
  // One action per subscription and event, however many copies the batch holds.
  const seen = new Set<string>();
  for (const notification of notifications) {
    const { subscriptionId, clientState, lifecycleEvent } = notification || {};
    if (!subscriptionId || !lifecycleEvent) continue;
    const key = `${subscriptionId}:${lifecycleEvent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const subData = await calendarSyncRepo.getSubscription(subscriptionId);
      if (!subData) {
        console.warn('outlook.webhook: lifecycle event for unknown subscription ID:', subscriptionId);
        continue;
      }
      if (!clientStatesMatch(subData.clientState, clientState)) {
        console.warn('outlook.webhook: lifecycle clientState mismatch for subscription:', subscriptionId);
        continue;
      }
      await outlookService.handleSubscriptionLifecycleEvent(subData, lifecycleEvent);
    } catch (err: any) {
      // The renewal cron still reaches a subscription inside its last 24 hours,
      // so one failure here delays recovery rather than ending it.
      console.error(`outlook.webhook: lifecycle ${lifecycleEvent} for subscription ${subscriptionId} failed:`, err?.message || err);
    }
  }
  res.status(202).end();
});

export = router;
