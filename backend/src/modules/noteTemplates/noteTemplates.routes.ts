const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { createNoteTemplateSchema } = require('./noteTemplates.validation');
const noteTemplatesService = require('./noteTemplates.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/note-templates
router.get('/',
  verifyToken,
  requirePermission('noteTemplates.view'),
  handler(async (req) => noteTemplatesService.listNoteTemplates({ lawFirmId: req.params.lawFirmId })),
);

// POST /api/lawfirms/:lawFirmId/note-templates
router.post('/',
  verifyToken,
  requirePermission('noteTemplates.manage'),
  validate(createNoteTemplateSchema),
  handler(async (req) => noteTemplatesService.createNoteTemplate({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

export = router;
