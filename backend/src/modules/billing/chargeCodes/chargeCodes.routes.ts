const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createChargeCodeSchema,
  updateChargeCodeSchema,
  reorderChargeCodesSchema,
} = require('./chargeCodes.validation');
const chargeCodesService = require('./chargeCodes.service');
import { handler } from '../../../shared/http/handler';

// PUT /api/lawfirms/:lawFirmId/billing/charge-codes/reorder
// (must be before /:chargeCodeId to avoid route conflict)
router.put('/reorder',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(reorderChargeCodesSchema),
  handler(async (req) => chargeCodesService.reorderChargeCodes({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/charge-codes
router.get('/',
  verifyToken,
  requirePermission('billing.viewRates'),
  handler(async (req) => chargeCodesService.listChargeCodes({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    includeInactive: req.query.includeInactive === 'true',
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId
router.get('/:chargeCodeId',
  verifyToken,
  requirePermission('billing.viewRates'),
  handler(async (req) => chargeCodesService.getChargeCode({
    lawFirmId: req.params.lawFirmId,
    chargeCodeId: req.params.chargeCodeId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/charge-codes
router.post('/',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(createChargeCodeSchema),
  handler(async (req) => chargeCodesService.createChargeCode({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId
router.put('/:chargeCodeId',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(updateChargeCodeSchema),
  handler(async (req) => chargeCodesService.updateChargeCode({
    lawFirmId: req.params.lawFirmId,
    chargeCodeId: req.params.chargeCodeId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/charge-codes/:chargeCodeId
router.delete('/:chargeCodeId',
  verifyToken,
  requirePermission('billing.manageRates'),
  handler(async (req) => chargeCodesService.deleteChargeCode({
    lawFirmId: req.params.lawFirmId,
    chargeCodeId: req.params.chargeCodeId,
    actingUserId: req.user.uid,
  })),
);

export = router;
