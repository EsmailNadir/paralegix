"use client";

import { useRef } from "react";
import { ArrowUpRight, Crown, X } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import Modal from "@/components/ui/Modal";
import type { PlanLimitErrorDetails } from "@/types/subscription";

const RESOURCE_LABELS: Record<string, string> = {
  maxMatters: "matters",
  maxMembers: "team members",
  storageQuotaBytes: "storage",
};

const NEXT_PLAN: Record<string, { name: string; limit: string }> = {
  starter: { name: "Basic", limit: "75 matters, 5 members, 3 GB" },
  basic: { name: "Professional", limit: "250 matters, 15 members, 10 GB" },
  professional: {
    name: "Enterprise",
    limit: "unlimited matters, unlimited members, 50 GB",
  },
};

interface UpgradePromptProps {
  open: boolean;
  onClose: () => void;
  details: PlanLimitErrorDetails | null;
  lawFirmId: string;
}

export default function UpgradePrompt({
  open,
  onClose,
  details,
  lawFirmId,
}: UpgradePromptProps) {
  const { navigate } = useNavigation();

  // Preserve the last details so the card content stays rendered through the
  // exit animation, after the parent clears `details` on close.
  const lastDetailsRef = useRef<PlanLimitErrorDetails | null>(null);
  if (details) lastDetailsRef.current = details;
  const activeDetails = details ?? lastDetailsRef.current;

  if (!activeDetails) return null;

  const resourceLabel = RESOURCE_LABELS[activeDetails.resource] || activeDetails.resource;
  const next = NEXT_PLAN[activeDetails.planId] || NEXT_PLAN.starter;
  const planName =
    activeDetails.planId.charAt(0).toUpperCase() + activeDetails.planId.slice(1);

  return (
    <Modal
      isOpen={open && !!details}
      onClose={onClose}
      labelledBy="upgrade-prompt-title"
      showClose={false}
      height="none"
      className="rounded-xl"
      bodyClassName={null}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-0">
        <div className="w-10 h-10 rounded-lg bg-accent-soft flex items-center justify-center">
          <Crown className="w-5 h-5 text-accent-emphasis" />
        </div>
        <button
          onClick={onClose}
          className="text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div className="px-6 py-5 space-y-3">
        <h2 id="upgrade-prompt-title" className="text-lg font-bold text-on-surface">
          Plan limit reached
        </h2>
        <p className="text-sm text-on-surface-secondary leading-relaxed">
          You&apos;ve reached the maximum of{" "}
          <span className="font-semibold text-on-surface">
            {activeDetails.limit} {resourceLabel}
          </span>{" "}
          on the {planName} plan.
        </p>
        {next && (
          <p className="text-sm text-on-surface-secondary leading-relaxed">
            Upgrade to{" "}
            <span className="font-semibold text-on-surface">
              {next.name}
            </span>{" "}
            for {next.limit}.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-6 pb-5">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:text-on-surface border border-outline rounded-xl transition-[color,border-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          Not now
        </button>
        <button
          onClick={() => {
            onClose();
            navigate(`/lawfirm/${lawFirmId}/settings/billing`);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-semibold rounded-xl shadow-sm transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          View Plans
          <ArrowUpRight size={14} />
        </button>
      </div>
    </Modal>
  );
}

/**
 * Helper: check if an API error is a plan limit error and extract details.
 * Use in catch blocks to decide whether to show the upgrade prompt.
 */
export function parsePlanLimitError(
  err: unknown
): PlanLimitErrorDetails | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;

  // Check for the error code
  if (e.code === "PLAN_LIMIT_REACHED" && e.details) {
    return e.details as PlanLimitErrorDetails;
  }

  // Check error message from API response
  const msg = e.message || e.error;
  if (typeof msg === "string" && msg.includes("Plan limit reached")) {
    return (e.details as PlanLimitErrorDetails) || null;
  }

  return null;
}
