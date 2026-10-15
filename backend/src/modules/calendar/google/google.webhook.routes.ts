import type { Response } from 'express';
import type { AuthedRequest } from '../../../shared/http/handler';
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const calendarSyncRepo = require('../shared/calendarSync.repository');
const googleService = require('./google.service');

// Constant-time comparison of the channel token so a mismatch can't be probed
// byte-by-byte via response timing.
function tokensMatch(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * POST /api/webhooks/google-calendar
 *
 * Receives push notifications from Google Calendar Watch API.
 * Google sends headers (not a JSON body) to indicate a change:
 *   X-Goog-Channel-ID      our channel ID (maps to a user)
 *   X-Goog-Resource-State   "sync" (initial handshake) or "exists" (change occurred)
 *   X-Goog-Channel-Token    verification token we set when creating the channel
 *
 * No auth middleware. Google cannot send our bearer tokens.
 * Verification is done via the channel token.
 */
router.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    const channelToken = req.headers['x-goog-channel-token'];

    if (!channelId) {
      return res.status(400).end();
    }

    // Google sends a "sync" notification when the channel is first created. Just acknowledge it
    if (resourceState === 'sync') {
      return res.status(200).end();
    }

    // Look up the watch channel to find the user
    const channelData = await calendarSyncRepo.getWatchChannel(channelId);
    if (!channelData) {
      // Never synced. One whose earlier stop failed is still live at Google,
      // and this delivery is the chance to stop it.
      const resourceId = req.headers['x-goog-resource-id'];
      if (typeof channelId === 'string' && typeof resourceId === 'string') {
        await googleService.stopLingeringChannel({ channelId, resourceId }).catch((err: any) => {
          console.error('google.webhook: could not stop lingering channel', channelId, err?.message || err);
        });
      }
      console.warn('google.webhook: unknown channel ID:', channelId);
      return res.status(200).end(); // return 200 so Google doesn't retry
    }

    // Verify the channel token (constant-time)
    if (!tokensMatch(channelData.token, channelToken)) {
      console.warn('google.webhook: token mismatch for channel:', channelId);
      return res.status(200).end();
    }

    // Persist before processing or acknowledging. If the instance stops during
    // the provider calls, the cron can replay the unchanged cursor.
    const queued = await calendarSyncRepo.recordWebhookFailure({
      provider: 'google', userId: channelData.userId, lawFirmId: channelData.lawFirmId, pending: true,
    });

    // No "we just pushed to this calendar" skip here. It used to drop every
    // notification for 90 s after any push, which held back real edits to
    // unrelated events. Our own echo is recognised per item instead, inside
    // the inbound chain (the mapping's pushed version and modified time, and
    // last-writer-wins), and reading the delta for it costs one small request.

    // Run incremental sync for this user. On failure, persist a durable retry
    // work item instead of dropping the change. A sweep on the calendar-watch
    // cron re-runs the (idempotent) incremental sync with exponential backoff.
    try {
      await googleService.processWatchNotification({
        userId: channelData.userId,
        lawFirmId: channelData.lawFirmId,
      });
      await calendarSyncRepo.resolveWebhookFailure(queued.dedupeKey, queued.leaseToken);
    } catch (syncErr: any) {
      console.error('google.webhook: processWatchNotification failed; queuing retry:', syncErr.message || syncErr);
      await calendarSyncRepo.recordWebhookFailure({
        provider: 'google',
        userId: channelData.userId,
        lawFirmId: channelData.lawFirmId,
        // When a specific inbound DELETE failed, carry its event id so the retry can
        // replay processInboundDelete directly (syncFromGoogle can't recover a
        // deletion). Absent for create/update failures, which the re-sync recovers.
        changeType: syncErr?.failedDeleteEventId ? 'deleted' : null,
        eventId: syncErr?.failedDeleteEventId || null,
        error: syncErr,
      }).catch((e: any) => console.error('google.webhook: failed to record retry:', e));
    }
    res.status(200).end();
  } catch (error) {
    console.error('google.webhook: error processing notification:', error);
    // An unpersisted delivery needs a provider retry.
    if (!res.headersSent) res.status(503).end();
  }
});

export = router;
