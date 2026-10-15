import type { FirmFeatures } from "@/types/preferences";
import type { PlanId } from "@/types/subscription";
import { DEFAULT_FIRM_FEATURES } from "@/types/preferences";

type PlanLike = {
  planId?: PlanId;
  unlimitedOverride?: boolean;
  featureOverrides?: Partial<FirmFeatures>;
} | null | undefined;

const PLAN_FEATURES: Record<PlanId, FirmFeatures> = {
  starter: {
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
  basic: {
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
  professional: { ...DEFAULT_FIRM_FEATURES },
  enterprise: { ...DEFAULT_FIRM_FEATURES },
};

export function getPlanFeatures(plan: PlanLike): FirmFeatures {
  if (plan?.unlimitedOverride) {
    return { ...DEFAULT_FIRM_FEATURES };
  }

  const planId = plan?.planId || "starter";
  return {
    ...PLAN_FEATURES[planId],
    ...(plan?.featureOverrides || {}),
  };
}

/**
 * The features a firm can actually use, resolved the way the API resolves them.
 *
 * Mirrors the backend `featureCheck.isFeatureEnabled`: the plan is the ceiling,
 * and on top of it a firm may switch a plan-allowed feature OFF for itself
 * (`settings.features.<key> === false`, written by the firm-settings feature
 * route). Only an explicit `false` subtracts. A missing key, or any other value,
 * leaves the plan's answer alone, so a stored `true` can never grant a feature
 * the plan lacks.
 *
 * Use this wherever the UI decides what to render. `getPlanFeatures` alone
 * answers a different question (what the plan sells) and reading it as this one
 * is what let a firm's own opt-out show up in the sidebar while every route for
 * it answered 403.
 */
export function resolveFirmFeatures(
  plan: PlanLike,
  settings?: { features?: Partial<Record<keyof FirmFeatures, unknown>> } | null,
): FirmFeatures {
  const planFeatures = getPlanFeatures(plan);
  const optOuts = settings?.features;
  if (!optOuts) return planFeatures;

  const resolved = { ...planFeatures };
  (Object.keys(resolved) as Array<keyof FirmFeatures>).forEach((key) => {
    if (optOuts[key] === false) resolved[key] = false;
  });
  return resolved;
}
