const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const {
  addMembersSchema,
  removeMembersSchema,
  previewRemoveMembersSchema,
  updateHourlyRateSchema,
  bulkAddMemberSchema,
} = require('./matterMembers.validation');
const matterMembersService = require('./matterMembers.service');
import { handler } from '../../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/matters/bulk-add-member/preview
// Same scoping as /bulk-add-member, without writing anything: lets the assign
// dialog show how many of the selected matters the user would actually join.
// (mounted before /:matterId wildcard via route ordering)
router.post('/bulk-add-member/preview',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(bulkAddMemberSchema),
  handler(async (req) => matterMembersService.previewBulkAddMember({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    targetUserId: req.body.userId,
    matterIds: req.body.matterIds,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/bulk-add-member
// (mounted before /:matterId wildcard via route ordering)
router.post('/bulk-add-member',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(bulkAddMemberSchema),
  handler(async (req) => matterMembersService.bulkAddMember({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    targetUserId: req.body.userId,
    matterIds: req.body.matterIds,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/members
router.post('/:matterId/members',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(addMembersSchema),
  handler(async (req) => matterMembersService.addMembers({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.params.matterId,
    targetUserIds: req.body.targetUserIds,
    role: req.body.role,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/members/remove/preview
// What removing these users would touch on this matter (open tasks, upcoming
// events, reminder slots), so the confirm dialog can offer to reassign it. Writes
// nothing; same audience as the removal itself.
router.post('/:matterId/members/remove/preview',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(previewRemoveMembersSchema),
  handler(async (req) => matterMembersService.previewRemoveMembers({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.params.matterId,
    targetUserIds: req.body.targetUserIds,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/members/remove
router.post('/:matterId/members/remove',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(removeMembersSchema),
  handler(async (req) => matterMembersService.removeMembers({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.params.matterId,
    targetUserIds: req.body.targetUserIds,
    reassignTo: req.body.reassignTo,
  })),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId/members/hourly-rate
router.put('/:matterId/members/hourly-rate',
  verifyToken,
  requirePermission('matters.manageMembers'),
  validate(updateHourlyRateSchema),
  handler(async (req) => matterMembersService.updateHourlyRate({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.params.matterId,
    targetUserId: req.body.userId,
    hourlyRate: req.body.hourlyRate,
  })),
);

export = router;
