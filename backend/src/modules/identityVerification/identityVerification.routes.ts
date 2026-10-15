/**
 * Firm-side read of a client's identity verification, mounted with the client
 * routes at `/api/lawfirms/:lawFirmId/clients`.
 */
import express from 'express';
import { handler } from '../../shared/http/handler';
import { verifyToken } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import { requirePermission } from '../lawfirms/roles/requirePermission';
import * as service from './identityVerification.service';
import { firmIdentitySchema } from './identityVerification.validation';

const router = express.Router({ mergeParams: true });

// GET /api/lawfirms/:lawFirmId/clients/:clientId/identity-verification
router.get('/:clientId/identity-verification',
  verifyToken,
  requirePermission('clients.view'),
  validate(firmIdentitySchema),
  handler(async (req) => service.getClientIdentityVerification({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    clientId: req.params.clientId,
  })));

export = router;
