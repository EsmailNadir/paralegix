const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createPipelineSchema, updatePipelineSchema } = require('./matterStagePipelines.validation');
const matterStagePipelinesService = require('./matterStagePipelines.service');
import { handler } from '../../../shared/http/handler';

// Matter stage pipelines are firm-level configuration. Any matter viewer may
// READ them; only firm settings managers may create/edit/delete.

// GET /api/lawfirms/:lawFirmId/matter-stage-pipelines
router.get('/',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => matterStagePipelinesService.listPipelines({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/matter-stage-pipelines
router.post('/',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(createPipelineSchema),
  handler(async (req) => matterStagePipelinesService.createPipeline({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matter-stage-pipelines/:pipelineId
router.put('/:pipelineId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updatePipelineSchema),
  handler(async (req) => matterStagePipelinesService.updatePipeline({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    pipelineId: req.params.pipelineId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matter-stage-pipelines/:pipelineId
router.delete('/:pipelineId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  handler(async (req) => matterStagePipelinesService.deletePipeline({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    pipelineId: req.params.pipelineId,
  })),
);

export = router;
