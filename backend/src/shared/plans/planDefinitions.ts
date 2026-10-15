export const DEFAULT_PLAN_ID = 'starter';

export const PLAN_TIERS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'For solo practitioners and small practices getting started',
    limits: {
      maxMatters: 25,
      maxMembers: 3,
      storageQuotaBytes: 1073741824, // 1 GB
      maxFileSizeBytes: 104857600, // 100 MB per file
    },
    features: {
      clientPortal: true,
      messaging: true,
      calendarSync: false,
      analytics: false,
      flatFees: true,
      fileSharing: true,
      templates: false,
      trustAccounting: false,
      documentSigning: false,
    },
    pricing: {
      monthly: 0,
      annual: 0,
    },
    sortOrder: 0,
  },
  basic: {
    id: 'basic',
    name: 'Basic',
    description: 'For small firms that need more than the free tier',
    limits: {
      maxMatters: 75,
      maxMembers: 5,
      storageQuotaBytes: 3221225472, // 3 GB
      maxFileSizeBytes: 524288000, // 500 MB per file
    },
    features: {
      clientPortal: true,
      messaging: true,
      calendarSync: false,
      analytics: false,
      flatFees: true,
      fileSharing: true,
      templates: false,
      trustAccounting: false,
      documentSigning: false,
    },
    pricing: {
      monthly: 2000, // cents ($20/mo)
      annual: 20000, // cents ($200/yr — 2 months free)
    },
    sortOrder: 1,
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    description: 'For growing firms that need more power and integrations',
    limits: {
      maxMatters: 250,
      maxMembers: 15,
      storageQuotaBytes: 10737418240, // 10 GB
      maxFileSizeBytes: 3221225472, // 3 GB per file
    },
    features: {
      clientPortal: true,
      messaging: true,
      calendarSync: true,
      analytics: true,
      flatFees: true,
      fileSharing: true,
      templates: true,
      trustAccounting: true,
      documentSigning: true,
    },
    pricing: {
      monthly: 5000, // cents ($50/mo)
      annual: 50000, // cents ($500/yr — 2 months free)
    },
    sortOrder: 2,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For large firms with unlimited needs and premium support',
    limits: {
      maxMatters: -1, // unlimited
      maxMembers: -1, // unlimited
      storageQuotaBytes: 53687091200, // 50 GB
      maxFileSizeBytes: 10737418240, // 10 GB per file
    },
    features: {
      clientPortal: true,
      messaging: true,
      calendarSync: true,
      analytics: true,
      flatFees: true,
      fileSharing: true,
      templates: true,
      trustAccounting: true,
      documentSigning: true,
    },
    pricing: {
      monthly: 10000, // cents ($100/mo)
      annual: 100000, // cents ($1000/yr — 2 months free)
    },
    sortOrder: 3,
  },
};

export const UNLIMITED = -1;

/**
 * Resolve a plan tier by id.
 *
 * A persisted planId that no longer resolves (renamed/removed tier, typo, bad
 * migration) is a MISCONFIGURATION, not a normal fallback: silently returning
 * Starter would DOWNGRADE live firms (fewer limits/features) without anyone
 * noticing. We keep request handling functional by falling back to the default
 * tier, but log loudly so the misconfiguration is visible. A missing/empty
 * planId (never persisted) is the legitimate default matter and is not logged.
 */
export type PlanId = keyof typeof PLAN_TIERS;
export type PlanTier = (typeof PLAN_TIERS)[PlanId];

/** A law firm row, as far as the plan helpers read it. */
export interface PlanBearingFirm {
  plan?: {
    unlimitedOverride?: boolean;
    planId?: string | null;
    limitOverrides?: Record<string, number | undefined>;
    featureOverrides?: Record<string, boolean | undefined>;
    [key: string]: unknown;
  };
  plan_id?: string | null;
  planId?: string | null;
  [key: string]: unknown;
}

export function getPlanById(planId?: string | null): PlanTier {
  const tiers = PLAN_TIERS as Record<string, PlanTier | undefined>;
  const hit = planId != null ? tiers[planId] : undefined;
  if (hit) return hit;

  if (planId != null && planId !== '') {
    console.error(
      `[plans] Unknown planId "${planId}" did not resolve to a tier; ` +
        `falling back to "${DEFAULT_PLAN_ID}". This is a misconfiguration ` +
        `(renamed/removed tier or bad data) and may silently downgrade a firm. Investigate.`
    );
  }

  return PLAN_TIERS[DEFAULT_PLAN_ID];
}

/**
 * Assert that the DEFAULT_PLAN_ID exists in PLAN_TIERS. Runs once at module load
 * (see the call below) so a renamed default tier or a key/id mismatch fails
 * loudly at boot rather than surfacing as a wrong plan on some later request.
 */
export function assertPlanTiersValid() {
  if (!PLAN_TIERS[DEFAULT_PLAN_ID]) {
    throw new Error(
      `[plans] DEFAULT_PLAN_ID "${DEFAULT_PLAN_ID}" is not a valid PLAN_TIERS key`
    );
  }
  for (const [key, tier] of Object.entries(PLAN_TIERS)) {
    if (tier.id !== key) {
      throw new Error(`[plans] PLAN_TIERS key "${key}" does not match tier.id "${tier.id}"`);
    }
  }
  return true;
}

// The config is a code constant, so validating it at load costs nothing and
// turns a typo into a boot failure instead of a silently wrong plan.
assertPlanTiersValid();

export function getAllPlans() {
  return Object.values(PLAN_TIERS).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The caps in force for a firm.
 *
 * `unlimitedOverride` lifts them; `comped` deliberately does NOT and is absent
 * here on purpose. Comping is a billing fact ("free at your tier"), not an
 * entitlement one, and the admin action that sets it picks a plan. See the note
 * beside BILLING_ACTIVE_STATUSES in planEnforcement.ts for the full reasoning.
 */
export function getEffectiveLimits(lawFirmData?: PlanBearingFirm) {
  if (lawFirmData?.plan?.unlimitedOverride) {
    const overrides = lawFirmData?.plan?.limitOverrides || {};
    return {
      maxMatters: UNLIMITED,
      maxMembers: UNLIMITED,
      storageQuotaBytes: overrides.storageQuotaBytes ?? 53687091200, // 50 GB cap even for unlimited
      maxFileSizeBytes: overrides.maxFileSizeBytes ?? 10737418240, // 10 GB per file
    };
  }

  const planId = lawFirmData?.plan?.planId || DEFAULT_PLAN_ID;
  const plan = getPlanById(planId);
  const overrides = lawFirmData?.plan?.limitOverrides || {};

  return {
    maxMatters: overrides.maxMatters ?? plan.limits.maxMatters,
    maxMembers: overrides.maxMembers ?? plan.limits.maxMembers,
    storageQuotaBytes: overrides.storageQuotaBytes ?? plan.limits.storageQuotaBytes,
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? plan.limits.maxFileSizeBytes,
  };
}

export function getEffectiveFeatures(lawFirmData?: PlanBearingFirm) {
  if (lawFirmData?.plan?.unlimitedOverride) {
    return {
      clientPortal: true,
      messaging: true,
      calendarSync: true,
      analytics: true,
      flatFees: true,
      fileSharing: true,
      templates: true,
      trustAccounting: true,
      documentSigning: true,
    };
  }

  const planId = lawFirmData?.plan?.planId || DEFAULT_PLAN_ID;
  const plan = getPlanById(planId);
  const overrides = lawFirmData?.plan?.featureOverrides || {};

  return { ...plan.features, ...overrides };
}
