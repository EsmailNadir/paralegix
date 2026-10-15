const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  byMatterReportSchema,
  byClientReportSchema,
  clientMatterBreakdownSchema,
} = require('./billingReports.validation');
const reportsService = require('./billingReports.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/billing/reports/by-matter
//
// One page of the by-matter roll-up. The row set is an aggregate over the firm's
// invoices and time entries, so both read permissions apply: the response states
// amounts billed and outstanding as well as hours logged.
router.get('/by-matter',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  requirePermission('billing.viewTimeEntries'),
  validate(byMatterReportSchema),
  handler(async (req) => reportsService.getByMatterReport({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    search: req.query.search,
    status: req.query.status,
    practiceArea: req.query.practiceArea,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/reports/by-client
//
// The same roll-up grouped by who the work is billed to. Both read permissions
// apply for the same reason as by-matter.
router.get('/by-client',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  requirePermission('billing.viewTimeEntries'),
  validate(byClientReportSchema),
  handler(async (req) => reportsService.getByClientReport({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/reports/by-client/:clientId/matters
//
// The per-matter breakdown behind a client card. Registered AFTER /by-client so
// the list route is not shadowed.
router.get('/by-client/:clientId/matters',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  requirePermission('billing.viewTimeEntries'),
  validate(clientMatterBreakdownSchema),
  handler(async (req) => reportsService.getClientMatterBreakdown({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    clientId: req.params.clientId,
  })),
);

export = router;
