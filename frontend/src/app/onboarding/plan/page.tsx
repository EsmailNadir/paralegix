"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ShieldCheck } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import userService from "@/services/users.service";
import subscriptionService from "@/services/subscription.service";
import { isBillingIncomplete } from "@/lib/plans/billingAccess";
import type {
  BillingInterval,
  SellablePlanId,
} from "@/types/subscription";
import Spinner from '@/components/ui/Spinner';
import SegmentedToggle from '@/components/ui/SegmentedToggle';
import { track } from "@/lib/analytics/analytics";

interface SellablePlan {
  id: SellablePlanId;
  name: string;
  description: string;
  monthly: number; // dollars
  annual: number; // dollars, billed yearly
  highlights: string[];
  featured?: boolean;
}

const PLANS: SellablePlan[] = [
  {
    id: "basic",
    name: "Basic",
    description: "For small firms getting organized.",
    monthly: 20,
    annual: 200,
    highlights: ["75 matters", "5 members", "3 GB storage", "Client portal & messaging"],
  },
  {
    id: "professional",
    name: "Professional",
    description: "For growing firms that need more.",
    monthly: 50,
    annual: 500,
    highlights: [
      "250 matters",
      "15 members",
      "10 GB storage",
      "Calendar sync, analytics & trust accounting",
    ],
    featured: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description: "For large firms with unlimited needs.",
    monthly: 100,
    annual: 1000,
    highlights: [
      "Unlimited matters & members",
      "50 GB storage",
      "Every feature included",
      "Document signing",
    ],
  },
];

function OnboardingPlanContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const firmIdParam = searchParams.get("firmId");
  const { user, loading: authLoading } = useAuth();

  const [resolving, setResolving] = useState(true);
  const [firmId, setFirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | Error | null>(null);
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [checkoutPlanId, setCheckoutPlanId] = useState<SellablePlanId | null>(null);

  // Resolve the firm to onboard: a single-firm user uses that firm; otherwise
  // pick the one that still needs checkout (billingStatus incomplete).
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }

    let active = true;

    const resolveFirm = async () => {
      setResolving(true);
      setError(null);
      try {
        // Arrived from create-firm or the lock screen with a known firm: use it
        // directly (checkout re-checks membership server-side, so trusting the
        // param is safe) and skip the firm-resolution scan.
        if (firmIdParam) {
          if (active) setFirmId(firmIdParam);
          return;
        }

        const { lawFirmIds = [] } = await userService.getMyLawFirms();

        if (!lawFirmIds.length) {
          if (active) router.replace("/dashboard");
          return;
        }

        if (lawFirmIds.length === 1) {
          if (active) setFirmId(lawFirmIds[0]);
          return;
        }

        // Multi-firm: find the incomplete one. If none, fall back to dashboard.
        for (const id of lawFirmIds) {
          try {
            const status = await subscriptionService.getStatus(id);
            if (isBillingIncomplete(status.billingStatus)) {
              if (active) setFirmId(id);
              return;
            }
          } catch {
            // Ignore a single firm's status failure and keep scanning.
          }
        }
        if (active) router.replace("/dashboard");
      } catch (err) {
        if (active) setError(err instanceof Error ? err : "Failed to load your firm.");
      } finally {
        if (active) setResolving(false);
      }
    };

    resolveFirm();
    return () => {
      active = false;
    };
  }, [authLoading, user, router, firmIdParam]);

  const handleSelect = useCallback(
    async (planId: SellablePlanId) => {
      if (!firmId || checkoutPlanId) return;
      setCheckoutPlanId(planId);
      setError(null);
      try {
        const { checkoutUrl } = await subscriptionService.createCheckout(
          firmId,
          planId,
          interval
        );
        // This page is outside the firm layout, so the firm is not registered
        // on events yet; name it here so checkout joins the per-firm funnel.
        track("checkout_started", { plan_id: planId, interval, law_firm_id: firmId });
        window.location.href = checkoutUrl;
      } catch (err) {
        setError(err instanceof Error ? err : "Failed to start checkout.");
        setCheckoutPlanId(null);
      }
    },
    [firmId, interval, checkoutPlanId]
  );

  const savingsNote = useMemo(
    () => (interval === "annual" ? "2 months free" : null),
    [interval]
  );

  if (authLoading || resolving) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-page px-4 py-10 md:py-16">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-center mb-8">
          <ParalegixLogo width={160} height={40} />
        </div>

        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-2xl md:text-3xl font-bold text-on-surface">
            Choose your plan
          </h1>
          <p className="text-sm text-on-surface-secondary mt-3">
            Your 14-day free trial started when you created your firm. Choosing a plan
            starts a paid subscription now.
          </p>
        </div>

        <div className="mt-6 max-w-2xl mx-auto">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>

        {/* Billing interval toggle */}
        <div className="mt-6 flex items-center justify-center">
          <SegmentedToggle
            ariaLabel="Billing interval"
            size="md"
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "annual", label: "Annual" },
            ]}
            value={interval}
            onChange={setInterval}
          />
          {savingsNote && (
            <span className="ml-3 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              {savingsNote}
            </span>
          )}
        </div>

        {/* Plan cards */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-5">
          {PLANS.map((plan) => {
            const price = interval === "annual" ? plan.annual : plan.monthly;
            const annualSavings = plan.monthly * 12 - plan.annual;
            const isLoadingThis = checkoutPlanId === plan.id;

            return (
              <div
                key={plan.id}
                className={`rounded-2xl border p-6 flex flex-col bg-surface ${
                  plan.featured
                    ? "border-accent-border-soft shadow-md"
                    : "border-outline-subtle shadow-sm"
                }`}
              >
                {plan.featured && (
                  <span className="self-start mb-3 inline-flex items-center rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-emphasis">
                    Most popular
                  </span>
                )}

                <h3 className="text-lg font-bold text-on-surface">{plan.name}</h3>
                <p className="text-sm text-on-surface-secondary mt-1">
                  {plan.description}
                </p>

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
                      Save ${annualSavings}/yr (${Math.round(plan.annual / 12)}/mo billed yearly)
                    </p>
                  )}
                </div>

                <ul className="space-y-2 mb-6 flex-1">
                  {plan.highlights.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <Check
                        size={15}
                        className="text-emerald-500 dark:text-emerald-400 flex-shrink-0 mt-0.5"
                      />
                      <span className="text-on-surface">{item}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSelect(plan.id)}
                  disabled={!!checkoutPlanId}
                  className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 ${
                    plan.featured
                      ? "bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground shadow-sm"
                      : "bg-surface hover:bg-surface-hover text-on-surface border border-outline-subtle"
                  }`}
                >
                  {isLoadingThis ? (
                    <Spinner size={16} className="mx-auto" />
                  ) : (
                    "Continue to checkout"
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Renewal terms, disclosed before checkout */}
        <div className="mt-8 flex items-start justify-center gap-2 text-sm text-on-surface-secondary">
          <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="max-w-xl text-center">
            The plan you choose is charged today and renews automatically
            {interval === "annual" ? " every year" : " every month"} at the price shown,
            until you cancel. Cancel any time from Settings, then Billing. Your plan stays
            active until the end of the period you already paid for.
          </span>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingPlanPage() {
  return (
    <Suspense fallback={<LoadingSpinner fullPage />}>
      <OnboardingPlanContent />
    </Suspense>
  );
}
