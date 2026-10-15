"use client";

import React from "react";

export interface ListEmptyStateProps {
  /** The headline: what isn't here. */
  title: string;
  /** One line on why, or what to do about it. */
  message?: React.ReactNode;
  /** Lucide icon, sized 32-40. Muted automatically. */
  icon?: React.ReactNode;
  /** Optional call to action under the message. */
  action?: React.ReactNode;
  /**
   * Tightens the vertical padding for a list embedded in a tab, panel or modal,
   * where the full-page spacing would leave a large hole. Typography and the
   * container stay the same, so it still reads as the same component.
   */
  compact?: boolean;
  className?: string;
}

/**
 * The "nothing here yet" card for a list.
 *
 * Every list in the app says it the same way: a dashed card the width of the
 * list, with the headline, a supporting line, and an optional icon. Using one
 * component keeps an empty matters list, an empty tab and an empty billing view
 * from each looking like a different kind of nothing.
 *
 * This is for a list that legitimately has no rows. An error belongs in
 * `ErrorNotification`, and a list that is still loading belongs in
 * `ListSkeleton`.
 */
export default function ListEmptyState({
  title,
  message,
  icon,
  action,
  compact = false,
  className = "",
}: ListEmptyStateProps) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-outline bg-surface-alt/30 px-6 text-center text-on-surface-secondary ${
        compact ? "py-10" : "py-16"
      } ${className}`}
    >
      {icon && <div className="mx-auto mb-3 flex justify-center opacity-40">{icon}</div>}
      <p className="text-lg font-medium text-on-surface">{title}</p>
      {message != null && <p className="mt-1 text-sm">{message}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
