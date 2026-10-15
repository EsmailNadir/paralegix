const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createStageSchema, updateStageSchema } = require('./matterStages.validation');
const matterStagesService = require('./matterStages.service');
import { handler } from '../../../shared/http/handler';

// Matter stages are firm-level configuration. Reads are nested in the pipeline
// aggregate; only firm settings managers may create, edit, or delete stages.

// POST /api/lawfirms/:lawFirmId/matter-stages
router.post('/',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(createStageSchema),
  handler(async (req) => matterStagesService.createStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matter-stages/:stageId
router.put('/:stageId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateStageSchema),
  handler(async (req) => matterStagesService.updateStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    stageId: req.params.stageId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matter-stages/:stageId
router.delete('/:stageId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  handler(async (req) => matterStagesService.deleteStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    stageId: req.params.stageId,
  })),
);

export = router;
