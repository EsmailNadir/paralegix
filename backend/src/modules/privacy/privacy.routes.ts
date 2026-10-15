const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken, verifyTokenForErasure } = require('../../shared/middleware/auth');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { logSecurityEvent } = require('../../shared/utils/securityLog');
const privacyService = require('./privacy.service');
import { handler } from '../../shared/http/handler';

// POST /api/privacy/accept-terms - record the caller's acceptance of the terms
// and privacy policy (version, time, IP).
router.post('/privacy/accept-terms',
  verifyToken,
  handler(async (req) => privacyService.recordConsent({
    userId: req.user.uid,
    ip: req.ip,
    version: req.body && req.body.version,
  }))
);

// GET /api/privacy/me/export - machine-readable copy of the caller's personal data.
router.get('/privacy/me/export',
  verifyToken,
  handler(async (req) => {
    const data = await privacyService.exportMyData({ userId: req.user.uid });
    logSecurityEvent(req, 'data.export', { scope: 'self', subjectUid: req.user.uid });
    return data;
  })
);

// DELETE /api/privacy/me - erase the caller's account and personal data.
router.delete('/privacy/me',
  verifyTokenForErasure,
  handler(async (req, res) => {
    const result = await privacyService.eraseMyAccount({ userId: req.user.uid, ip: req.ip });
    logSecurityEvent(req, 'data.erasure', { scope: 'self', subjectUid: req.user.uid });
    res.status(result.erasureStatus === 'pending' ? 202 : 200).json(result);
  })
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/data-export - the firm compiles a
// client's personal data to fulfill an access/portability request.
// Gated above `clients.view` on purpose: that permission is part of the
// baseline every member holds, and this route returns a client's complete
// personal-data bundle. Compiling it is a subject-rights action, so it sits
// with the roles that manage or erase client records.
router.get('/lawfirms/:lawFirmId/clients/:clientId/data-export',
  verifyToken,
  requirePermission(['clients.manage', 'clients.erase']),
  handler(async (req) => {
    const data = await privacyService.exportClientData({
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
    });
    logSecurityEvent(req, 'data.export', {
      scope: 'client',
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
    });
    return data;
  })
);

// POST /api/lawfirms/:lawFirmId/clients/:clientId/erase - the firm erases a client
// and their personal data (blocked while the client is under legal hold).
router.post('/lawfirms/:lawFirmId/clients/:clientId/erase',
  verifyToken,
  requirePermission('clients.erase'),
  handler(async (req) => {
    const result = await privacyService.eraseClient({
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
      actingUserId: req.user.uid,
    });
    logSecurityEvent(req, 'data.erasure', {
      scope: 'client',
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
    });
    return result;
  })
);

export = router;
