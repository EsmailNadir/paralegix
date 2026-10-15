"use client";

import Tooltip from "@/components/ui/Tooltip";

/**
 * What an action *means*, not what colour it is - the same idea as a
 * `StatusVariant` in `@/constants/statusMeta`, applied to a control instead of a
 * label.
 *
 * `neutral` is the default and the right answer for most rows: an edit, a
 * download, an open. Reach for a colour only when the action is worth singling
 * out, and never for more than one or two buttons in the same row - a row where
 * every icon is coloured says nothing about which one is dangerous.
 */
export type ActionTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * Hover accent per tone, in both themes.
 *
 * The dark shade is the reason this lives in one place. A bare `hover:text-red-600`
 * is legible on a white card and muddy on a dark one, and because hovering moves
 * it *down* the scale it actually loses contrast at the moment it is meant to gain
 * it. Semantic tones mirror `STATUS_VARIANTS[*].text`, while `info` follows the
 * app interaction accent so an ordinary action does not introduce a blue hue.
 */
const TONE_HOVER: Record<ActionTone, string> = {
  neutral: "hover:text-on-surface",
  info: "hover:text-accent-emphasis dark:hover:text-accent-emphasis",
  success: "hover:text-emerald-600 dark:hover:text-emerald-400",
  warning: "hover:text-amber-600 dark:hover:text-amber-400",
  danger: "hover:text-red-600 dark:hover:text-red-400",
};

/** The same accents at rest, for `emphasis`. Matches `STATUS_VARIANTS[*].text`. */
const TONE_TEXT: Record<ActionTone, string> = {
  neutral: "text-on-surface-muted",
  info: "text-accent-emphasis",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

export interface ActionIconButtonProps {
  /** Tooltip text and accessible name. Required · an icon alone names nothing. */
  label: string;
  /**
   * Tooltip copy when it should say more than the accessible name · typically a
   * disabled button explaining what would make it available. Defaults to `label`.
   */
  tooltip?: React.ReactNode;
  /**
   * Receives the click event, so an action button sitting inside a clickable
   * row can `stopPropagation()` and not also trigger the row. Callers that
   * don't need it can still pass a zero-argument handler.
   */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** The icon. Size is the caller's to pick, matching the row it sits in (14–16). */
  children: React.ReactNode;
  tone?: ActionTone;
  /**
   * Carry the tone at rest instead of only on hover, for an action that needs
   * attention before it is pointed at (a completion that would leave a dependency
   * unresolved). Use it on one button in a row, or the row stops having a focus.
   */
  emphasis?: boolean;
  /**
   * Hit area. `md` (the default) is the list-row size; `sm` is for dense table
   * cells, where the row height comes from the text and a bigger target would
   * push it taller.
   */
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  /** Layout-only extras (`shrink-0`, `ml-auto`). Not for colour - that's `tone`. */
  className?: string;
}

/**
 * The icon-only button that sits at the end of a list row or card: edit, delete,
 * complete, download.
 *
 * It owns the tooltip, the accessible name, the metrics, and the colour, because
 * hand-rolling those is how the same delete button ended up `rounded` in one list
 * and `rounded-md` in the next, with a hover accent that only worked in light mode.
 * Pass a `tone`, not a class.
 */
export default function ActionIconButton({
  label,
  tooltip,
  onClick,
  children,
  tone = "neutral",
  emphasis = false,
  size = "md",
  disabled = false,
  type = "button",
  className = "",
}: ActionIconButtonProps) {
  const button = (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex items-center justify-center rounded-md ${size === "sm" ? "p-1" : "p-1.5"} transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover ${
        emphasis ? TONE_TEXT[tone] : `text-on-surface-muted ${TONE_HOVER[tone]}`
      } disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${className}`}
    >
      {children}
    </button>
  );

  // A disabled button fires no pointer events, so the hover never reaches the
  // tooltip and the label explaining *why* it is disabled never opens. The span
  // does the listening instead.
  return (
    <Tooltip title={tooltip ?? label} enterDelay={300}>
      {disabled ? <span className="inline-flex">{button}</span> : button}
    </Tooltip>
  );
}
