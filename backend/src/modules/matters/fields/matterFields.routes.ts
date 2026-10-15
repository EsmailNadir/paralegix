const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createFieldDefSchema, updateFieldDefSchema } = require('./matterFields.validation');
const matterFieldsService = require('./matterFields.service');
import { handler } from '../../../shared/http/handler';

// Custom matter field definitions are firm-level configuration. Any matter viewer
// may READ them (to render the fields + values on a matter); only firm settings
// managers may create/edit/delete them (mirrors deadline-set templates).

// GET /api/lawfirms/:lawFirmId/matter-field-defs
router.get('/',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => matterFieldsService.listFieldDefs({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    includeArchived: req.query.includeArchived === 'true',
  })),
);

// POST /api/lawfirms/:lawFirmId/matter-field-defs
router.post('/',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(createFieldDefSchema),
  handler(async (req) => matterFieldsService.createFieldDef({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matter-field-defs/:defId
router.put('/:defId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateFieldDefSchema),
  handler(async (req) => matterFieldsService.updateFieldDef({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    defId: req.params.defId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matter-field-defs/:defId
router.delete('/:defId',
  verifyToken,
  requirePermission('settings.manageFirm'),
  handler(async (req) => matterFieldsService.deleteFieldDef({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    defId: req.params.defId,
  })),
);

export = router;
