"use client";

import { ArrowLeft, Link2Off, type LucideIcon } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function InvalidLinkPage({
  title = "This link is no longer valid",
  description = "It may have expired, already been used, or been copied incorrectly.",
  primaryAction = {
    label: "Back to login",
    href: "/login",
    icon: ArrowLeft,
  },
  secondaryAction,
  children,
}: {
  title?: string;
  description?: string;
  primaryAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
    icon?: LucideIcon;
    loading?: boolean;
    disabled?: boolean;
  };
  secondaryAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
    icon?: LucideIcon;
    loading?: boolean;
    disabled?: boolean;
  };
  children?: React.ReactNode;
}) {
  return (
    <StatusPage
      badge="Invalid link"
      code="Expired or malformed"
      Icon={Link2Off}
      title={title}
      description={description}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
    >
      {children}
    </StatusPage>
  );
}
