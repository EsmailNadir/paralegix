"use client";

import StatusBadge from "@/components/ui/StatusBadge";
import { clientStatusMeta } from "@/constants/statusMeta";

/** A client's status (Active / Inactive / Archived), consistent across surfaces. */
export default function ClientStatusBadge({
  status,
  className = "",
}: {
  status?: string | null;
  className?: string;
}) {
  const { label, variant } = clientStatusMeta(status);
  return (
    <StatusBadge variant={variant} className={className}>
      {label}
    </StatusBadge>
  );
}
