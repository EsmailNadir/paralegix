const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const auditService = require('./audit.service');
const { listAuditEventsSchema } = require('./audit.validation');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/audit-events
router.get('/',
  verifyToken,
  requirePermission('firm.viewAuditLog'),
  validate(listAuditEventsSchema),
  handler(async (req) => auditService.listAuditEvents({
    lawFirmId: req.params.lawFirmId,
    limit: req.query.limit,
    offset: req.query.offset,
    action: req.query.action,
    actorUid: req.query.actorUid,
  })),
);

export = router;
