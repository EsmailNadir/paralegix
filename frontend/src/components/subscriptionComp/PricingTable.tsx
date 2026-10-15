"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import type {
  BillingInterval,
  PlanId,
  SubscriptionStatus,
} from "@/types/subscription";
import Spinner from '@/components/ui/Spinner';
import SegmentedToggle from '@/components/ui/SegmentedToggle';
import StatusBadge from '@/components/ui/StatusBadge';
import { billingStatusMeta } from '@/constants/statusMeta';
import { isTrialing } from '@/lib/plans/billingAccess';

const PLANS = [
  {
    id: "basic" as PlanId,
    name: "Basic",
    description: "For small firms that need more than the free tier",
    price: 20,
    annualPrice: 200,
    limits: { matters: "75", members: "5", storage: "3 GB" },
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
  },
  {
    id: "professional" as PlanId,
    name: "Professional",
    description: "For growing firms that need more",
    price: 50,
    annualPrice: 500,
    limits: { matters: "250", members: "15", storage: "10 GB" },
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
  },
  {
    id: "enterprise" as PlanId,
    name: "Enterprise",
    description: "For large firms with unlimited needs",
    price: 100,
    annualPrice: 1000,
    limits: { matters: "Unlimited", members: "Unlimited", storage: "50 GB" },
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
  },
];

const FEATURE_LABELS: Record<string, string> = {
  clientPortal: "Client Portal",
  messaging: "Messaging",
  calendarSync: "Calendar Sync",
  analytics: "Analytics",
  flatFees: "Flat Fees",
  fileSharing: "File Sharing",
  templates: "Templates",
  trustAccounting: "Trust Accounting",
  documentSigning: "Document Signing",
};

interface PricingTableProps {
  currentPlan: SubscriptionStatus | null;
  onSubscribe: (planId: PlanId, interval: BillingInterval) => void;
  onChangePlan: (planId: PlanId, interval: BillingInterval) => void;
  loading?: boolean;
  loadingPlanId?: PlanId | null;
}

// Explicit tier ranking so upgrade/downgrade still resolves when the firm's
// current plan (e.g. starter) isn't rendered as a sellable card.
const PLAN_RANK: Record<string, number> = {
  starter: 0,
  basic: 1,
  professional: 2,
  enterprise: 3,
};

