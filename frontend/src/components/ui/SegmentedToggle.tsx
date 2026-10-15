"use client";

import type { LucideIcon } from "lucide-react";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Optional badge, e.g. how many rows the view holds. */
  count?: number;
}

/**
 * A set of mutually exclusive views rendered as ONE control: a single inset
 * track with the selected view raised inside it.
 *
 * Two loose pills side by side - one filled, one outlined - read as two
 * unrelated buttons, so the reader has to work out that pressing the second one
 * turns the first one off. Enclosing them in a shared track says "pick one of
 * these" before any label is read, and keeps the two segments the same size
 * whichever one is active.
 */
export default function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  ariaLabel,
  className = "",
  hideLabels = false,
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "xs" | "sm" | "md";
  ariaLabel?: string;
  className?: string;
  /** Icon-only: each option's `label` becomes its `aria-label` instead of visible text. */
  hideLabels?: boolean;
}) {
  const segmentCls = hideLabels
    ? "p-1.5"
    : size === "md"
      ? "px-3.5 py-2 text-sm"
      : size === "xs"
        ? "px-2 py-0.5 text-[11px]"
        : "px-3 py-1.5 text-xs";
  const iconSize = size === "md" ? 15 : size === "xs" ? 12 : 14;

  const { containerRef, registerItem, rect: pill } = useSlidingHighlight<HTMLDivElement>(value);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className={`relative inline-flex items-center gap-1 rounded-xl border border-outline-subtle bg-surface-alt ${
        size === "xs" ? "p-0.5" : "p-1"
      } ${className}`}
    >
      {pill && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 rounded-lg bg-accent-solid shadow-sm dark:shadow-none transition-[transform,width] duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      )}
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={registerItem(option.value)}
            type="button"
            aria-pressed={active}
            aria-label={hideLabels ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={`relative z-10 inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors cursor-pointer ${segmentCls} ${
              active
                ? "text-accent-foreground"
                : "text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface"
            }`}
          >
            {Icon && <Icon size={iconSize} strokeWidth={2} className="flex-shrink-0" />}
            {!hideLabels && option.label}
            {typeof option.count === "number" && (
              <span
                className={`ml-0.5 rounded-md px-1.5 py-px text-[10px] font-semibold transition-colors duration-200 ease-out motion-reduce:transition-none ${
                  active ? "bg-accent-foreground/20 text-accent-foreground" : "bg-surface text-on-surface-muted"
                }`}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
