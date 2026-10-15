const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createTemplateSchema, updateTemplateSchema } = require('./documentRequestTemplates.validation');
const templatesService = require('./documentRequestTemplates.service');
import { handler } from '../../../shared/http/handler';

// Document request templates are firm-level configuration, same shape as
// matter custom fields: any member who can request documents may READ them
// (to apply one in the New Request modal); only firm settings managers may
// create/edit/archive them.

// GET /api/lawfirms/:lawFirmId/document-request-templates
router.get('/',
  verifyToken,
  requirePermission(['documents.request', 'settings.viewFirm']),
  handler(async (req) => templatesService.listTemplates({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    includeArchived: req.query.includeArchived === 'true',
  })),
);

// POST /api/lawfirms/:lawFirmId/document-request-templates
router.post('/',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(createTemplateSchema),
  handler(async (req) => templatesService.createTemplate({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/document-request-templates/:templateId
router.put('/:templateId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateTemplateSchema),
  handler(async (req) => templatesService.updateTemplate({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/document-request-templates/:templateId (archives)
router.delete('/:templateId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  handler(async (req) => templatesService.archiveTemplate({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    templateId: req.params.templateId,
  })),
);

export = router;
