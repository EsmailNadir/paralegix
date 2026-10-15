import { z } from 'zod';

// memberId is a Firebase UID (text, not uuid) — see AGENTS.md's `users` table note.
const memberParams = z.object({
  lawFirmId: z.string(),
  memberId: z.string().min(1),
});

export const listMembersSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
});

export const getMemberSchema = z.object({
  params: memberParams,
});

export const getMyMembershipSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
});

export const removeMemberSchema = z.object({
  params: memberParams,
});

export const changeRoleSchema = z.object({
  params: memberParams,
  body: z.object({
    roleId: z.string().uuid('Invalid roleId'),
  }),
});

export const updateDefaultHourlyRateSchema = z.object({
  params: memberParams,
  body: z.object({
    defaultHourlyRate: z.number().min(0).nullable(),
  }),
});

export const leaveFirmSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
  body: z.object({
    newAdminUserId: z.string().min(1).optional(),
    confirmDeletion: z.boolean().optional(),
  }).optional(),
});

export const transferOwnershipSchema = z.object({
  params: z.object({ lawFirmId: z.string() }),
  body: z.object({
    newOwnerUserId: z.string().min(1),
  }),
});
