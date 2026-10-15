import { z } from 'zod';

import { MAX_BULK_MATTER_IDS } from '../matters.validation';

export const addMembersSchema = z.object({
  body: z.object({
    targetUserIds: z.array(z.string()).min(1),
    // Constrain to the roles the matter_members CHECK allows, so an arbitrary
    // role string can't reach the DB (400 instead of a 500 on the constraint).
    role: z.enum(['member', 'lead']).optional().default('member'),
  }),
});

export const removeMembersSchema = z.object({
  body: z.object({
    targetUserIds: z.array(z.string()).min(1),
    // A member who stays on the matter and takes over the removed users' task and
    // event assignments. Omit it and those assignments are simply dropped.
    reassignTo: z.string().min(1).optional(),
  }),
});

// The preview takes the same ids and never writes, so it needs no reassignTo.
export const previewRemoveMembersSchema = z.object({
  body: z.object({
    targetUserIds: z.array(z.string()).min(1),
  }),
});

export const updateHourlyRateSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    hourlyRate: z.number().min(0).nullable(),
  }),
});

export const bulkAddMemberSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    // Same ceiling as the other bulk matter routes: this one is fed by the same
    // grid selection, so it inherits the same cap rather than its own number.
    matterIds: z.array(z.string()).min(1).max(MAX_BULK_MATTER_IDS),
  }),
});
