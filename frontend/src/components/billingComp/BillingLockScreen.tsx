"use client";

import { Lock, Mail, ShieldCheck } from "lucide-react";
import Button from "@/components/ui/Button";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { isBillingIncomplete, isTrialing } from "@/lib/plans/billingAccess";
import { formatDate } from "@/lib/utils/dateUtils";
import type { BillingStatus } from "@/types/subscription";

/** Where a reader writes when the paywall itself is the problem. */
const SUPPORT_EMAIL = "contact@paralegix.com";

interface BillingLockScreenProps {
  lawFirmId: string;
  billingStatus?: BillingStatus | string | null;
  firmName?: string;
  /** Plan the firm was on, so the reader knows what they are restoring. */
  planName?: string | null;
  /** End of a trial, shown for the trial state. */
  trialEndsAt?: string | null;
  /** End of the last paid period, shown for the canceled state. */
  currentPeriodEnd?: string | null;
  /** Firm owner, named for a reader who cannot pay themselves. */
  owner?: { name: string | null; email: string | null } | null;
}

/**
 * The five states this screen answers. `paused` is the fallback for a status the
 * client does not recognize: the firm is locked, and saying so plainly beats
 * guessing at a reason. Every other branch names a cause the reader can act on.
 */
type LockState = "incomplete" | "trial_expired" | "past_due" | "canceled" | "paused";

function lockStateFor(billingStatus?: BillingStatus | string | null): LockState {
  if (isBillingIncomplete(billingStatus)) return "incomplete";
  // This screen only renders when the firm is locked, so a stored 'trialing'
  // here means the trial ran out rather than that it is running.
  if (isTrialing(billingStatus)) return "trial_expired";
  const status = (billingStatus || "").toString().toLowerCase();
  if (status === "past_due") return "past_due";
  if (status === "canceled") return "canceled";
  return "paused";
}

interface LockCopy {
  heading: string;
  subheading: string;
  primaryLabel: string;
  primaryTarget: "plans" | "billing";
  secondaryLabel?: string;
  secondaryTarget?: "plans" | "billing";
}

const LOCK_COPY: Record<LockState, LockCopy> = {
  incomplete: {
    heading: "Start your subscription",
    subheading: "Choose a plan to unlock your firm's workspace.",
    primaryLabel: "Choose a plan",
    primaryTarget: "plans",
  },
  trial_expired: {
    heading: "Your trial has ended",
    subheading: "Your free trial is over and the workspace is paused.",
    primaryLabel: "Choose a plan",
    primaryTarget: "plans",
    secondaryLabel: "Billing settings",
    secondaryTarget: "billing",
  },
  past_due: {
    heading: "A payment didn't go through",
    subheading: "We couldn't process your latest payment, so the workspace is paused.",
    primaryLabel: "Update payment method",
    primaryTarget: "billing",
    secondaryLabel: "Choose a different plan",
    secondaryTarget: "plans",
  },
  canceled: {
    heading: "Your subscription has ended",
    subheading: "Your subscription is no longer active and the workspace is paused.",
    primaryLabel: "Restart subscription",
    primaryTarget: "plans",
    secondaryLabel: "Billing settings",
    secondaryTarget: "billing",
  },
  paused: {
    heading: "Your workspace is paused",
    subheading: "This firm's subscription is not active.",
    primaryLabel: "Open billing settings",
    primaryTarget: "billing",
  },
};

/**
 * The date the workspace closed, for the states that have one. A trial closes on
 * its end date; a canceled subscription closes at the end of the period already
 * paid for. `past_due` has no such date (Stripe decides when the retries stop),
 * so it renders none rather than an invented one.
 */
