"use client";

import StatusBadge from "@/components/ui/StatusBadge";
import { taskStatusMeta } from "@/constants/statusMeta";

/**
 * A task's status.
 *
 * `overdue` folds the lateness into this badge as "In Progress · Overdue" rather
 * than adding a second one, so a dense list row spends a single badge slot on the
 * task's state. The status word survives the change of colour, which a bare red
 * "Overdue" badge on its own would not.
 */
export default function TaskStatusBadge({
  status,
  overdue = false,
  className = "",
}: {
  status?: string | null;
  overdue?: boolean;
  className?: string;
}) {
  const { label, variant } = taskStatusMeta(status);
  return (
    <StatusBadge variant={overdue ? "danger" : variant} className={className}>
      {overdue ? `${label} · Overdue` : label}
    </StatusBadge>
  );
}
