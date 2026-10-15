"use client";

import { ArrowLeft, FileWarning } from "lucide-react";
import StatusPage from "@/components/ui/StatusPage";

/**
 * A document over a size limit. A limit is not a failure, so this is its own
 * status screen rather than the unexpected-error one.
 */
export default function DocumentTooLargePage({
  title = "This document is too large",
  description = "This document is over the size this page can open.",
  primaryHref = "/",
}: {
  title?: string;
  description?: string;
  primaryHref?: string;
}) {
  return (
    <StatusPage
      badge="File too large"
      code="413"
      Icon={FileWarning}
      title={title}
      description={description}
      primaryAction={{
        label: "Back to home",
        href: primaryHref,
        icon: ArrowLeft,
      }}
    />
  );
}
