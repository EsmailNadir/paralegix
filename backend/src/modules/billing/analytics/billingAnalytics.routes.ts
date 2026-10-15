const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const analyticsService = require('./billingAnalytics.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/billing/analytics/billing-summary
router.get('/billing-summary',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  requireTimezone,
  handler(async (req) => analyticsService.getBillingSummary({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    timezone: req.tz,
  })),
);

export = router;
