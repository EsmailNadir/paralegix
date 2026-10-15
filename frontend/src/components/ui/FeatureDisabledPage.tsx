"use client";

import { ArrowLeft, Crown, Settings } from "lucide-react";
import { useParams } from "next/navigation";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { getPlanFeatures } from "@/lib/plans/featureAccess";
import StatusPage from "@/components/ui/StatusPage";
import type { FirmFeatures } from "@/types/preferences";

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

/**
 * Which plan first enables each feature.
 * Used to tell the user which plan they need to upgrade to.
 */
const FEATURE_REQUIRED_PLAN: Record<string, string> = {
  calendarSync: "Professional",
  analytics: "Professional",
  fileSharing: "Professional",
  templates: "Professional",
  trustAccounting: "Professional",
  documentSigning: "Professional",
};

/**
 * Why a feature is unavailable, which is TWO different answers.
 *
 * The plan may not include it, in which case the way forward is an upgrade. Or
 * the plan includes it and the firm switched it off for itself in billing
 * settings, in which case there is nothing to buy and the way forward is to
 * switch it back on. Reading the plan tells the two apart: the resolved feature
 * is false either way, so it cannot.
 *
 * Showing the upgrade screen for an opt-out sends someone to a pricing table
 * for a plan they are already on, which reads as a billing fault in the product.
 */
export default function FeatureDisabledPage({
  feature,
  title,
  description,
}: {
  feature: string;
  title?: string;
  description?: string;
}) {
  const label = FEATURE_LABELS[feature] || feature;
  const requiredPlan = FEATURE_REQUIRED_PLAN[feature] || "Professional";
  const params = useParams();
  const lawFirmId = params?.lawFirmId as string | undefined;
  const { navigate } = useNavigation();
  const { lawFirm } = useLawFirm();

  // The plan's own answer, not the resolved one. `RequireFeature` only renders
  // this page when the resolved feature is false, so a plan that still includes
  // it means the firm is the one that turned it off.
  const planIncludesIt = !!getPlanFeatures(lawFirm?.plan)[feature as keyof FirmFeatures];
  const billingSettings = `/lawfirm/${lawFirmId}/settings/billing`;

  if (planIncludesIt) {
    return (
      <StatusPage
        badge="Turned off"
        code="Switched off by your firm"
        Icon={Settings}
        title={title || `${label} is turned off for your firm`}
        description={
          description
          || `Your plan includes ${label}, but your firm has switched it off. Anyone who `
            + 'can manage firm settings can turn it back on under Features in billing '
            + 'settings. Nothing was deleted while it was off.'
        }
        primaryAction={
          lawFirmId
            ? {
                label: "Firm settings",
                onClick: () => navigate(billingSettings),
                icon: Settings,
              }
            : undefined
        }
        secondaryAction={{
          label: "Back to dashboard",
          href: "/dashboard",
        }}
      />
    );
  }

  return (
    <StatusPage
      badge="Upgrade required"
      code={`Available on ${requiredPlan}`}
      Icon={Crown}
      title={title || `${label} is not available on your current plan`}
      description={
        description || `${label} is included with the ${requiredPlan} plan and above.`
      }
      primaryAction={
        lawFirmId
          ? {
              label: "View Plans",
              onClick: () => navigate(billingSettings),
              icon: Crown,
            }
          : {
              label: "Go back",
              onClick: () => {
                if (typeof window !== "undefined") {
                  window.history.back();
                }
              },
              icon: ArrowLeft,
            }
      }
      secondaryAction={{
        label: "Back to dashboard",
        href: "/dashboard",
      }}
    />
  );
}
