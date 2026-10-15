const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { listNotificationsSchema, notificationIdSchema } = require('./notifications.validation');
const notificationsService = require('./notifications.service');
import { handler } from '../../shared/http/handler';

// Defense in depth: confirm the caller belongs to the firm before any handler
// runs, so authorization never rests solely on the repository's per-user query
// scoping. Any firm member may read/act on their own notifications, so firm
// membership (not a specific permission) is the correct gate here.
async function requireFirmMembership(req: any, res: any, next: any) {
  await assertLawFirmMembership(req.params.lawFirmId, req.user.uid);
  next();
}

// GET /api/lawfirms/:lawFirmId/notifications (List notifications, paginated via ?before=)
router.get('/',
  verifyToken,
  requireFirmMembership,
  validate(listNotificationsSchema),
  handler(async (req) => notificationsService.listNotifications({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    unreadOnly: req.query.unreadOnly,
    types: req.query.types,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    before: req.query.before,
    beforeId: req.query.beforeId,
  }))
);

// GET /api/lawfirms/:lawFirmId/notifications/count (Unread count)
router.get('/count',
  verifyToken,
  requireFirmMembership,
  handler(async (req) => notificationsService.getUnreadCount({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/notifications/feed (List + unread count in one call)
router.get('/feed',
  verifyToken,
  requireFirmMembership,
  validate(listNotificationsSchema),
  handler(async (req) => notificationsService.getFeed({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    unreadOnly: req.query.unreadOnly,
    types: req.query.types,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
  }))
);

// POST /api/lawfirms/:lawFirmId/notifications/mark-all-read (Mark all read)
router.post('/mark-all-read',
  verifyToken,
  requireFirmMembership,
  handler(async (req) => notificationsService.markAllRead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/notifications/:notificationId/read (Mark single read)
router.post('/:notificationId/read',
  verifyToken,
  requireFirmMembership,
  validate(notificationIdSchema),
  handler(async (req) => notificationsService.markRead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    notificationId: req.params.notificationId,
  }))
);

// POST /api/lawfirms/:lawFirmId/notifications/:notificationId/unread (Mark single unread)
router.post('/:notificationId/unread',
  verifyToken,
  requireFirmMembership,
  validate(notificationIdSchema),
  handler(async (req) => notificationsService.markUnread({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    notificationId: req.params.notificationId,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/notifications/:notificationId (Delete a notification)
router.delete('/:notificationId',
  verifyToken,
  requireFirmMembership,
  validate(notificationIdSchema),
  handler(async (req) => notificationsService.remove({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    notificationId: req.params.notificationId,
  }))
);

export = router;
