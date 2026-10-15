const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../../shared/middleware/rateLimiters');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createFlatFeeSchema,
  updateFlatFeeSchema,
  listFirmFlatFeesSchema,
} = require('./flatFees.validation');
const flatFeesService = require('./flatFees.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/billing/flat-fees/firm
// The firm-wide read, so a screen holding many matters asks once instead of once
// per matter. Filters are optional; the row window never is. An omitted `limit`
// is served at MAX_PAGE_SIZE with `truncated` set, a `limit` above it is a 400,
// and `countOnly=true` returns `totalItems` and `summary` with no rows.
// Registered first so `/firm` can never be read as a context segment.
// Not time-aware: a flat fee's date is a day-only value the client renders as
// written, so there is no timezone to resolve it against.
router.get('/firm',
  verifyToken,
  heavyReadLimiter,
  requirePermission('billing.viewInvoices'),
  validate(listFirmFlatFeesSchema),
  handler(async (req) => flatFeesService.listFirmFlatFees({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
    matterIds: req.query.matterIds,
    clientId: req.query.clientId,
    context: req.query.context,
    billingStatus: req.query.billingStatus,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    countOnly: req.query.countOnly === 'true',
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId
router.get('/matter/:matterId',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => flatFeesService.listFlatFees({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
    unbilledOnly: req.query.unbilledOnly === 'true',
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/flat-fees
router.post('/',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(createFlatFeeSchema),
  handler(async (req) => flatFeesService.createFlatFee({
    lawFirmId: req.params.lawFirmId,
    matterId: req.body.matterId,
    clientId: req.body.clientId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/billing/flat-fees/client/:clientId
router.get('/client/:clientId',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => flatFeesService.listFlatFees({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
    unbilledOnly: req.query.unbilledOnly === 'true',
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId/:flatFeeId
router.put('/matter/:matterId/:flatFeeId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateFlatFeeSchema),
  handler(async (req) => flatFeesService.updateFlatFee({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    flatFeeId: req.params.flatFeeId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/flat-fees/client/:clientId/:flatFeeId
router.put('/client/:clientId/:flatFeeId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateFlatFeeSchema),
  handler(async (req) => flatFeesService.updateFlatFee({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    flatFeeId: req.params.flatFeeId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/flat-fees/matter/:matterId/:flatFeeId
router.delete('/matter/:matterId/:flatFeeId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => flatFeesService.deleteFlatFee({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    flatFeeId: req.params.flatFeeId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/flat-fees/client/:clientId/:flatFeeId
router.delete('/client/:clientId/:flatFeeId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => flatFeesService.deleteFlatFee({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    flatFeeId: req.params.flatFeeId,
    actingUserId: req.user.uid,
  })),
);

export = router;
