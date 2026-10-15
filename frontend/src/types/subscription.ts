export type PlanId = "starter" | "basic" | "professional" | "enterprise";
export type BillingStatus =
  | "active"
  | "trial"
  | "trialing"
  | "comped"
  | "past_due"
  | "suspended"
  | "incomplete"
  | "canceled";
export type BillingInterval = "monthly" | "annual";

/** Sellable tiers in the checkout/plan picker. Starter is not sellable (no free tier). */
export type SellablePlanId = "basic" | "professional" | "enterprise";

export interface PlanFeatures {
  clientPortal: boolean;
  messaging: boolean;
  calendarSync: boolean;
  analytics: boolean;
  flatFees: boolean;
  fileSharing: boolean;
  templates: boolean;
  trustAccounting: boolean;
  documentSigning: boolean;
}

export interface UsageMetric {
  current: number;
  limit: number; // -1 = unlimited
}

/**
 * Seat usage. `current` is what the plan limit is enforced against - members
 * plus outstanding member invitations - so it can exceed `activeMembers`.
 */
export interface SeatUsageMetric extends UsageMetric {
  activeMembers: number;
  pendingInvites: number;
}

export interface SubscriptionStatus {
  planId: PlanId;
  planName: string;
  billingStatus: BillingStatus;
  billingInterval: BillingInterval | null;
  comped: boolean;
  unlimitedOverride: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  trialEndsAt: string | null;
  /** The firm owner, for the paywall to name when the reader cannot pay themselves. */
  owner: { name: string | null; email: string | null } | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  usage: {
    matters: UsageMetric;
    members: SeatUsageMetric;
    storage: {
      currentBytes: number;
      limitBytes: number;
    };
  };
  features: PlanFeatures;
  pricing: {
    monthly: number;
    annual: number;
  };
}

export interface CheckoutResponse {
  checkoutUrl: string;
  sessionId: string;
}

export interface PortalResponse {
  portalUrl: string;
}

export interface PlanLimitErrorDetails {
  resource: string;
  current: number;
  limit: number;
  planId: PlanId;
}
