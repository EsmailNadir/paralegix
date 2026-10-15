"use client";

import { RefreshCcw, WifiOff } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

interface ConnectionUnavailableProps {
  onRetry: () => void;
  isRetrying?: boolean;
}

/**
 * Full-page state when the app cannot reach the backend (network/connection issue).
 * User-friendly copy, no dev jargon. Used by lawfirm layout and any route that needs it.
 */
export default function ConnectionUnavailable({ onRetry, isRetrying = false }: ConnectionUnavailableProps) {
  return (
    <StatusPage
      badge="Connection issue"
      code="Offline"
      Icon={WifiOff}
      title="We're having trouble reaching the server"
      description="Check your connection and try again."
      primaryAction={{
        label: isRetrying ? "Connecting..." : "Try again",
        onClick: onRetry,
        loading: isRetrying,
        icon: RefreshCcw,
      }}
      secondaryAction={{
        label: "Back to dashboard",
        href: "/dashboard",
      }}
    />
  );
}
