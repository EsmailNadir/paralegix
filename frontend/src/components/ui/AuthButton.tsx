"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import Spinner from "@/components/ui/Spinner";

/**
 * Filled accent for the action the screen exists for; outline for the way out
 * of it (cancel, resend, "use a different method"). A screen has one `primary`.
 */
export type AuthButtonVariant = "primary" | "secondary";

const VARIANT_CLASSES: Record<AuthButtonVariant, string> = {
  primary:
    "text-accent-foreground text-sm font-semibold bg-accent-solid hover:bg-accent-solid-hover transition-[background-color,transform] shadow-sm dark:shadow-none",
  secondary:
    "text-on-surface text-sm font-medium bg-surface border border-outline hover:bg-surface-hover transition-all",
};

export interface AuthButtonProps {
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  variant?: AuthButtonVariant;
  /** The underlying HTML `type`. Defaults to `button`; pass `submit` for the one that submits. */
  htmlType?: "button" | "submit";
  disabled?: boolean;
  /**
   * Shows a leading spinner and disables. Only for a control whose own action is
   * in flight - a button disabled by someone else's in-flight action takes
   * `disabled` instead, so one spinner never appears in two places at once.
   * The caller still owns the label, because these screens change the word while
   * waiting ("Accept Invitation" becomes "Accepting...").
   */
  loading?: boolean;
  /** Layout-only extras (`mt-2`). Not for colour or size - that is `variant`. */
  className?: string;
  "aria-label"?: string;
  /**
   * Renders as a `next/link` instead of a `<button>`, for the rare case of a
   * redirect screen's "continue" link rather than an action ("Redirecting to
   * login..." + a manual way there). `onClick`/`htmlType`/`loading` are ignored
   * when set.
   */
  href?: string;
}

/**
 * The full-width call to action on a standalone auth / onboarding / entry screen:
 * sign in, register, verify, accept an invite, finish registration.
 *
 * These screens render outside the app shell on their own centered card, and
 * their button is its own primitive: full width, `py-2.5 px-4`, `rounded-xl`,
 * `text-sm`. It is deliberately NOT `<Button>` (modal footers and form actions,
 * `rounded-md` and auto width) and NOT the compact page-header CTA
 * (`px-3.5 py-2 rounded-xl text-xs`). Mixing the three is what made these
 * screens drift apart before this component existed.
 */
export default function AuthButton({
  children,
  onClick,
  variant = "primary",
  htmlType = "button",
  disabled = false,
  loading = false,
  className = "",
  "aria-label": ariaLabel,
  href,
}: AuthButtonProps) {
  const isDisabled = disabled || loading;
  const classes = `w-full py-2.5 px-4 rounded-xl inline-flex items-center justify-center gap-2 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${VARIANT_CLASSES[variant]} ${className}`;

  if (href) {
    return (
      <Link href={href} aria-label={ariaLabel} className={`text-center ${classes}`}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type={htmlType}
      onClick={onClick}
      disabled={isDisabled}
      aria-label={ariaLabel}
      className={classes}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
}
