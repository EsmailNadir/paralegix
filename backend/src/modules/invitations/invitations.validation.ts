import { z } from 'zod';

const emailSchema = z.string().email('Invalid email format').transform((v) => v.trim().toLowerCase());

export const associateClientDirectSchema = z.object({
  body: z.object({
    email: emailSchema,
  }),
});

export const sendClientInviteSchema = z.object({
  body: z.object({
    email: emailSchema,
  }),
});

export const inviteMemberSchema = z.object({
  body: z.object({
    email: emailSchema,
    roleId: z.string().min(1, 'roleId is required'),
  }),
});

export const resendClientInviteSchema = z.object({
  body: z.object({
    clientId: z.string().min(1, 'clientId is required'),
  }),
});

export const resendMemberInviteSchema = z.object({
  body: z.object({
    inviteId: z.string().min(1, 'inviteId is required'),
  }),
});

export const revokeInviteSchema = z.object({
  params: z.object({
    lawFirmId: z.string(),
    inviteId: z.string().uuid('Invalid invitation id'),
  }),
});

export const acceptTokenSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'token is required'),
    confirmSwitch: z.boolean().optional(),
  }),
});
