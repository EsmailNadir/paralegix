const express = require('express');
const router = express.Router();

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { inviteLookupLimiter } = require('../../shared/middleware/rateLimiters');
const { acceptTokenSchema } = require('./invitations.validation');
const invitationsService = require('./invitations.service');
import { handler } from '../../shared/http/handler';

// GET /api/invitations/accept/:token
// Public: returns invitation details for display before login
router.get('/accept/:token', inviteLookupLimiter, handler(async (req) => invitationsService.lookupInviteByToken(req.params.token)));

// POST /api/invitations/accept
// Authenticated: accepts the invitation and associates the client
router.post('/accept',
  verifyToken,
  validate(acceptTokenSchema),
  handler(async (req) => invitationsService.acceptInviteByToken({
    userId: req.user.uid,
    token: req.body.token,
  })),
);

// GET /api/invitations/member-accept/:token
// Public: returns member invitation details for display before login
router.get('/member-accept/:token', inviteLookupLimiter, handler(async (req) => invitationsService.lookupMemberInviteByToken(req.params.token)));

// POST /api/invitations/member-accept
// Authenticated: accepts the member invitation and adds user to firm
router.post('/member-accept',
  verifyToken,
  validate(acceptTokenSchema),
  handler(async (req) => invitationsService.acceptMemberInviteByToken({
    userId: req.user.uid,
    token: req.body.token,
    confirmSwitch: req.body.confirmSwitch,
  })),
);

// GET /api/invitations/my-pending-member-invites
// Authenticated: member invites waiting on the caller's own email.
router.get('/my-pending-member-invites',
  verifyToken,
  handler(async (req) => invitationsService.listMyPendingMemberInvites({ email: req.user.email })),
);

export = router;
