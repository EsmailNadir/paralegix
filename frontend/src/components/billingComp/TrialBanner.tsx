"use client";

import { Clock } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import { isTrialing } from "@/lib/plans/billingAccess";
import type { BillingStatus } from "@/types/subscription";

interface TrialBannerProps {
  lawFirmId: string;
  billingStatus?: BillingStatus | string | null;
  trialEndsAt?: string | null;
}

/** Whole days remaining until `trialEndsAt`, floored at 0. */
function daysLeft(trialEndsAt?: string | null): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (Number.isNaN(end)) return null;
  const ms = end - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/** Compact trial notice shown above the account row in the firm sidebar. */
export default function TrialBanner({
  lawFirmId,
  billingStatus,
  trialEndsAt,
}: TrialBannerProps) {
  const { navigate } = useNavigation();

  if (!isTrialing(billingStatus)) return null;

  const days = daysLeft(trialEndsAt);
  const label =
    days === null
      ? "You're on a free trial"
      : days <= 0
        // `daysLeft` returns 0 only once the end date has PASSED (the last live
        // day rounds up to 1), so this is a trial that is over, not one ending.
        ? "Your trial has ended"
        : days === 1
          ? "1 day left in your trial"
          : `${days} days left in your trial`;

  return (
    <div className="bg-accent-soft px-4 py-3 text-xs text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 size-3.5 flex-shrink-0" />
        <span className="font-medium leading-5">{label}.</span>
      </div>
      <button
        onClick={() => navigate(`/lawfirm/${lawFirmId}/settings/billing`)}
        className="mt-1 ml-5.5 font-semibold underline underline-offset-2 hover:text-accent-emphasis dark:hover:text-accent-emphasis cursor-pointer"
      >
        Manage subscription
      </button>
    </div>
  );
}
