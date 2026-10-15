"use client";

/**
 * A number riding on something else: unread messages on a conversation, rows in
 * a section, results behind a tab.
 *
 * Deliberately NOT `StatusBadge`. A status badge says what something *is*, and
 * spends a colour saying it; a count says how *many*, and its colour should mean
 * only "there are some" or nothing at all. Rendering a count in the badge shape
 * makes an unread counter read as a state the reader has to interpret.
 *
 * The pill is sized from its own text with a floor, so "3" and "12" are the same
 * width and a column of them stays aligned, while "148" is allowed to grow.
 */
export default function CountPill({
  count,
  tone = "neutral",
  showZero = false,
  max,
  className = "",
}: {
  count: number;
  /**
   * `neutral` is the default: a plain count, no urgency.
   *
   * `accent` is the filled indigo counter, reserved for something *unread* or
   * otherwise awaiting the reader. Using it for an ordinary total is how every
   * count on a screen ends up shouting.
   */
  tone?: "neutral" | "accent";
  /** By default a zero draws nothing, since "0 unread" is just "no badge". */
  showZero?: boolean;
  /** Condense larger values when the available horizontal space is fixed. */
  max?: number;
  className?: string;
}) {
  if (!count && !showZero) return null;

  const toneCls =
    tone === "accent"
      ? "bg-accent-solid text-accent-foreground"
      : "bg-surface text-on-surface-secondary border border-outline-subtle";

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center min-w-[22px] h-[22px] rounded-full px-1.5 text-[11px] font-semibold ${toneCls} ${className}`}
    >
      {max !== undefined && count > max ? `${max}+` : count}
    </span>
  );
}
