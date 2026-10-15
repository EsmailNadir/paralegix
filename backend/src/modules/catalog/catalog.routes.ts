const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  searchCourtsSchema,
  listUtbmsSchema,
  adoptCourtsSchema,
  adoptUtbmsSchema,
} = require('./catalog.validation');
const catalogService = require('./catalog.service');
import { handler } from '../../shared/http/handler';

// The catalog data is global, but it's mounted under the firm scope so it reuses
// the firm auth/membership middleware; adoption is inherently firm-scoped.

// GET /api/lawfirms/:lawFirmId/catalog/courts
router.get('/courts',
  verifyToken,
  requirePermission('courts.manage'),
  validate(searchCourtsSchema),
  handler(async (req) => catalogService.searchCourts({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    search: req.query.search,
    state: req.query.state,
    courtType: req.query.courtType,
    jurisdiction: req.query.jurisdiction,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// POST /api/lawfirms/:lawFirmId/catalog/courts/adopt
router.post('/courts/adopt',
  verifyToken,
  requirePermission('courts.manage'),
  validate(adoptCourtsSchema),
  handler(async (req) => catalogService.adoptCourts({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    catalogCourtIds: req.body.catalogCourtIds,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/catalog/utbms
router.get('/utbms',
  verifyToken,
  requirePermission('billing.viewRates'),
  validate(listUtbmsSchema),
  handler(async (req) => catalogService.listUtbmsCodes({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    codeType: req.query.codeType,
    practiceSet: req.query.practiceSet,
  })),
);

// POST /api/lawfirms/:lawFirmId/catalog/charge-codes/adopt
router.post('/charge-codes/adopt',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(adoptUtbmsSchema),
  handler(async (req) => catalogService.adoptChargeCodes({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    utbmsCodeIds: req.body.utbmsCodeIds,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/catalog/expense-categories/adopt
router.post('/expense-categories/adopt',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(adoptUtbmsSchema),
  handler(async (req) => catalogService.adoptExpenseCategories({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    utbmsCodeIds: req.body.utbmsCodeIds,
  }), 201),
);

export = router;
