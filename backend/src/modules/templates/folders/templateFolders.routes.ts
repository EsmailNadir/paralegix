const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { createFolderSchema, updateFolderSchema } = require('./templateFolders.validation');
const templateFoldersService = require('./templateFolders.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/templates/folders (List all template folders)
router.get('/folders',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => templateFoldersService.listFolders({
    lawFirmId: req.params.lawFirmId,
  }))
);

// POST /api/lawfirms/:lawFirmId/templates/folders (Create a template folder)
router.post('/folders',
  verifyToken,
  requirePermission('templates.manage'),
  validate(createFolderSchema),
  handler(async (req) => {
    // lawFirmId is trusted and must come from the URL, not the body: the
    // create schema does not declare it, so an unknown body key survives
    // validate()'s merge and would silently win if it were spread last.
    const result = await templateFoldersService.createFolder({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
    });
    return result;
  }, 201)
);

// PUT /api/lawfirms/:lawFirmId/templates/folders/:folderId (Update a template folder)
router.put('/folders/:folderId',
  verifyToken,
  requirePermission('templates.manage'),
  validate(updateFolderSchema),
  handler(async (req) => {
    // lawFirmId and folderId are trusted and must come from the URL, not the
    // body: the update schema does not declare either, so an unknown body key
    // survives validate()'s merge and would silently win if it were spread
    // last, letting a caller redirect the write to another firm's folder.
    const result = await templateFoldersService.updateFolder({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      folderId: req.params.folderId,
    });
    return result;
  })
);

// DELETE /api/lawfirms/:lawFirmId/templates/folders/:folderId (Delete a template folder)
router.delete('/folders/:folderId',
  verifyToken,
  requirePermission('templates.manage'),
  handler(async (req) => templateFoldersService.deleteFolder({
    lawFirmId: req.params.lawFirmId,
    folderId: req.params.folderId,
  }))
);

export = router;
