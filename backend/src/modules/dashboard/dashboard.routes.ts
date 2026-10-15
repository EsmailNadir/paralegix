const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { requireTimezone } = require('../../shared/middleware/timezone');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const dashboardService = require('./dashboard.service');
const { loadFirmPlanForRequest } = require('../../shared/plans/planEnforcement');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/dashboard-summary
//
// Single aggregate endpoint that returns every dashboard widget's data in one
// round trip (stat-card counts computed in SQL, plus top-N recent matters /
// upcoming tasks / my-assignments / recent conversations). Replaces the ~9-11
// individual GETs the dashboard page used to fire.
//
// Gated on `dashboard.view`; `requirePermission` also attaches `req.member`
// (with resolvedPermissions / isOwner), which the service uses to additionally
// scope each section by the member's matters/tasks/messaging/members/signatures
// view permissions so nothing leaks beyond what the individual endpoints show.
//
// Time-aware (due dates are formatted for the client's timezone), so the
// standard chain includes requireTimezone.
router.get('/',
  verifyToken,
  requirePermission('dashboard.view'),
  requireTimezone,
  handler(async (req) => dashboardService.getDashboardSummary({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    member: req.member,
    timezone: req.tz,
    getFirmPlan: () => loadFirmPlanForRequest(req, req.params.lawFirmId),
  })),
);

export = router;
