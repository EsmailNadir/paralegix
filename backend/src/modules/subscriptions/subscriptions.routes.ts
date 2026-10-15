const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { validate } = require('../../shared/middleware/validate');
const subscriptionService = require('./subscriptions.service');
import { handler } from '../../shared/http/handler';
const {
  createCheckoutSchema,
  changePlanSchema,
  cancelSchema,
  reactivateSchema,
  portalSchema,
} = require('./subscriptions.validation');

// All routes require auth
router.use(verifyToken);

// POST /api/lawfirms/:lawFirmId/subscriptions/checkout
router.post('/checkout',
  requirePermission('settings.manageFirm'),
  validate(createCheckoutSchema),
  handler(async (req) => subscriptionService.createCheckoutSession({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    planId: req.body.planId,
    interval: req.body.interval,
  }))
);

// POST /api/lawfirms/:lawFirmId/subscriptions/portal
router.post('/portal',
  requirePermission('settings.manageFirm'),
  validate(portalSchema),
  handler(async (req) => subscriptionService.createPortalSession({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/subscriptions/status
router.get('/status',
  requirePermission('members.view'),
  handler(async (req) => subscriptionService.getSubscriptionStatus({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/subscriptions/change-plan
router.post('/change-plan',
  requirePermission('settings.manageFirm'),
  validate(changePlanSchema),
  handler(async (req) => subscriptionService.changePlan({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    planId: req.body.planId,
    interval: req.body.interval,
  }))
);

// POST /api/lawfirms/:lawFirmId/subscriptions/cancel
router.post('/cancel',
  requirePermission('settings.manageFirm'),
  validate(cancelSchema),
  handler(async (req) => subscriptionService.cancelSubscription({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/subscriptions/reactivate
router.post('/reactivate',
  requirePermission('settings.manageFirm'),
  validate(reactivateSchema),
  handler(async (req) => subscriptionService.reactivateSubscription({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

export = router;
