import { handler } from '../../shared/http/handler';
const express = require('express');
const { verifyToken } = require('../../shared/middleware/auth');
const { requireTimezone } = require('../../shared/middleware/timezone');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { resolveCalendarRange } = require('../../shared/utils/calendarRange');
const { listExternalEventsSchema } = require('./calendarEvents.validation');
const calendarEventsService = require('./calendarEvents.service');
const { recordOutboundWork } = require('./shared/calendarSync.repository');
const { dispatchOutboundWork } = require('./shared/calendarOutboundRetry');
const { AppError, ForbiddenError } = require('../../shared/errors/AppError');

const router = express.Router({ mergeParams: true });

// GET /api/lawfirms/:lawFirmId/calendar-events
router.get('/', verifyToken, requirePermission('calendar.view'), validate(listExternalEventsSchema), requireTimezone, handler(async (req, res) => {
  const { lawFirmId } = req.params;
  const userId = req.user?.uid;
  // `req.tz` is the validated zone requireTimezone resolved from ?tz / the
  // X-Timezone header. The window and the display values are derived from the
  // same zone so they can never disagree about which day an event falls on.
  const timezone = req.tz;
  const result = await calendarEventsService.listExternalCalendarEvents({
    lawFirmId,
    userId,
    timezone,
    range: resolveCalendarRange({ from: req.query.from, to: req.query.to, timezone }),
  });
  res.json(result);
}));

// PUT /api/lawfirms/:lawFirmId/calendar-events/:eventId
router.put('/:eventId', verifyToken, requirePermission('calendar.sync'), requireTimezone, handler(async (req, res) => {
  const { lawFirmId, eventId } = req.params;
  const userId = req.user?.uid;
  const timezone = req.tz;
  const updates = req.body || {};

  const result = await calendarEventsService.updateExternalCalendarEvent({
    lawFirmId,
    userId,
    eventId,
    updates: {
      title: updates.title,
      notes: updates.notes,
      location: updates.location,
      start: updates.start,
      end: updates.end,
      allDay: updates.allDay,
      confirmNotifyAttendees: updates.confirmNotifyAttendees,
      timezone,
    },
  });

  const entityData = { ...result.event, lawFirmId, confirmNotifyAttendees: updates.confirmNotifyAttendees === true };
  const queuedWrites = [];
  for (const provider of ['google', 'outlook']) {
    if (!entityData[provider === 'google' ? 'googleEventId' : 'outlookId']) continue;
    const queued = await recordOutboundWork({ provider, userId, entityType: 'externalEvent', entityData, action: 'updateEventsFromEntity', timeZone: timezone });
    queuedWrites.push(queued);
  }
  let failed = false;
  for (const queued of queuedWrites) {
    try { await dispatchOutboundWork(queued.dedupeKey); }
    catch { failed = true; }
  }
  if (failed) throw new AppError('The event was saved. Calendar sync failed and will be retried.', 503);

  res.json({ message: 'Event updated', event: result.event });
}));

// DELETE /api/lawfirms/:lawFirmId/calendar-events/:eventId
router.delete('/:eventId', verifyToken, requirePermission('calendar.sync'), requireTimezone, handler(async (req, res) => {
  const { lawFirmId, eventId } = req.params;
  const userId = req.user?.uid;
  const timezone = req.tz;

  // C9: locate the one event via an indexed findById instead of listing every
  // external event for the firm just to find one by id.
  const target = await calendarEventsService.getExternalCalendarEvent({
    lawFirmId,
    userId,
    eventId,
    timezone,
  });

  if (target) {
    if (target.meeting?.attendees?.length && !target.meeting.isOrganizer) {
      throw new ForbiddenError('Open this meeting in Google or Outlook to make changes.');
    }
    const entityData = { ...target, lawFirmId };
    const queuedDeletes = [];
    for (const provider of ['google', 'outlook']) {
      if (!entityData[provider === 'google' ? 'googleEventId' : 'outlookId']) continue;
      const queued = await recordOutboundWork({ provider, userId, entityType: 'externalEvent', entityData, action: 'deleteEventsFromEntity', timeZone: timezone });
      queuedDeletes.push(queued);
    }
    let failed = false;
    for (const queued of queuedDeletes) {
      try { await dispatchOutboundWork(queued.dedupeKey); }
      catch { failed = true; }
    }
    if (failed) throw new AppError('Calendar deletion failed and will be retried.', 503);
  }

  const result = await calendarEventsService.deleteExternalCalendarEvent({ lawFirmId, userId, eventId });
  res.json(result);
}));

export = router;
