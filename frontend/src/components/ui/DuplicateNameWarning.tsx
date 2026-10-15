"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Advisory field-level warning for a duplicate matter, task, or client name.
 * Unlike FieldError, this never implies that the form action is blocked.
 */
export default function DuplicateNameWarning({
  duplicateName,
  entityLabel,
}: {
  duplicateName?: string | null;
  entityLabel: "matter" | "task" | "client";
}) {
  if (!duplicateName) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle size={14} className="mt-px shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        A {entityLabel} named &ldquo;{duplicateName}&rdquo; already exists. You can still continue.
      </span>
    </div>
  );
}
