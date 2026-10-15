const express = require('express');
const { optionalTimezone } = require('../../../shared/middleware/timezone');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { createPlanSchema, updatePlanSchema } = require('./plans.validation');
const plansService = require('./plans.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/billing/plans
router.get('/',
  verifyToken,
  requirePermission('billing.viewPlans'),
  handler(async (req) => plansService.listPlans({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    includePeriods: true,
    relatedClientId: req.query.relatedClientId,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/plans
router.post('/',
  verifyToken,
  requirePermission('billing.managePlans'),
  validate(createPlanSchema),
  handler(async (req) => plansService.createPlan({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/billing/plans/:planId
router.put('/:planId',
  verifyToken,
  requirePermission('billing.managePlans'),
  validate(updatePlanSchema),
  handler(async (req) => plansService.updatePlan({
    lawFirmId: req.params.lawFirmId,
    planId: req.params.planId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/plans/:planId/periods/:periodId/create-draft
router.post('/:planId/periods/:periodId/create-draft',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  optionalTimezone,
  handler(async (req) => plansService.createDraftFromPeriod({
    timeZone: req.tz,
    lawFirmId: req.params.lawFirmId,
    planId: req.params.planId,
    periodId: req.params.periodId,
    actingUserId: req.user.uid,
  }), 201),
);

export = router;
