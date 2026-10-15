const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { createShareLinkSchema, listShareLinksSchema } = require('./shareLinks.validation');
const service = require('./shareLinks.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/file-share-links?fileId=... or ?fileIds=a,b (active links for a file or a selection)
router.get('/',
  verifyToken,
  requirePermission('files.upload'),
  validate(listShareLinksSchema),
  handler(async (req) => service.listShareLinks({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    fileId: req.query.fileId,
    fileIds: req.query.fileIds,
  }))
);

// POST /api/lawfirms/:lawFirmId/file-share-links (create an expiring link to a file or a selection)
router.post('/',
  verifyToken,
  requirePermission('files.upload'),
  validate(createShareLinkSchema),
  handler(async (req) => service.createShareLink({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    fileId: req.body.fileId,
    fileIds: req.body.fileIds,
    permission: req.body.permission,
    expiresInHours: req.body.expiresInHours,
    password: req.body.password || null,
  }), 201)
);

// DELETE /api/lawfirms/:lawFirmId/file-share-links/:token (revoke)
router.delete('/:token',
  verifyToken,
  requirePermission('files.upload'),
  handler(async (req) => service.revokeShareLink({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    token: req.params.token,
  }))
);

export = router;
