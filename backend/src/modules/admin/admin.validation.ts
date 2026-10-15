import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { offsetParam, paging, sorting } = require('../../shared/validation/listQuery');

const lawFirmProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  phone: z.string().max(50).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
}).strict();

const storageSchema = z.object({
  quotaBytes: z.coerce.number().int().positive().optional(),
  hardLimit: z.boolean().optional(),
  warnAtPercent: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const updateLawFirmSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
  body: z.object({
    lawFirm: lawFirmProfileSchema.optional(),
    storage: storageSchema.optional(),
  }).strict().refine((value) => {
    const hasLawFirm = !!value.lawFirm && Object.keys(value.lawFirm).length > 0;
    const hasStorage = !!value.storage && Object.keys(value.storage).length > 0;
    return hasLawFirm || hasStorage;
  }, {
    message: 'At least one of lawFirm or storage must be provided',
  }),
});

export const updateUserAdminSchema = z.object({
  params: z.object({
    userId: z.string().min(1),
  }),
  body: z.object({
    isAdmin: z.boolean(),
  }).strict(),
});

export const updatePlanSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    planId: z.enum(['starter', 'basic', 'professional', 'enterprise']).optional(),
    billingStatus: z.enum(['active', 'trialing', 'comped', 'past_due', 'suspended']).optional(),
    comped: z.boolean().optional(),
    compedReason: z.string().max(500).optional(),
    unlimitedOverride: z.boolean().optional(),
    trialEndsAt: z.string().datetime().optional().nullable(),
    limitOverrides: z.object({
      // -1 is the UNLIMITED sentinel; any other negative is nonsensical and would
      // make enforceCountLimit reject every create, so floor at -1.
      maxMatters: z.number().int().min(-1).optional(),
      maxMembers: z.number().int().min(-1).optional(),
      storageQuotaBytes: z.number().int().positive().optional(),
      maxFileSizeBytes: z.number().int().positive().optional(),
    }).optional(),
    featureOverrides: z.object({
      clientPortal: z.boolean().optional(),
      messaging: z.boolean().optional(),
      calendarSync: z.boolean().optional(),
      analytics: z.boolean().optional(),
      flatFees: z.boolean().optional(),
      fileSharing: z.boolean().optional(),
      templates: z.boolean().optional(),
      trustAccounting: z.boolean().optional(),
      documentSigning: z.boolean().optional(),
    }).optional(),
  }).strict(),
});

export const adminCreateSubscriptionSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    planId: z.enum(['professional', 'enterprise']),
    interval: z.enum(['monthly', 'annual']),
    skipTrial: z.boolean().optional(),
    coupon: z.string().optional(),
  }).strict(),
});

export const adminCancelSubscriptionSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    immediate: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  }).strict(),
});

export const adminExtendTrialSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    days: z.number().int().min(1).max(365),
  }).strict(),
});

export const adminApplyCouponSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    couponId: z.string().min(1),
  }).strict(),
});

export const adminRefundSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    amount: z.number().positive().optional(),
    full: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  }).strict(),
});

export const adminCompFirmSchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1) }),
  body: z.object({
    planId: z.enum(['starter', 'basic', 'professional', 'enterprise']).optional(),
    reason: z.string().min(1).max(500),
  }).strict(),
});

// ── Test tooling ────────────────────────────────────────────────────────

export const adminAddWhitelistSchema = z.object({
  body: z.object({
    email: z.string().email(),
    note: z.string().max(500).optional(),
  }).strict(),
});

export const adminRemoveWhitelistSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }).strict(),
});

export const adminCreateAccountSchema = z.object({
  body: z.object({
    kind: z.enum(['firm_owner', 'client', 'member']),
    email: z.string().email(),
    password: z.string().min(6).max(128),
    name: z.string().trim().min(1).max(200),
    firmName: z.string().trim().min(1).max(200).optional(),
    lawFirmId: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
  }).strict().superRefine((val, ctx) => {
    if (val.kind === 'member' && !val.lawFirmId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lawFirmId'], message: 'lawFirmId is required for a member account' });
    }
  }),
});

// Cross-firm audit-event listing for the admin console. All optional; numbers
// coerced from the query string. lawFirmId narrows to a single firm.
export const adminListAuditEventsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
    action: z.string().min(1).max(200).optional(),
    actorUid: z.string().min(1).max(200).optional(),
    lawFirmId: z.string().uuid().optional(),
    search: z.string().max(500).optional(),
  }),
});

// Paging on the admin list endpoints is opt-in: omitting `limit` returns the
// whole list, which is what the callers that need every row still do.

/**
 * An ISO timestamp bound for the `createdAfter`/`createdBefore` windows.
 *
 * `z.string().datetime()` rather than a coerced Date: the value is handed
 * straight to Postgres as a `timestamptz` parameter, and rejecting a malformed
 * bound outright beats silently passing `Invalid Date` into the query.
 */
const isoInstant = z.string().datetime({ offset: true }).optional();

/** Shared by the user and client lists — both window on a `created_at` column. */
const createdWindow = {
  createdAfter: isoInstant,
  createdBefore: isoInstant,
};

const LAW_FIRM_SORT_FIELDS = [
  'createdAt', 'updatedAt', 'name', 'planId', 'billingStatus',
  'storageUsedBytes', 'memberCount', 'matterCount', 'clientCount',
];

// Mirrors lawfirms.repository's LAW_FIRM_SORT_COLUMNS.
export const adminListLawFirmsSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    ...sorting(LAW_FIRM_SORT_FIELDS),
    search: z.string().max(500).optional(),
    planId: z.string().max(50).optional(),
    billingStatus: z.string().max(50).optional(),
  }),
});

const USER_SORT_FIELDS = [
  'createdAt', 'updatedAt', 'name', 'email', 'userType', 'isAdmin', 'lastLoginAt',
];

// Mirrors users.repository's USER_SORT_COLUMNS.
export const adminListUsersSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    ...sorting(USER_SORT_FIELDS),
    search: z.string().max(500).optional(),
    userType: z.enum(['firm_member', 'client', 'pending']).optional(),
    // Query strings carry no booleans, so the two literals are spelled out
    // rather than coerced — `z.coerce.boolean()` would read "false" as true.
    isAdmin: z.enum(['true', 'false']).optional(),
    lawFirmId: z.string().uuid().optional(),
    ...createdWindow,
  }),
});

const CLIENT_SORT_FIELDS = [
  'createdAt', 'name', 'email', 'status', 'joinedAt', 'invitedAt', 'lawFirmName', 'matterCount',
];

// Mirrors admin.repository's ADMIN_CLIENT_SORT_COLUMNS.
export const adminListClientsSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    ...sorting(CLIENT_SORT_FIELDS),
    search: z.string().max(500).optional(),
    lawFirmId: z.string().uuid().optional(),
    status: z.string().max(50).optional(),
    // Portal state is derived from user_id + portal_invite_pending, so the filter
    // names the state rather than a column.
    portal: z.enum(['linked', 'pending', 'none']).optional(),
    clientType: z.enum(['person', 'company']).optional(),
    ...createdWindow,
  }),
});

export const lookupLawFirmsSchema = z.object({
  query: z.object({
    search: z.string().max(500).optional(),
    // Comma-separated firm ids, used to resolve labels for an existing selection.
    ids: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
});
