const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  createIntakeFormSchema,
  updateIntakeFormSchema,
} = require('./intakeForms.validation');
const intakeFormsService = require('./intakeForms.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/intake-forms
router.get('/',
  verifyToken,
  requirePermission('leads.view'),
  handler(async (req) => intakeFormsService.listIntakeForms({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/intake-forms
router.post('/',
  verifyToken,
  requirePermission('leads.manage'),
  validate(createIntakeFormSchema),
  handler(async (req) => intakeFormsService.createIntakeForm({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/intake-forms/:templateId/regenerate-token
router.post('/:templateId/regenerate-token',
  verifyToken,
  requirePermission('leads.manage'),
  handler(async (req) => intakeFormsService.regenerateIntakeFormToken({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
  })),
);

// GET /api/lawfirms/:lawFirmId/intake-forms/:templateId
router.get('/:templateId',
  verifyToken,
  requirePermission('leads.view'),
  handler(async (req) => intakeFormsService.getIntakeForm({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/intake-forms/:templateId
router.put('/:templateId',
  verifyToken,
  requirePermission('leads.manage'),
  validate(updateIntakeFormSchema),
  handler(async (req) => intakeFormsService.updateIntakeForm({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/intake-forms/:templateId
router.delete('/:templateId',
  verifyToken,
  requirePermission('leads.manage'),
  handler(async (req) => intakeFormsService.deleteIntakeForm({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
  })),
);

export = router;
