import express from 'express';

import { verifyToken } from '../../shared/middleware/auth';
import { requireTimezone } from '../../shared/middleware/timezone';
import { validate } from '../../shared/middleware/validate';
import { handler } from '../../shared/http/handler';
import { requirePermission } from '../lawfirms/roles/requirePermission';
import { calendarFeedSchema } from './calendarFeed.validation';
import { CALENDAR_FEED_PERMISSIONS, getCalendarFeed } from './calendarFeed.service';

const router = express.Router({ mergeParams: true });

// GET /api/lawfirms/:lawFirmId/calendar-feed?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Zone
//
// Everything the calendar draws for one window, as
// `{ matterEvents, clientEvents, calendarEvents, tasks, paymentDates }`, each the
// body its standalone endpoint answers. The gate admits a member holding ANY of
// the five section codes (a non-member is refused as every standalone read
// refuses one); the service then answers null for each section whose own code
// the member lacks.
router.get('/',
  verifyToken,
  requirePermission(CALENDAR_FEED_PERMISSIONS),
  validate(calendarFeedSchema),
  requireTimezone,
  handler(async (req) => getCalendarFeed({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    member: req.member,
    timezone: req.tz as string,
    from: String(req.query.from),
    to: String(req.query.to),
  })),
);

export = router;
