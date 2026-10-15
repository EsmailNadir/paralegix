import { z } from 'zod';
const { ALL_PERMISSIONS } = require('./permissions');

const permissionCode = z.string().refine((p) => ALL_PERMISSIONS.includes(p), {
  message: 'Unknown permission code',
});

export const listRolesSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
});

export const getRoleSchema = z.object({
  params: z.object({ lawFirmId: z.string(), roleId: z.string() }),
});

export const createRoleSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
  body: z.object({
    name: z.string().min(1, 'Role name is required').max(200),
    permissions: z.array(permissionCode).max(ALL_PERMISSIONS.length).optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({ lawFirmId: z.string(), roleId: z.string() }),
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    permissions: z.array(permissionCode).max(ALL_PERMISSIONS.length).optional(),
  }),
});

export const deleteRoleSchema = z.object({
  params: z.object({ lawFirmId: z.string(), roleId: z.string() }),
});
