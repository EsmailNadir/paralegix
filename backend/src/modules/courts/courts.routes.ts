const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  createCourtSchema,
  updateCourtSchema,
} = require('./courts.validation');
const courtsService = require('./courts.service');
import { handler } from '../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/courts
router.post('/',
  verifyToken,
  requirePermission('courts.manage'),
  validate(createCourtSchema),
  handler(async (req) => courtsService.createCourt({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/courts
router.get('/',
  verifyToken,
  requirePermission('courts.manage'),
  handler(async (req) => courtsService.listCourts({
    lawFirmId: req.params.lawFirmId,
  })),
);

// GET /api/lawfirms/:lawFirmId/courts/:courtId
router.get('/:courtId',
  verifyToken,
  requirePermission('courts.manage'),
  handler(async (req) => courtsService.getCourt({
    lawFirmId: req.params.lawFirmId,
    courtId: req.params.courtId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/courts/:courtId
router.put('/:courtId',
  verifyToken,
  requirePermission('courts.manage'),
  validate(updateCourtSchema),
  handler(async (req) => courtsService.updateCourt({
    lawFirmId: req.params.lawFirmId,
    courtId: req.params.courtId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/courts/:courtId
router.delete('/:courtId',
  verifyToken,
  requirePermission('courts.manage'),
  handler(async (req) => courtsService.deleteCourt({
    lawFirmId: req.params.lawFirmId,
    courtId: req.params.courtId,
  })),
);

export = router;
