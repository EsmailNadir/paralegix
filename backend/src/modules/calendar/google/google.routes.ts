import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../../shared/http/handler';
import { handler } from '../../../shared/http/handler';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../shared/middleware/auth');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { ValidationError } = require('../../../shared/errors/AppError');
const calendarSyncRepo = require('../shared/calendarSync.repository');
const {
  requireSyncPerm,
  requireSyncPermFromItems,
  requireCalendarSync,
  requireCalendarSyncFromItems,
} = require('../shared/calendarSyncGates');
const googleService = require('./google.service');

/**
 * A 401 from this module means the user's GOOGLE grant needs reconnecting, not
 * that their Paralegix session expired. Without a discriminating code the two
 * are indistinguishable to the browser, whose generic 401 handling refreshes the
 * Firebase token, retries, and then reloads the page — none of which can restore
 * a revoked Google grant, so background sync would reload the page on a loop.
 * This code tells the client to raise the reconnect prompt instead.
 */
const GOOGLE_REAUTH_CODE = 'GOOGLE_REAUTH_REQUIRED';

/** Answer a failed Google-sync call, tagging 401s as a Google re-auth prompt. */
function sendGoogleError(res: any, status: number, message: string) {
  const body: any = { error: message };
  if (status === 401) {
    body.code = GOOGLE_REAUTH_CODE;
    body.requiresReAuth = true;
  }
  return res.status(status).json(body);
}

/**
 * A revoked/invalid Google refresh token throws with `.code === 'NO_REFRESH_TOKEN'`
 * and `.requiresReAuth === true` but no `.status` (see calendarHelpers' NO_REFRESH_TOKEN
 * path); treat that the same as an explicit 401 so the reconnect prompt fires
 * instead of a generic 500.
 *
 * Both status properties are read. The service throws `AppError`/`ValidationError`,
 * which carry `statusCode`; only legacy hand-rolled errors carry `status`. Reading
 * `status` alone collapsed every typed error the service raises into a 500: an
 * expired Google grant ("Google token expired or invalid", 401) never reached the
 * client as a 401, so the reconnect prompt above could not fire, and a plain
 * validation refusal ("Paralegix to Google sync not enabled", 400) was reported as a
 * server fault.
 */
function resolveGoogleErrorStatus(error: any): number {
  if (error.requiresReAuth || error.code === 'NO_REFRESH_TOKEN') return 401;
  return error.status || error.statusCode || 500;
}

// GET /api/google-calendar-sync/check-auth
router.get('/check-auth', verifyToken, handler(async (req, res) => {
  const result = await googleService.checkAuth(req.user.uid);
  if (result.error) return sendGoogleError(res, result.status, result.error);
  res.json(result);
}));

// POST /api/google-calendar-sync/init-paralegix-calendar
router.post('/init-paralegix-calendar', verifyToken, requireTimezone, handler(async (req, res) => {
  try {
    const result = await googleService.initParalegixCalendar(req.user.uid, req.tz);
    if (result.error) return sendGoogleError(res, result.status, result.error);
    res.json(result);
  } catch (error: any) {
    sendGoogleError(res, resolveGoogleErrorStatus(error), error.message || 'Failed to initialize Paralegix calendar');
  }
}));

// GET /api/google-calendar-sync/calendars
router.get('/calendars', verifyToken, handler(async (req, res) => {
  const result = await googleService.getCalendars(req.user.uid);
  if (result.error) return sendGoogleError(res, result.status, result.error);
  res.json(result);
}));

// POST /api/google-calendar-sync/sync-from-google
router.post('/sync-from-google', verifyToken, requireSyncPerm, requireCalendarSync, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId } = req.body;
    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) return next(new Error('lawFirmId is required'));

    await assertLawFirmMembership(lawFirmId, req.user.uid);

    const result = await googleService.syncFromGoogle({
      userId: req.user.uid,
      lawFirmId,
    });
    res.json(result);
  } catch (error: any) {
    sendGoogleError(res, resolveGoogleErrorStatus(error), error.message || 'Failed to sync from Google Calendar');
  }
});

// POST /api/google-calendar-sync/sync-tasks-to-google
router.post('/sync-tasks-to-google', verifyToken, requireSyncPermFromItems, requireCalendarSyncFromItems, requireTimezone, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { tasks } = req.body;
    if (!tasks || !Array.isArray(tasks)) return next(new ValidationError('Tasks array is required'));

    const result = await googleService.syncTasksToGoogle({
      userId: req.user.uid,
      tasks,
      timeZone: req.tz,
    });
    res.json(result);
  } catch (error: any) {
    sendGoogleError(res, resolveGoogleErrorStatus(error), error.message || 'Failed to sync tasks to Google Calendar');
  }
});

// POST /api/google-calendar-sync/sync-events-to-google
router.post('/sync-events-to-google', verifyToken, requireSyncPermFromItems, requireCalendarSyncFromItems, requireTimezone, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) return next(new ValidationError('Events array is required'));

    const result = await googleService.syncEventsToGoogle({
      userId: req.user.uid,
      events,
      timeZone: req.tz,
    });
    res.json(result);
  } catch (error: any) {
    sendGoogleError(res, resolveGoogleErrorStatus(error), error.message || 'Failed to sync events to Google Calendar');
  }
});

// POST /api/google-calendar-sync/enable-silent-sync
router.post('/enable-silent-sync', verifyToken, requireSyncPerm, requireCalendarSync, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId } = req.body;
    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) return next(new Error('lawFirmId is required'));

    await assertLawFirmMembership(lawFirmId, req.user.uid);

    const oldChannels = await calendarSyncRepo.listWatchChannelsForUser(req.user.uid);
    const result = await googleService.createWatchChannel({
      userId: req.user.uid,
      lawFirmId,
    });

    if (!result) {
      return res.status(500).json({ error: 'Failed to enable silent sync. Check Google connection.' });
    }

    for (const channel of oldChannels) await googleService.stopWatchChannel(channel.id);
    await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: req.user.uid, lawFirmId, changeType: 'catch_up', eventId: 'reconnect', pending: true });
    res.json({ success: true, message: 'Silent sync enabled', expiration: result.expiration });
  } catch (error: any) {
    sendGoogleError(res, resolveGoogleErrorStatus(error), error.message || 'Failed to enable silent sync');
  }
});

// POST /api/google-calendar-sync/disable-silent-sync
router.post('/disable-silent-sync', verifyToken, handler(async (req, res) => {
    await googleService.stopAllWatchChannels(req.user.uid);
    res.json({ success: true, message: 'Silent sync disabled' });
  }));

// GET /api/google-calendar-sync/silent-sync-status
router.get('/silent-sync-status', verifyToken, handler(async (req, res) => {
    const channel = await calendarSyncRepo.findWatchChannelForUser(req.user.uid);

    if (!channel) {
      return res.json({ enabled: false });
    }

    res.json({
      enabled: true,
      expiration: channel.expiration ? new Date(channel.expiration).toISOString() : null,
    });
  }));

export = router;
