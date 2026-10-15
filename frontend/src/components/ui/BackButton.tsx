"use client";

import { ArrowLeft } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { useNavigation } from "@/contexts/NavigationContext";

interface BackButtonProps {
  /** Route to return to. */
  href?: string;
  /**
   * Steps back within the same page instead of navigating, for a view that
   * replaced another in place (the pay page's card form). Wins over `href`.
   */
  onClick?: () => void;
  /**
   * Names the destination, e.g. "Back to Matters". Shown as a tooltip and the
   * accessible name for the `icon` variant, and as the visible text for `link`.
   */
  label: string;
  /**
   * `icon` is the arrow button that sits inline to the left of a page title.
   * `link` is the labelled row that sits above a page header.
   */
  variant?: "icon" | "link";
  className?: string;
}

/**
 * The single back control for detail pages. Navigation goes through
 * `useNavigation()` so the app-wide loading spinner shows while the next page
 * loads.
 */
export default function BackButton({ href, onClick, label, variant = "icon", className = "" }: BackButtonProps) {
  const { navigate } = useNavigation();
  const goBack = () => {
    if (onClick) onClick();
    else if (href) navigate(href);
  };

  if (variant === "link") {
    return (
      <button
        type="button"
        onClick={goBack}
        className={`inline-flex items-center gap-1.5 text-sm text-on-surface-secondary hover:text-on-surface transition-colors cursor-pointer ${className}`}
      >
        <ArrowLeft size={16} />
        {label}
      </button>
    );
  }

  return (
    <Tooltip title={label} enterDelay={300}>
      <button
        type="button"
        onClick={goBack}
        aria-label={label}
        className={`p-1.5 sm:p-2 -ml-1 text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover rounded-lg transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0 ${className}`}
      >
        <ArrowLeft className="h-5 w-5 sm:h-6 sm:w-6" />
      </button>
    </Tooltip>
  );
}
