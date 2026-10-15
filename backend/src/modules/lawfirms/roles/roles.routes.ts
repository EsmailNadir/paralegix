const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../shared/middleware/auth');
const { requirePermission } = require('./requirePermission');
const { validate } = require('../../../shared/middleware/validate');
const {
  listRolesSchema,
  getRoleSchema,
  createRoleSchema,
  updateRoleSchema,
  deleteRoleSchema,
} = require('./roles.validation');
const rolesService = require('./roles.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/roles (List all roles)
router.get('/:lawFirmId/roles',
  verifyToken,
  requirePermission('members.view'),
  validate(listRolesSchema),
  handler(async (req) => rolesService.listRoles({ lawFirmId: req.params.lawFirmId }))
);

// GET /api/lawfirms/:lawFirmId/roles/:roleId (Get single role)
router.get('/:lawFirmId/roles/:roleId',
  verifyToken,
  requirePermission('members.view'),
  validate(getRoleSchema),
  handler(async (req) => {
    const role = await rolesService.getRole({ lawFirmId: req.params.lawFirmId, roleId: req.params.roleId });
    return role;
  })
);

// POST /api/lawfirms/:lawFirmId/roles (Create custom role)
router.post('/:lawFirmId/roles',
  verifyToken,
  requirePermission('firm.manageRoles'),
  validate(createRoleSchema),
  handler(async (req) => rolesService.createRole({
    lawFirmId: req.params.lawFirmId,
    name: req.body.name,
    permissions: req.body.permissions,
    actingMember: req.member,
  }), 201)
);

// PUT /api/lawfirms/:lawFirmId/roles/:roleId (Update role)
router.put('/:lawFirmId/roles/:roleId',
  verifyToken,
  requirePermission('firm.manageRoles'),
  validate(updateRoleSchema),
  handler(async (req) => rolesService.updateRole({
    lawFirmId: req.params.lawFirmId,
    roleId: req.params.roleId,
    name: req.body.name,
    permissions: req.body.permissions,
    actingMember: req.member,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/roles/:roleId (Delete custom role)
router.delete('/:lawFirmId/roles/:roleId',
  verifyToken,
  requirePermission('firm.manageRoles'),
  validate(deleteRoleSchema),
  handler(async (req) => rolesService.deleteRole({ lawFirmId: req.params.lawFirmId, roleId: req.params.roleId }))
);

export = router;
