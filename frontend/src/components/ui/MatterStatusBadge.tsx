"use client";

import StatusBadge from "@/components/ui/StatusBadge";
import { matterStatusMeta } from "@/constants/statusMeta";

/**
 * A matter's status, rendered the same way on every surface that shows one.
 *
 * Extras that qualify a matter - "Payment ongoing", "Overdue" - belong beside this
 * badge as their own siblings rather than as props that recolour it, so a matter
 * never trades away its status colour to say something additional.
 */
export default function MatterStatusBadge({
  status,
  className = "",
}: {
  status?: string | null;
  className?: string;
}) {
  const { label, variant } = matterStatusMeta(status);
  return (
    <StatusBadge variant={variant} className={className}>
      {label}
    </StatusBadge>
  );
}
