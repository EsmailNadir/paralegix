"use client";

import { ArrowLeft, LogIn } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

export default function AuthRequiredPage({
  title = "Sign in to continue",
  description = "Your session is no longer active. Sign in again to pick up where you left off.",
  loginHref = "/login",
  secondaryHref = "/",
  secondaryLabel = "Back home",
}: {
  title?: string;
  description?: string;
  loginHref?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <StatusPage
      badge="Authentication required"
      code="401"
      Icon={LogIn}
      title={title}
      description={description}
      primaryAction={{
        label: "Go to sign in",
        href: loginHref,
        icon: LogIn,
      }}
      secondaryAction={{
        label: secondaryLabel,
        href: secondaryHref,
        icon: ArrowLeft,
      }}
    />
  );
}
