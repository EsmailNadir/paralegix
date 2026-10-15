import { z } from 'zod';
const { paging, sorting, dayOnly } = require('../../shared/validation/listQuery');

const LEAD_SORT_FIELDS = ['name', 'email', 'organization', 'createdAt', 'updatedAt'] as const;

export const createLeadSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(100).nullable().optional(),
    organization: z.string().max(200).nullable().optional(),
    referralSource: z.string().max(200).nullable().optional(),
    notes: z.string().max(10000).nullable().optional(),
    stageId: z.string().uuid().nullable().optional(),
    stageDate: dayOnly.nullable().optional(),
    disqualifyReason: z.string().max(1000).nullable().optional(),
  }),
});

export const updateLeadSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(100).nullable().optional(),
    organization: z.string().max(200).nullable().optional(),
    referralSource: z.string().max(200).nullable().optional(),
    notes: z.string().max(10000).nullable().optional(),
    stageId: z.string().uuid().nullable().optional(),
    stageDate: dayOnly.nullable().optional(),
    disqualifyReason: z.string().max(1000).nullable().optional(),
  }),
});

export const listLeadsSchema = z.object({
  query: z.object({
    ...paging({ max: 500 }),
    search: z.string().max(500).optional(),
    stageId: z.string().max(100).optional(),
    ...sorting(LEAD_SORT_FIELDS),
  }).passthrough(),
});

// The lead's own `organization` free-text field never implies "convert as a
// company" by itself (a person lead can have an employer there without
// meaning to become a company client), so the caller must say so explicitly.
const convertClientTypeEnum = z.enum(['person', 'company']);

export const convertLeadSchema = z.object({
  body: z.object({
    createMatter: z.boolean().optional(),
    clientType: convertClientTypeEnum.optional(),
    // For a company conversion: an existing organization client to convert
    // into, or the name of one to create. Either replaces the lead's own
    // `organization` text, which is only the fallback.
    organizationClientId: z.string().uuid().optional(),
    organizationName: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    matterNumber: z.string().optional(),
    description: z.string().max(5000).optional(),
    practiceAreaId: z.string().optional(),
    category: z.string().optional(),
    courtId: z.string().optional(),
    leadUserIds: z.array(z.string()).optional(),
  }).superRefine((data, ctx) => {
    if (data.createMatter !== false && !data.name?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Matter name is required', path: ['name'] });
    }
  }),
});
