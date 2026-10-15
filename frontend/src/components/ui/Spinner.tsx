import { Loader2 } from "lucide-react";

interface SpinnerProps {
  /** Diameter in px. Match the text or icon it sits next to (13-16 inline, 20+ for a block). */
  size?: number;
  /** Extra classes, usually a colour: `text-on-surface-muted`, `text-white`. */
  className?: string;
  /**
   * Screen-reader text. Omit when adjacent visible text already says what is
   * happening ("Saving…"), which is the common case; the spinner is then hidden
   * from the accessibility tree instead of announcing a bare "Loading".
   */
  label?: string;
}

/**
 * The inline "something is in flight" indicator.
 *
 * One shape for every waiting state in the product, so a spinner in a button, a
 * row action menu, a table cell and a dropdown trigger all read as the same
 * thing. It inherits `currentColor`, so it takes the colour of whatever it sits
 * in without a per-site override.
 *
 * This replaced three idioms that had grown side by side: a hand-written
 * `<svg className="animate-spin">` with an opacity-25 ring, a
 * `rounded-full border-2 border-t-transparent` div, and a bare `<Loader2>`. They
 * spin at different speeds and draw different arcs, so two of them next to each
 * other looked like two different kinds of wait.
 *
 * For a whole page or a panel that has nothing to show yet, use `LoadingSpinner`
 * (`@/components/LoadingSpinner`) instead: it is the larger branded gradient mark
 * and carries a `fullPage` layout.
 */
export default function Spinner({ size = 14, className = "", label }: SpinnerProps) {
  return (
    <>
      <Loader2
        size={size}
        className={`animate-spin shrink-0 ${className}`}
        aria-hidden={label ? undefined : true}
        role={label ? "status" : undefined}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}
