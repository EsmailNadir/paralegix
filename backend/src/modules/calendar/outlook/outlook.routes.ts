import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../../shared/http/handler';
import { handler } from '../../../shared/http/handler';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../shared/middleware/auth');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { ValidationError } = require('../../../shared/errors/AppError');
const {
  requireSyncPerm,
  requireSyncPermFromItems,
  requireCalendarSync,
  requireCalendarSyncFromItems,
} = require('../shared/calendarSyncGates');
const outlookService = require('./outlook.service');

/**
 * Send a 401 with reauth instructions when Microsoft token can't be refreshed.
 *
 * Every 401 leaving this module carries a code. A 401 here is about the user's
 * MICROSOFT grant, never their Paralegix session, and the browser's generic 401
 * recovery (refresh the Firebase token, retry, then reload the page) cannot fix
 * a stale Microsoft grant — left uncoded it would reload the page on a loop
 * while background sync retried. `NO_REFRESH_TOKEN` means the grant is gone and
 * the user must reconnect; `MICROSOFT_REAUTH_REQUIRED` covers the rest, where a
 * token refresh may still succeed.
 */
function handleReAuthError(error: any, res: any, fallbackMessage: any) {
  if (error.code === 'NO_REFRESH_TOKEN' && error.requiresReAuth) {
    return res.status(401).json({
      error: 'Microsoft token expired. Please reconnect your Microsoft account.',
      code: 'NO_REFRESH_TOKEN',
      requiresReAuth: true,
    });
  }
  // Both status properties are read. The service throws `AppError`/`ValidationError`,
  // which carry `statusCode`; only legacy hand-rolled errors carry `status`. Reading
  // `status` alone collapsed every typed error the service raises into a 500: a grant
  // that survived a refresh but is still rejected ("Microsoft token expired and refresh
  // failed", 401) never reached the client as a 401, so the reconnect prompt above could
  // not fire and background sync retried a dead grant forever, and a plain validation
  // refusal ("Paralegix to Outlook sync not enabled", 400) was reported as a server fault.
  const status = error.status || error.statusCode || 500;
  sendOutlookError(res, status, error.message || fallbackMessage);
}

/** Answer a failed Outlook call, tagging 401s so the client can tell them apart from session expiry. */
function sendOutlookError(res: any, status: number, message: string) {
  const body: any = { error: message };
  if (status === 401) {
    body.code = 'MICROSOFT_REAUTH_REQUIRED';
    body.requiresReAuth = true;
  }
  return res.status(status).json(body);
}

// GET /api/outlook-calendar-sync/check-auth
router.get('/check-auth', verifyToken, handler(async (req, res) => {
  try {
    const result = await outlookService.checkAuth(req.user.uid);
    if (result.error) return sendOutlookError(res, result.status, result.error);
    res.json(result);
  } catch (err) {
    handleReAuthError(err, res, 'Failed to check Outlook authentication');
  }
}));

// POST /api/outlook-calendar-sync/init-paralegix-calendar
router.post('/init-paralegix-calendar', verifyToken, requireTimezone, handler(async (req, res) => {
  try {
    const result = await outlookService.initParalegixCalendar(req.user.uid, req.tz);
    if (result.error) return sendOutlookError(res, result.status, result.error);
    res.json(result);
  } catch (err) {
    handleReAuthError(err, res, 'Failed to initialize Paralegix calendar');
  }
}));

// GET /api/outlook-calendar-sync/calendars
router.get('/calendars', verifyToken, handler(async (req, res) => {
  try {
    const result = await outlookService.getCalendars(req.user.uid);
    if (result.error) return sendOutlookError(res, result.status, result.error);
    res.json(result);
  } catch (err) {
    handleReAuthError(err, res, 'Failed to fetch Outlook calendars');
  }
}));

// POST /api/outlook-calendar-sync/sync-from-outlook
router.post('/sync-from-outlook', verifyToken, requireSyncPerm, requireCalendarSync, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId } = req.body;
    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) return next(new Error('lawFirmId is required'));

    await assertLawFirmMembership(lawFirmId, req.user.uid);

    const result = await outlookService.syncFromOutlook({
      userId: req.user.uid,
      lawFirmId,
    });
    res.json(result);
  } catch (error) {
    handleReAuthError(error, res, 'Failed to sync from Outlook Calendar. Please try again.');
  }
});

// POST /api/outlook-calendar-sync/sync-tasks-to-outlook
router.post('/sync-tasks-to-outlook', verifyToken, requireSyncPermFromItems, requireCalendarSyncFromItems, requireTimezone, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { tasks } = req.body;
    if (!tasks || !Array.isArray(tasks)) return next(new ValidationError('Tasks array is required'));

    const result = await outlookService.syncTasksToOutlook({
      userId: req.user.uid,
      tasks,
      timeZone: req.tz,
    });
    res.json(result);
  } catch (error) {
    handleReAuthError(error, res, 'Failed to sync tasks to Outlook Calendar');
  }
});

// POST /api/outlook-calendar-sync/sync-events-to-outlook
router.post('/sync-events-to-outlook', verifyToken, requireSyncPermFromItems, requireCalendarSyncFromItems, requireTimezone, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) return next(new ValidationError('Events array is required'));

    const result = await outlookService.syncEventsToOutlook({
      userId: req.user.uid,
      events,
      timeZone: req.tz,
    });
    res.json(result);
  } catch (error) {
    handleReAuthError(error, res, 'Failed to sync events to Outlook Calendar');
  }
});

// POST /api/outlook-calendar-sync/enable-silent-sync
router.post('/enable-silent-sync', verifyToken, requireSyncPerm, requireCalendarSync, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId } = req.body;
    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) return next(new Error('lawFirmId is required'));
    await assertLawFirmMembership(lawFirmId, req.user.uid);

    // Tear down any existing subscription for this user before creating a new one.
    // Subscriptions are per-user (one provider calendar shared across the user's
    // firms), so a reconnect, a second firm enabling sync, or a double-clicked
    // request would otherwise accumulate duplicate subscriptions — doubling webhook
    // delivery and defeating the single-row bounce-stamp. Safe to collapse to one
    // now that inbound writeback resolves the firm from the event's mapping.
    await outlookService.stopAllSubscriptions(req.user.uid);

    const result = await outlookService.createSubscription({
      userId: req.user.uid,
      lawFirmId,
    });

    if (!result) {
      return res.status(500).json({ error: 'Failed to enable silent sync. Check Microsoft connection.' });
    }

    res.json({ success: true, message: 'Silent sync enabled', expirationDateTime: result.expirationDateTime });
  } catch (error) {
    handleReAuthError(error, res, 'Failed to enable silent sync');
  }
});

// POST /api/outlook-calendar-sync/disable-silent-sync
router.post('/disable-silent-sync', verifyToken, handler(async (req, res) => {
    await outlookService.stopAllSubscriptions(req.user.uid);
    res.json({ success: true, message: 'Silent sync disabled' });
  }));

export = router;
