const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { createNoteTypeSchema, updateNoteTypeColorSchema } = require('./noteTypes.validation');
const noteTypesService = require('./noteTypes.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/note-types
router.get('/',
  verifyToken,
  requirePermission('noteTypes.view'),
  handler(async (req) => noteTypesService.listNoteTypes({ lawFirmId: req.params.lawFirmId })),
);

// POST /api/lawfirms/:lawFirmId/note-types
router.post('/',
  verifyToken,
  requirePermission('noteTypes.manage'),
  validate(createNoteTypeSchema),
  handler(async (req) => noteTypesService.createNoteType({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PATCH /api/lawfirms/:lawFirmId/note-types/:value/color
router.patch('/:value/color',
  verifyToken,
  requirePermission('noteTypes.manage'),
  validate(updateNoteTypeColorSchema),
  handler(async (req) => noteTypesService.setNoteTypeColor({
    lawFirmId: req.params.lawFirmId,
    value: req.params.value,
    color: req.body.color,
  })),
);

export = router;
