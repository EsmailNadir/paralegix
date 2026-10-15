const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../shared/middleware/auth');
const { requirePermission } = require('../roles/requirePermission');
const { validate } = require('../../../shared/middleware/validate');
const {
  listMembersSchema,
  getMemberSchema,
  getMyMembershipSchema,
  removeMemberSchema,
  changeRoleSchema,
  updateDefaultHourlyRateSchema,
  leaveFirmSchema,
  transferOwnershipSchema,
} = require('./members.validation');
const membersService = require('./members.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/members (List all members)
router.get('/:lawFirmId/members',
  verifyToken,
  requirePermission('members.view'),
  validate(listMembersSchema),
  handler(async (req) => membersService.listMembers({ lawFirmId: req.params.lawFirmId }))
);

// GET /api/lawfirms/:lawFirmId/members/me (The calling member's own row)
//
// Declared ABOVE the /:memberId wildcard, which would otherwise capture "me" as
// a user id and 404.
//
// Gated on membership alone, like `POST /:lawFirmId/leave` below: the caller is
// asking about their own membership row, and any permission code in front of
// this would render a narrow member's whole app as denied. The service resolves
// the caller's member row and refuses a non-member with the same ForbiddenError
// the roster's permission check raises, which is the tenant check.
router.get('/:lawFirmId/members/me',
  verifyToken,
  validate(getMyMembershipSchema),
  handler(async (req) => membersService.getMyMembership({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/members/:memberId (Get single member)
router.get('/:lawFirmId/members/:memberId',
  verifyToken,
  requirePermission('members.view'),
  validate(getMemberSchema),
  handler(async (req) => {
    const member = await membersService.getMember({
      lawFirmId: req.params.lawFirmId,
      userId: req.params.memberId,
    });
    return member;
  })
);

// DELETE /api/lawfirms/:lawFirmId/members/:memberId (Remove member)
router.delete('/:lawFirmId/members/:memberId',
  verifyToken,
  requirePermission('members.remove'),
  validate(removeMemberSchema),
  handler(async (req) => membersService.removeMember({
    lawFirmId: req.params.lawFirmId,
    targetUserId: req.params.memberId,
    actingMember: req.member,
  }))
);

// PUT /api/lawfirms/:lawFirmId/members/:memberId/role (Change member role)
router.put('/:lawFirmId/members/:memberId/role',
  verifyToken,
  requirePermission('members.changeRole'),
  validate(changeRoleSchema),
  handler(async (req) => membersService.changeRole({
    lawFirmId: req.params.lawFirmId,
    targetUserId: req.params.memberId,
    roleId: req.body.roleId,
    actingMember: req.member,
  }))
);

// PUT /api/lawfirms/:lawFirmId/members/:memberId/default-hourly-rate (Set default hourly rate)
router.put('/:lawFirmId/members/:memberId/default-hourly-rate',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(updateDefaultHourlyRateSchema),
  handler(async (req) => membersService.updateDefaultHourlyRate({
    lawFirmId: req.params.lawFirmId,
    targetUserId: req.params.memberId,
    defaultHourlyRate: req.body.defaultHourlyRate,
  }))
);

// POST /api/lawfirms/:lawFirmId/leave (Leave firm)
// Deliberately gated on membership alone, not on a permission: leaving is an act
// on your own membership, and a role narrow enough to lack `members.view` must
// still be able to walk away. The service resolves the caller's own member row
// and 404s when there isn't one, which is the tenant check.
router.post('/:lawFirmId/leave',
  verifyToken,
  validate(leaveFirmSchema),
  handler(async (req) => membersService.leaveFirm({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    confirmDeletion: req.body?.confirmDeletion,
    newAdminUserId: req.body?.newAdminUserId,
  }))
);

// POST /api/lawfirms/:lawFirmId/transfer-ownership (Hand ownership to another member)
router.post('/:lawFirmId/transfer-ownership',
  verifyToken,
  requirePermission('firm.transferOwnership'),
  validate(transferOwnershipSchema),
  handler(async (req) => membersService.transferOwnership({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    targetUserId: req.body.newOwnerUserId,
  }))
);

export = router;
