import type { BillingStatus } from "@/types/subscription";

/**
 * Shared billing-access logic. The backend gates every firm DATA route with a
 * 402 (`BILLING_INACTIVE`) when a firm is not active/trialing/comped; the
 * frontend mirrors that decision here so the lock screen, redirect, and layout
 * guard all agree on what "locked" means.
 *
 * Access granted: comped | active | trialing (jsonb may say `trial`).
 * Locked: incomplete | past_due | canceled (and anything unrecognized).
 *
 * A trial is the one status whose stored value is not the whole answer: a
 * no-card trial keeps `billingStatus: 'trialing'` after its end date, and only
 * `trialEndsAt` says it is over. The backend expires it that way
 * (`isFirmBillingActive` in shared/plans/planEnforcement.ts), so this file must
 * too. Without the date check the two gates disagree for the whole tail of a
 * lapsed trial: the workspace renders and every page inside it fails with a 402.
 */

/** Statuses that keep the workspace open. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "comped",
  "active",
  "trialing",
  "trial",
]);

export interface BillingGateInput {
  billingStatus?: BillingStatus | string | null;
  comped?: boolean;
  unlimitedOverride?: boolean;
  /** ISO end of a trial, from the subscription status endpoint or the plan jsonb. */
  trialEndsAt?: string | null;
  /** Present only once Stripe tracks the trial; then Stripe, not the date, ends it. */
  stripeSubscriptionId?: string | null;
}

/** Normalize `trial` → `trialing` so callers only branch on one value. */
export function isTrialing(billingStatus?: BillingStatus | string | null): boolean {
  const status = (billingStatus || "").toString().toLowerCase();
  return status === "trialing";
}

/**
 * True when a no-card trial has run past `trialEndsAt`.
 *
 * A Stripe-tracked trial (one carrying `stripeSubscriptionId`) is left alone:
 * Stripe moves it to `active` or `past_due` by webhook, and treating its date as
 * authoritative would lock a firm that has already paid. A trial with no end
 * date is treated as live, which is the backend's answer for the same input.
 */
export function isTrialExpired(input: BillingGateInput | null | undefined): boolean {
  if (!input) return false;
  if (!isTrialing(input.billingStatus)) return false;
  if (input.stripeSubscriptionId) return false;
  if (!input.trialEndsAt) return false;
  const endsAt = new Date(input.trialEndsAt).getTime();
  if (Number.isNaN(endsAt)) return false;
  return endsAt <= Date.now();
}

/** True when the firm's workspace should be accessible. */
export function isBillingActive(input: BillingGateInput | null | undefined): boolean {
  if (!input) return false;
  if (input.comped || input.unlimitedOverride) return true;
  const status = (input.billingStatus || "").toString().toLowerCase();
  if (!ACTIVE_STATUSES.has(status)) return false;
  return !isTrialExpired(input);
}

/** True when the workspace should be hard-locked behind the paywall. */
export function isBillingLocked(input: BillingGateInput | null | undefined): boolean {
  return !isBillingActive(input);
}

/** True when the firm has never completed checkout (needs onboarding). */
export function isBillingIncomplete(
  billingStatus?: BillingStatus | string | null,
): boolean {
  return (billingStatus || "").toString().toLowerCase() === "incomplete";
}
