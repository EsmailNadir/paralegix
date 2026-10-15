"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle } from "lucide-react";
import subscriptionService from "@/services/subscription.service";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { isBillingActive } from "@/lib/plans/billingAccess";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import SubscriptionStatusCard from "@/components/subscriptionComp/SubscriptionStatus";
import PricingTable from "@/components/subscriptionComp/PricingTable";
import FirmFeatureToggles from "@/components/settingsComp/FirmFeatureToggles";
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type {
  SubscriptionStatus,
  PlanId,
  BillingInterval,
} from "@/types/subscription";
import Spinner from '@/components/ui/Spinner';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';

export default function BillingSettingsPage() {
  const { hasPermission, loading } = usePermissions();
  if (loading) return <PanelLoadingSpinner label="Loading subscriptions" />;
  if (!hasPermission("settings.manageFirm")) {
    return <ErrorNotification error="Contact your firm administrator to manage subscription and billing." />;
  }
  return <BillingManagementPage />;
}

function BillingManagementPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const { subscriptionStatus: contextStatus, subscriptionStatusLoaded, refetchLawFirm } = useLawFirm();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [subscribing, setSubscribing] = useState(false);
  const [loadingPlanId, setLoadingPlanId] = useState<PlanId | null>(null);
  const [managingPayment, setManagingPayment] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDowngradeConfirm, setShowDowngradeConfirm] = useState<{
    planId: PlanId;
    interval: BillingInterval;
  } | null>(null);

  const sessionStatus = searchParams?.get("status");
  // After a Stripe checkout redirect (?status=success) the webhook that flips
  // the subscription to active/trialing can lag the redirect. Poll until the
  // subscription is confirmed rather than showing a half-provisioned state.
  const [confirming, setConfirming] = useState(sessionStatus === "success");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!lawFirmId) return;
    try {
      setLoading(true);
      const data = await subscriptionService.getStatus(lawFirmId);
      setStatus(data);
    } catch (err) {
      setError(
        getErrorMessage(err, "Failed to load subscription")
      );
    } finally {
      setLoading(false);
    }
  }, [lawFirmId]);

  // Seed from the shell's already-resolved subscription status (LawFirmContext)
  // instead of issuing a duplicate /subscriptions/status request on mount. Only
  // fetch directly if the shell resolved without a status (its request failed).
  useEffect(() => {
    if (!subscriptionStatusLoaded) return;
    if (contextStatus) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds from shared context (external source) once the shell has resolved
      setStatus(contextStatus);
      setLoading(false);
    } else {
      fetchStatus();
    }
  }, [subscriptionStatusLoaded, contextStatus, fetchStatus]);

  // Checkout-return polling: every ~2s (max ~60s) until the subscription is
  // provisioned (stripeSubscriptionId present or billingStatus active/trialing).
  useEffect(() => {
    if (sessionStatus !== "success" || !lawFirmId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the checkout-return polling flag when there's no success session to poll
      setConfirming(false);
      return;
    }

    let cancelled = false;
    const deadline = Date.now() + 60_000;

    const poll = async () => {
      try {
        const data = await subscriptionService.getStatus(lawFirmId);
        if (cancelled) return;
        setStatus(data);
        const provisioned =
          data.stripeSubscriptionId != null ||
          isBillingActive({ billingStatus: data.billingStatus });
        if (provisioned || Date.now() >= deadline) {
          setConfirming(false);
          return;
        }
      } catch {
        if (cancelled) return;
        if (Date.now() >= deadline) {
          setConfirming(false);
          return;
        }
      }
      pollRef.current = setTimeout(poll, 2000);
    };

    setConfirming(true);
    poll();

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [sessionStatus, lawFirmId]);

  // A plan change, cancellation or reactivation also changes the firm record
  // the shell holds (its plan, and the features derived from it), so both are
  // re-read; otherwise the sidebar keeps the old plan's features until a reload.
  const refreshAfterChange = useCallback(
    () => Promise.all([fetchStatus(), refetchLawFirm()]),
    [fetchStatus, refetchLawFirm],
  );

  const handleSubscribe = async (planId: PlanId, interval: BillingInterval) => {
    try {
      setSubscribing(true);
      setLoadingPlanId(planId);
      setError(null);
      const { checkoutUrl } = await subscriptionService.createCheckout(
        lawFirmId,
        planId,
        interval
      );
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(getErrorMessage(err, "Failed to start checkout"));
      setSubscribing(false);
      setLoadingPlanId(null);
    }
  };

  const handleChangePlan = async (
    planId: PlanId,
    interval: BillingInterval
  ) => {
    // Check if this is a downgrade
    const planOrder: Record<string, number> = {
      starter: 0,
      basic: 1,
      professional: 2,
      enterprise: 3,
    };
    if (status && planOrder[planId] < planOrder[status.planId]) {
      setShowDowngradeConfirm({ planId, interval });
      return;
    }

    // If it's starter and no subscription, need checkout
    if (planId !== "starter" && !status?.stripeSubscriptionId) {
      handleSubscribe(planId, interval);
      return;
    }

    try {
      setLoadingPlanId(planId);
      setError(null);
      await subscriptionService.changePlan(lawFirmId, planId, interval);
      await refreshAfterChange();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to change plan"));
    } finally {
      setLoadingPlanId(null);
    }
  };

  const confirmDowngrade = async () => {
    if (!showDowngradeConfirm) return;
    const { planId, interval } = showDowngradeConfirm;
    setShowDowngradeConfirm(null);

    try {
      setLoadingPlanId(planId);
      setError(null);
      await subscriptionService.changePlan(lawFirmId, planId, interval);
      await refreshAfterChange();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to downgrade plan"));
    } finally {
      setLoadingPlanId(null);
    }
  };

  const handleManagePayment = async () => {
    try {
      setManagingPayment(true);
      setError(null);
      const { portalUrl } = await subscriptionService.createPortalSession(
        lawFirmId
      );
      window.location.href = portalUrl;
    } catch (err) {
      setError(
        getErrorMessage(err, "Failed to open payment portal")
      );
      setManagingPayment(false);
    }
  };

  const handleCancel = async () => {
    setShowCancelConfirm(false);
    try {
      setCancelling(true);
      setError(null);
      await subscriptionService.cancel(lawFirmId);
      await refreshAfterChange();
    } catch (err) {
      setError(
        getErrorMessage(err, "Failed to cancel subscription")
      );
    } finally {
      setCancelling(false);
    }
  };

  const handleReactivate = async () => {
    try {
      setReactivating(true);
      setError(null);
      await subscriptionService.reactivate(lawFirmId);
      await refreshAfterChange();
    } catch (err) {
      setError(
        getErrorMessage(err, "Failed to reactivate subscription")
      );
    } finally {
      setReactivating(false);
    }
  };

  if (loading) {
    return <PanelLoadingSpinner label="Loading subscriptions" />;
  }

  return (
    <div className="px-6 py-6 space-y-8">
      {error && (
        <ErrorNotification error={error} onClose={() => setError(null)} />
      )}

      {/* Checkout-return banner */}
      {sessionStatus === "success" && confirming && (
        <div className="bg-accent-soft dark:bg-accent-soft rounded-xl border border-accent-border-soft dark:border-accent-border-soft p-4 flex items-center gap-3">
          <Spinner size={20} className="text-accent-emphasis flex-shrink-0" />
          <p className="text-sm font-medium text-accent-emphasis dark:text-accent-emphasis">
            Confirming your subscription…
          </p>
        </div>
      )}
      {sessionStatus === "success" && !confirming && (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-200 dark:border-emerald-500/20 p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Your subscription is active.
          </p>
        </div>
      )}

      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-on-surface">
          Subscription & Billing
        </h2>
        <p className="text-sm text-on-surface-secondary mt-1">
          Manage your firm&apos;s plan, usage, and billing.
        </p>
      </div>

      {/* Current plan status */}
      {status && (
        <SubscriptionStatusCard
          status={status}
          onManagePayment={handleManagePayment}
          onCancel={() => setShowCancelConfirm(true)}
          onReactivate={handleReactivate}
          managingPayment={managingPayment}
          cancelling={cancelling}
          reactivating={reactivating}
        />
      )}

      {/* Pricing table */}
      <div>
        <h3 className="text-base font-semibold text-on-surface mb-4">
          {status?.stripeSubscriptionId ? "Change Plan" : "Choose a Plan"}
        </h3>
        <PricingTable
          currentPlan={status}
          onSubscribe={handleSubscribe}
          onChangePlan={handleChangePlan}
          loading={subscribing}
          loadingPlanId={loadingPlanId}
        />
      </div>

      {/* Per-firm feature opt-outs. Below the pricing table on purpose: the table
          answers "what does my plan include", and this answers "which of those do
          we actually use", which only makes sense once the first is settled. */}
      <FirmFeatureToggles />

      {/* Cancel confirmation */}
      <ConfirmModal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={handleCancel}
        title="Cancel Subscription"
        message={`Your plan stays active until ${status?.currentPeriodEnd ? new Date(status.currentPeriodEnd).toLocaleDateString() : "the end of your billing period"}, and you will not be charged again. After that date the workspace is paused until you choose a plan. Your firm's data is kept. You can reactivate any time before then.`}
        confirmText="Cancel Subscription"
        confirmType="danger"
      />

      {/* Downgrade confirmation */}
      <ConfirmModal
        isOpen={!!showDowngradeConfirm}
        onClose={() => setShowDowngradeConfirm(null)}
        onConfirm={confirmDowngrade}
        title="Downgrade Plan"
        message={`You'll be switched to the ${showDowngradeConfirm?.planId ? showDowngradeConfirm.planId.charAt(0).toUpperCase() + showDowngradeConfirm.planId.slice(1) : ""} plan. You'll receive a prorated credit for the remainder of your current billing period. Existing data won't be deleted, but you won't be able to create new items beyond the lower plan's limits.`}
        confirmText="Confirm Downgrade"
        confirmType="danger"
      />
    </div>
  );
}
