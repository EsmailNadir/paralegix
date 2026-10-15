import type { ReactNode } from "react";

/**
 * A labeled read-only field: a small uppercase caption above a value. The default
 * body renders `value`, falling back to muted-italic `empty` text when it's blank.
 * Pass `children` instead for a custom body (chips, badges, computed markup).
 * Used across matter/task/client detail views to replace the repeated
 * label + value row markup.
 */
export default function DetailField({
  label,
  value,
  empty = "Not specified",
  children,
  className = "",
}: {
  label: ReactNode;
  value?: ReactNode;
  empty?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      <span className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wide">{label}</span>
      {children ?? (
        <p className="text-sm font-medium text-on-surface mt-1">
          {value || <span className="text-on-surface-muted italic">{empty}</span>}
        </p>
      )}
    </div>
  );
}
