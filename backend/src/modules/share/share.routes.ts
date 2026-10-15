// PUBLIC (unauthenticated) resolver for external file share links. The token in
// the URL is the sole credential; there is no verifyToken. Mirrors the public
// signing routes. Rate-limited by IP to blunt token/password guessing.

const express = require('express');
const router = express.Router({ mergeParams: true });
const { publicShareLimiter } = require('../../shared/middleware/rateLimiters');
const { validate } = require('../../shared/middleware/validate');
const { resolveDownloadSchema, listPublicItemsSchema } = require('../files/shareLinks.validation');
const service = require('../files/shareLinks.service');
import { handler } from '../../shared/http/handler';

// GET /api/share/:token (landing metadata; never exposes the file path)
router.get('/:token', publicShareLimiter, handler(async (req) => service.getPublicMeta(req.params.token)));

// POST /api/share/:token/download (validate password, return a short-lived URL)
router.post('/:token/download', publicShareLimiter, validate(resolveDownloadSchema), handler(async (req) => service.resolveDownload(req.params.token, req.body?.password, req.body?.fileId)));

// POST /api/share/:token/items (validate password, list the link's items or one shared folder)
router.post('/:token/items', publicShareLimiter, validate(listPublicItemsSchema), handler(async (req) => service.listPublicItems(req.params.token, { password: req.body?.password, folderId: req.body?.folderId })));

export = router;
