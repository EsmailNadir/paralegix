"use client";

import { ArrowLeft, ShieldAlert } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function AccessDeniedPage({
  title = "You do not have access to this area",
  description = "Your role in this firm does not allow this. Ask an admin if you need access.",
  primaryHref = "/dashboard",
  secondaryAction,
}: {
  title?: string;
  description?: string;
  primaryHref?: string;
  secondaryAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}) {
  return (
    <StatusPage
      badge="Access denied"
      code="403"
      Icon={ShieldAlert}
      title={title}
      description={description}
      primaryAction={{
        label: "Back to dashboard",
        href: primaryHref,
        icon: ArrowLeft,
      }}
      secondaryAction={secondaryAction}
    />
  );
}
