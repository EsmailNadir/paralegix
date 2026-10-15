const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  associateClientDirectSchema,
  sendClientInviteSchema,
  inviteMemberSchema,
  resendClientInviteSchema,
  resendMemberInviteSchema,
  revokeInviteSchema,
} = require('./invitations.validation');
const invitationsService = require('./invitations.service');
import { handler } from '../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/invitations/associate-client-direct
router.post('/associate-client-direct',
  verifyToken,
  requirePermission('clients.invite'),
  validate(associateClientDirectSchema),
  handler(async (req) => invitationsService.associateClientDirect({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/send-client-invite
router.post('/send-client-invite',
  verifyToken,
  requirePermission('clients.invite'),
  validate(sendClientInviteSchema),
  handler(async (req) => invitationsService.sendClientInvite({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/invite-member
router.post('/invite-member',
  verifyToken,
  requirePermission('members.invite'),
  validate(inviteMemberSchema),
  handler(async (req) => invitationsService.inviteMember({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    actingMember: req.member,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/resend-client-invite
router.post('/resend-client-invite',
  verifyToken,
  requirePermission('clients.invite'),
  validate(resendClientInviteSchema),
  handler(async (req) => invitationsService.resendClientInvite({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/invitations/pending-client-invites
router.get('/pending-client-invites',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => invitationsService.listPendingClientInvites({
    lawFirmId: req.params.lawFirmId,
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/resend-member-invite
router.post('/resend-member-invite',
  verifyToken,
  requirePermission('members.invite'),
  validate(resendMemberInviteSchema),
  handler(async (req) => invitationsService.resendMemberInvite({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/invitations/pending-member-invites
router.get('/pending-member-invites',
  verifyToken,
  requirePermission('members.view'),
  handler(async (req) => invitationsService.listPendingMemberInvites({
    lawFirmId: req.params.lawFirmId,
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/member-invites/:inviteId/revoke
// Cancel a pending member invite before it is accepted/expires (sets status='revoked').
router.post('/member-invites/:inviteId/revoke',
  verifyToken,
  requirePermission('members.invite'),
  validate(revokeInviteSchema),
  handler(async (req) => invitationsService.revokeInvite({
    lawFirmId: req.params.lawFirmId,
    inviteId: req.params.inviteId,
    inviteType: 'member',
  })),
);

// POST /api/lawfirms/:lawFirmId/invitations/client-invites/:inviteId/revoke
// Cancel a pending client invite before it is accepted/expires (sets status='revoked').
router.post('/client-invites/:inviteId/revoke',
  verifyToken,
  requirePermission('clients.invite'),
  validate(revokeInviteSchema),
  handler(async (req) => invitationsService.revokeInvite({
    lawFirmId: req.params.lawFirmId,
    inviteId: req.params.inviteId,
    inviteType: 'client',
  })),
);

// --- Periodic sweep: flip pending invitations past expires_at to 'expired' ---
// Expiry was filter-only, so expired rows stayed 'pending' forever and the
// partial pending index never shed them. Mirrors the signing cleanup schedule
// (signing.routes.js): run 30s after startup, then every 24 hours.
const INVITE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sweepExpiredInvitations() {
  try {
    await invitationsService.expireStaleInvitations();
  } catch (err: any) {
    console.error('[invitations sweep] Error expiring stale invitations:', err.message);
  }
}

// .unref() so these background timers don't keep the event loop alive. A bare
// setTimeout/setInterval blocks process exit (hangs test harnesses and graceful
// shutdown). The sweep is best-effort, so letting the process exit past it is fine.
// Driven by POST /api/cron/housekeeping. See the note in templates.routes.js:
// the previous boot-timer + 24h interval pair never actually ran on schedule
// under Cloud Run's request-based CPU allocation.

// The router with the cron sweep attached, which is how the housekeeping
// endpoint reaches it.
export = Object.assign(router, { sweepExpiredInvitations });