function pausedOnFor(
  state: LockState,
  trialEndsAt?: string | null,
  currentPeriodEnd?: string | null,
): string | null {
  const value = state === "trial_expired" ? trialEndsAt : state === "canceled" ? currentPeriodEnd : null;
  if (!value) return null;
  const formatted = formatDate(value, "");
  if (!formatted) return null;
  return state === "trial_expired"
    ? `Your trial ended on ${formatted}.`
    : `Access ended on ${formatted}.`;
}

/**
 * Full-screen paywall shown in place of the workspace when a firm's billing is
 * inactive. The CTA branches on billing permission: an owner/billing-permitted
 * user gets a payment action, everyone else is pointed at the firm owner by
 * name. Either way it reassures that firm data is preserved.
 */
export default function BillingLockScreen({
  lawFirmId,
  billingStatus,
  firmName,
  planName,
  trialEndsAt,
  currentPeriodEnd,
  owner,
}: BillingLockScreenProps) {
  const { hasPermission, isOwner, loading } = usePermissions();
  const { navigate } = useNavigation();

  // Same permission the settings/billing area checks to grant subscription control.
  const canManageBilling = isOwner || hasPermission("settings.manageFirm");
  const state = lockStateFor(billingStatus);
  const copy = LOCK_COPY[state];
  const pausedOn = pausedOnFor(state, trialEndsAt, currentPeriodEnd);

  const go = (target: "plans" | "billing") => {
    navigate(
      target === "plans"
        ? `/onboarding/plan?firmId=${lawFirmId}`
        : `/lawfirm/${lawFirmId}/settings/billing`,
    );
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-surface rounded-2xl border border-outline-subtle shadow-sm p-8 text-center">
        <div className="flex justify-center mb-6">
          <ParalegixLogo width={150} height={38} />
        </div>

        <div className="w-14 h-14 rounded-2xl bg-accent-soft dark:bg-accent-soft mx-auto flex items-center justify-center mb-5">
          <Lock className="w-7 h-7 text-accent-emphasis" />
        </div>

        <h1 className="text-xl font-bold text-on-surface">{copy.heading}</h1>
        {(firmName || planName) && (
          <p className="text-sm text-on-surface-muted mt-1">
            {[firmName, planName ? `${planName} plan` : null].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className="text-sm text-on-surface-secondary mt-3">
          {copy.subheading}
          {pausedOn ? ` ${pausedOn}` : ""}
        </p>

        {/* Data-safety reassurance */}
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 px-4 py-3 text-left">
          <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-emerald-800 dark:text-emerald-300">
            Your data is safe and preserved. Nothing has been deleted. Everything
            returns exactly as you left it once the subscription is active again.
          </p>
        </div>

        {/* CTA branches on billing permission */}
        <div className="mt-7">
          {loading ? null : canManageBilling ? (
            <button
              onClick={() => go(copy.primaryTarget)}
              className="w-full py-2.5 rounded-xl text-sm font-semibold bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground shadow-sm transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 cursor-pointer"
            >
              {copy.primaryLabel}
            </button>
          ) : (
            <div className="rounded-xl border border-outline-subtle bg-surface-alt px-4 py-3 text-left">
              <p className="text-sm text-on-surface-secondary">
                {owner?.name
                  ? `${owner.name} owns this firm and can restore the subscription.`
                  : "Your firm owner needs to update the subscription."}
              </p>
              {owner?.email && (
                <a
                  href={`mailto:${owner.email}`}
                  className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-accent-emphasis hover:underline"
                >
                  <Mail className="w-4 h-4" />
                  {owner.email}
                </a>
              )}
            </div>
          )}
        </div>

        {!loading && canManageBilling && copy.secondaryLabel && copy.secondaryTarget && (
          <div className="mt-3">
            <Button
              type="secondary"
              onClick={() => go(copy.secondaryTarget!)}
              className="w-full"
            >
              {copy.secondaryLabel}
            </Button>
          </div>
        )}

        <p className="mt-6 text-xs text-on-surface-muted">
          Need help?{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-accent-emphasis hover:underline"
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </div>
  );
}
