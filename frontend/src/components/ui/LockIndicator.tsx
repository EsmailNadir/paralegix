"use client";

import { Lock } from "lucide-react";

export default function LockIndicator({
  message = "This setting is managed by your firm administrator.",
  className = "",
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border border-amber-200 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 ${className}`.trim()}
    >
      <Lock size={12} />
      <span>{message}</span>
    </div>
  );
}

