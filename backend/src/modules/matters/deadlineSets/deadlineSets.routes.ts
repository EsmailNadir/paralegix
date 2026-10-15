const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createDeadlineSetSchema,
  updateDeadlineSetSchema,
} = require('./deadlineSets.validation');
const deadlineSetsService = require('./deadlineSets.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/deadline-sets
// Readable by anyone who can work matters, so the "apply" flow can load them.
router.get('/',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => deadlineSetsService.listDeadlineSets({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/deadline-sets/:templateId
router.get('/:templateId',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => deadlineSetsService.getDeadlineSet({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/deadline-sets
router.post('/',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(createDeadlineSetSchema),
  handler(async (req) => deadlineSetsService.createDeadlineSet({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/deadline-sets/:templateId
router.put('/:templateId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateDeadlineSetSchema),
  handler(async (req) => deadlineSetsService.updateDeadlineSet({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/deadline-sets/:templateId
router.delete('/:templateId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  handler(async (req) => deadlineSetsService.deleteDeadlineSet({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    actingUserId: req.user.uid,
  })),
);

export = router;
