const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createStageSchema, updateStageSchema, reorderStagesSchema } = require('./leadStages.validation');
const leadStagesService = require('./leadStages.service');
import { handler } from '../../../shared/http/handler';

// Lead stages are firm-level configuration (the kanban pipeline). Any lead
// viewer may READ them; only stage managers may create/edit/reorder/delete.

// GET /api/lawfirms/:lawFirmId/lead-stages
router.get('/',
  verifyToken,
  requirePermission('leads.view'),
  handler(async (req) => leadStagesService.listStages({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/lead-stages/reorder (before /:stageId)
router.post('/reorder',
  verifyToken,
  requirePermission('leads.manageStages'),
  validate(reorderStagesSchema),
  handler(async (req) => leadStagesService.reorderStages({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    stageIds: req.body.stageIds,
  })),
);

// POST /api/lawfirms/:lawFirmId/lead-stages
router.post('/',
  verifyToken,
  requirePermission('leads.manageStages'),
  validate(createStageSchema),
  handler(async (req) => leadStagesService.createStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/lead-stages/:stageId
router.put('/:stageId',
  verifyToken,
  requirePermission('leads.manageStages'),
  validate(updateStageSchema),
  handler(async (req) => leadStagesService.updateStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    stageId: req.params.stageId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/lead-stages/:stageId
router.delete('/:stageId',
  verifyToken,
  requirePermission('leads.manageStages'),
  handler(async (req) => leadStagesService.deleteStage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    stageId: req.params.stageId,
  })),
);

export = router;
