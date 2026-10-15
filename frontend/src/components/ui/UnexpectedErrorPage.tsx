"use client";

import { ArrowLeft, RotateCcw, TriangleAlert } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function UnexpectedErrorPage({
  title = "Something went wrong",
  description = "This page hit an error while loading. Your work is safe, so try again.",
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  secondaryHref = "/dashboard",
  details,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  secondaryHref?: string;
  details?: string;
}) {
  // An error screen is often reached from an emailed link in a fresh tab, where
  // history.back() would land on about:blank, so fall back to a real
  // destination when this entry has nowhere to return to.
  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = secondaryHref;
  };

  return (
    <StatusPage
      badge="Unexpected error"
      code="500"
      Icon={TriangleAlert}
      title={title}
      description={description}
      primaryAction={
        onRetry
          ? {
              label: retrying ? "Retrying..." : retryLabel,
              onClick: onRetry,
              icon: RotateCcw,
              loading: retrying,
            }
          : undefined
      }
      secondaryAction={{
        label: "Back",
        onClick: goBack,
        icon: ArrowLeft,
      }}
      details={details}
    />
  );
}
