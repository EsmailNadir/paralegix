"use client";

import StatusBadge from "@/components/ui/StatusBadge";
import { taskPriorityMeta } from "@/constants/statusMeta";

/** A task's priority (Low / Medium / High / Urgent). */
export default function TaskPriorityBadge({
  priority,
  className = "",
}: {
  priority?: string | null;
  className?: string;
}) {
  const { label, variant } = taskPriorityMeta(priority);
  return (
    <StatusBadge variant={variant} className={className}>
      {label}
    </StatusBadge>
  );
}
