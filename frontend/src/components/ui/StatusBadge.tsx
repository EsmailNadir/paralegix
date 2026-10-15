"use client";

import { STATUS_VARIANTS, type StatusVariant } from "@/constants/statusMeta";

export type { StatusVariant };

export default function StatusBadge({
  variant,
  children,
  className = "",
}: {
  variant: StatusVariant;
  children: React.ReactNode;
  className?: string;
}) {
  // Falls back rather than destructuring undefined: a variant that came from
  // stored data can be a value the palette does not cover, and a badge should
  // never be able to take the page down with it.
  const { dot, text } = STATUS_VARIANTS[variant] ?? STATUS_VARIANTS.neutral;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface px-2.5 py-0.5 text-xs font-medium",
        text,
        className,
      ].join(" ")}
    >
      <span className={["size-1.5 shrink-0 rounded-full", dot].join(" ")} />
      {children}
    </span>
  );
}