export default function PricingTable({
  currentPlan,
  onSubscribe,
  onChangePlan,
  loading,
  loadingPlanId,
}: PricingTableProps) {
  const currentPlanId = currentPlan?.planId || "starter";
  const hasActiveSubscription = currentPlan?.stripeSubscriptionId != null;
  // Comped / unlimited-override firms are on a managed plan set by an admin. They
  // have no Stripe subscription, so a plan-card click would otherwise fall through
  // to a brand-new paid checkout (a "Downgrade" button that silently starts
  // charging). Lock the plan-change actions for these firms instead.
  const isManaged = !!(currentPlan?.comped || currentPlan?.unlimitedOverride);
  // A no-card trial parks the firm on a tier (`professional`) it has never paid
  // for. Treating that tier as the current plan disabled its card behind a
  // "Current Plan" button, which blocked the one thing a trialing firm comes
  // here to do: subscribe before the trial runs out. Every tier stays
  // purchasable during a trial; the trial tier is only badged and highlighted.
  const onTrial = isTrialing(currentPlan?.billingStatus) && !hasActiveSubscription;
  const trialBadge = billingStatusMeta(currentPlan?.billingStatus);
  const [interval, setInterval] = useState<BillingInterval>(
    currentPlan?.billingInterval || "monthly"
  );

  return (
    <div className="space-y-6">
      {/* Billing interval toggle */}
      <div className="flex items-center gap-3">
        <SegmentedToggle
          ariaLabel="Billing interval"
          options={[
            { value: "monthly", label: "Monthly" },
            { value: "annual", label: "Annual" },
          ]}
          value={interval}
          onChange={setInterval}
        />
        {interval === "annual" && (
          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            2 months free
          </span>
        )}
      </div>

      {isManaged && (
        <div className="rounded-xl border border-outline-subtle bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          Your firm is on a complimentary managed plan with full access. Contact
          support to change your plan.
        </div>
      )}

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {PLANS.map((plan) => {
          const isTrialTier = onTrial && plan.id === currentPlanId;
          const isCurrent = !onTrial && plan.id === currentPlanId;
          // Upgrade/downgrade only describe a move from a plan the firm holds.
          // On a trial every card is a first purchase, so they all read
          // "Subscribe" and the trial tier carries the primary styling.
          const isUpgrade = !onTrial && PLAN_RANK[plan.id] > PLAN_RANK[currentPlanId];
          const isDowngrade = !onTrial && PLAN_RANK[plan.id] < PLAN_RANK[currentPlanId];
          const isPrimaryCta = onTrial ? isTrialTier : isUpgrade;
          const isLoadingThis = loadingPlanId === plan.id;
          const price = interval === "annual" ? plan.annualPrice : plan.price;
          const annualSavings = plan.price * 12 - plan.annualPrice;

          return (
            <div
              key={plan.id}
              className={`rounded-xl border border-outline-subtle p-6 flex flex-col ${isCurrent || isTrialTier ? "bg-accent-soft" : "bg-surface"}`}
            >
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-on-surface">{plan.name}</h3>
                {isTrialTier && (
                  <StatusBadge variant={trialBadge.variant}>
                    {trialBadge.label}
                  </StatusBadge>
                )}
              </div>
              <p className="text-sm text-on-surface-secondary mt-1">
                {plan.description}
              </p>

              {/* Price */}
              <div className="mt-4 mb-5">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-on-surface">
                    ${price}
                  </span>
                  <span className="text-sm text-on-surface-muted">
                    {interval === "annual" ? "/yr" : "/mo"}
                  </span>
                </div>
                {interval === "annual" && annualSavings > 0 && (
                  <p className="mt-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    Save ${annualSavings}/yr (${Math.round(plan.annualPrice / 12)}/mo billed yearly)
                  </p>
                )}
              </div>

              {/* Limits */}
              <div className="space-y-2 mb-5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-on-surface-secondary">Matters</span>
                  <span className="font-medium text-on-surface">
                    {plan.limits.matters}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-on-surface-secondary">Members</span>
                  <span className="font-medium text-on-surface">
                    {plan.limits.members}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-on-surface-secondary">Storage</span>
                  <span className="font-medium text-on-surface">
                    {plan.limits.storage}
                  </span>
                </div>
              </div>

              {/* Features */}
              <div className="space-y-2 mb-6 flex-1">
                {Object.entries(plan.features).map(([key, enabled]) => (
                  <div key={key} className="flex items-center gap-2 text-sm">
                    {enabled ? (
                      <Check
                        size={14}
                        className="text-emerald-500 dark:text-emerald-400 flex-shrink-0"
                      />
                    ) : (
                      <X
                        size={14}
                        className="text-on-surface-muted flex-shrink-0"
                      />
                    )}
                    <span
                      className={
                        enabled
                          ? "text-on-surface"
                          : "text-on-surface-muted"
                      }
                    >
                      {FEATURE_LABELS[key] || key}
                    </span>
                  </div>
                ))}
              </div>

              {/* CTA */}
              {isCurrent ? (
                <button
                  disabled
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-surface-alt text-on-surface-muted border border-outline-subtle"
                >
                  {isManaged ? "Managed Plan" : "Current Plan"}
                </button>
              ) : isManaged ? (
                <button
                  disabled
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-surface-alt text-on-surface-muted border border-outline-subtle cursor-not-allowed"
                >
                  Unavailable
                </button>
              ) : (
                <button
                  onClick={() =>
                    hasActiveSubscription
                      ? onChangePlan(plan.id, interval)
                      : onSubscribe(plan.id, interval)
                  }
                  disabled={loading || isLoadingThis}
                  className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-[background-color,border-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 ${
                    isPrimaryCta
                      ? "bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground shadow-sm"
                      : "bg-surface hover:bg-surface-hover text-on-surface border border-outline-subtle"
                  }`}
                >
                  {isLoadingThis ? (
                    <Spinner size={16} className="mx-auto" />
                  ) : isUpgrade ? (
                    "Upgrade"
                  ) : isDowngrade ? (
                    "Downgrade"
                  ) : (
                    "Subscribe"
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
