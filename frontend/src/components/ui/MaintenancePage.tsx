"use client";

import { RefreshCcw, Wrench } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function MaintenancePage({
  title = "Paralegix is under maintenance",
  description = "We are making an update, so some actions are paused for now.",
  onRetry,
  isRetrying = false,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
}) {
  return (
    <StatusPage
      badge="Maintenance mode"
      code="503"
      Icon={Wrench}
      title={title}
      description={description}
      primaryAction={
        onRetry
          ? {
              label: isRetrying ? "Checking again" : "Try again",
              onClick: onRetry,
              icon: RefreshCcw,
              loading: isRetrying,
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
