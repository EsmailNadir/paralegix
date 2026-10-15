"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * The amber advisory box: something the reader should know that does not stop
 * them. A refusal or a failure is red (`UploadFailures`, `ErrorNotification`);
 * this is for "what you see is not all of it", where the action on screen still
 * goes ahead.
 */
export default function InlineWarning({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 ${className}`}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-xs text-amber-700 dark:text-amber-300">{children}</p>
    </div>
  );
}

/**
 * Said when a pick holds more files than one upload takes. The first files up to
 * the limit are kept and the rest are named here rather than dropped without a
 * word. Renders `null` when nothing was left out.
 */
export function UploadLimitNotice({
  limit,
  leftOut,
  className,
}: {
  limit: number;
  leftOut: number;
  className?: string;
}) {
  if (leftOut <= 0) return null;
  return (
    <InlineWarning className={className}>
      {`Only ${limit} files can be uploaded at once. ${leftOut} ${leftOut === 1 ? "file was" : "files were"} not added.`}
    </InlineWarning>
  );
}
