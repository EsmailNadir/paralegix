/**
 * Portal routes for identity verification, mounted by `clients/portal/portal.routes.ts`
 * at `/api/client-portal/lawfirm/:lawFirmId/identity`. That mount sits behind the
 * portal router's `verifyToken`, `requireUserType(['client'])` and its per-firm
 * billing and feature gate, so every route here inherits them.
 *
 * The active client is chosen exactly as on every other portal route: the
 * `clientRecordId` query or body value, else the caller's single association.
 */
import express from 'express';
import { handler, type AuthedRequest } from '../../shared/http/handler';
import { identityVerificationStartLimiter } from '../../shared/middleware/rateLimiters';
import { validate } from '../../shared/middleware/validate';
import * as service from './identityVerification.service';
import {
  completeVerificationSchema,
  pollVerificationSchema,
  portalIdentitySchema,
  startVerificationSchema,
} from './identityVerification.validation';

const router = express.Router({ mergeParams: true });

function caller(req: AuthedRequest) {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.clientRecordId;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.clientRecordId;
  const clientRecordId = typeof fromQuery === 'string' ? fromQuery : typeof fromBody === 'string' ? fromBody : undefined;
  return {
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    userData: req.userData,
    clientRecordId,
  };
}

// GET /api/client-portal/lawfirm/:lawFirmId/identity
router.get('/',
  validate(portalIdentitySchema),
  handler(async (req) => service.getPortalIdentity(caller(req))));

// POST /api/client-portal/lawfirm/:lawFirmId/identity/verifications
router.post('/verifications',
  identityVerificationStartLimiter,
  validate(startVerificationSchema),
  handler(async (req) => service.startVerification({ ...caller(req), method: req.body.method }), 201));

// POST /api/client-portal/lawfirm/:lawFirmId/identity/verifications/:verificationId/complete
router.post('/verifications/:verificationId/complete',
  validate(completeVerificationSchema),
  handler(async (req) => service.completeVerification({
    ...caller(req),
    verificationId: req.params.verificationId,
    data: req.body.data,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/identity/verifications/:verificationId/poll
router.post('/verifications/:verificationId/poll',
  validate(pollVerificationSchema),
  handler(async (req) => service.pollVerification({
    ...caller(req),
    verificationId: req.params.verificationId,
  })));

export = router;
