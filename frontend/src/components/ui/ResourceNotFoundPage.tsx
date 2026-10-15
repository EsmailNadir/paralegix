"use client";

import { ArrowLeft, SearchX } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function ResourceNotFoundPage({
  resourceLabel = "page",
  title,
  description,
  primaryAction,
  secondaryAction,
}: {
  resourceLabel?: string;
  title?: string;
  description?: string;
  primaryAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  secondaryAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}) {
  const label = resourceLabel.trim();

  return (
    <StatusPage
      badge={`${label} not found`}
      code="404"
      Icon={SearchX}
      title={title || `We could not find that ${label}`}
      description={description || "It may have been removed, renamed, or you no longer have access."}
      primaryAction={
        primaryAction || {
          label: "Back to dashboard",
          href: "/dashboard",
          icon: ArrowLeft,
        }
      }
      secondaryAction={secondaryAction}
    />
  );
}
