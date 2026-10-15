const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  createPracticeAreaSchema,
  updatePracticeAreaSchema,
} = require('./practiceAreas.validation');
const practiceAreasService = require('./practiceAreas.service');
import { handler } from '../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/practice-areas
router.post('/',
  verifyToken,
  requirePermission('practiceAreas.manage'),
  validate(createPracticeAreaSchema),
  handler(async (req) => practiceAreasService.createPracticeArea({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/practice-areas
router.get('/',
  verifyToken,
  requirePermission('practiceAreas.view'),
  handler(async (req) => practiceAreasService.listPracticeAreas({
    lawFirmId: req.params.lawFirmId,
  })),
);

// GET /api/lawfirms/:lawFirmId/practice-areas/:practiceAreaId
router.get('/:practiceAreaId',
  verifyToken,
  requirePermission('practiceAreas.view'),
  handler(async (req) => practiceAreasService.getPracticeArea({
    lawFirmId: req.params.lawFirmId,
    practiceAreaId: req.params.practiceAreaId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/practice-areas/:practiceAreaId
router.put('/:practiceAreaId',
  verifyToken,
  requirePermission('practiceAreas.manage'),
  validate(updatePracticeAreaSchema),
  handler(async (req) => practiceAreasService.updatePracticeArea({
    lawFirmId: req.params.lawFirmId,
    practiceAreaId: req.params.practiceAreaId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/practice-areas/:practiceAreaId
router.delete('/:practiceAreaId',
  verifyToken,
  requirePermission('practiceAreas.manage'),
  handler(async (req) => practiceAreasService.deletePracticeArea({
    lawFirmId: req.params.lawFirmId,
    practiceAreaId: req.params.practiceAreaId,
  })),
);

export = router;
