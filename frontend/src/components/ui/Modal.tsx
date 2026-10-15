"use client";

import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "@/hooks/useDialog";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { backdropAnim, cardAnim } from "@/components/ui/transitionClasses";

/** Panel widths, named so call sites don't retype `max-w-*`. */
const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  /** A viewer that fills most of the window rather than a column width. */
  screen: "max-w-[80vw]",
} as const;

/**
 * Panel heights.
 *
 * `auto` is what almost every dialog wants: as tall as its content, stopping
 * one notch short of the window, with the body scrolling inside. `fill` gives
 * the panel a fixed height whatever the content, for a viewer or a long list
 * that should own a stable area. `none` drops the cap, for the croppers whose
 * inner canvas sets its own size.
 *
 * `steps` is `fill` for a multi-step form. Each step of a wizard holds a
 * different number of fields, so a content-sized panel grew on one Continue and
 * shrank on the next. The panel is centred, so both edges moved and the footer
 * buttons moved with them, under a cursor that was already over Continue. One
 * fixed height for every step keeps the buttons where the reader left them; the
 * body scrolls when a step needs more room than 720px allows.
 */
const HEIGHTS = {
  auto: "max-h-[90vh]",
  fill: "h-[90vh]",
  steps: "h-[min(720px,90vh)]",
  none: "",
} as const;

/** Where the footer actions sit. */
const FOOTER_ALIGN = {
  end: "justify-end",
  between: "justify-between",
} as const;

/**
 * Width and height utilities the panel owns.
 *
 * A call site that passes one is sizing the dialog by hand. Two competing
 * Tailwind utilities on one element resolve by their order in the generated
 * stylesheet rather than the order they were written, so a hand-passed
 * `max-w-5xl` used to win or lose depending on which utility Tailwind emitted
 * last. Dropping them here makes the rendered panel depend only on `size` and
 * `height`; `scripts/check-modal-sizing.mjs` fails the build so the call site
 * is corrected rather than silently ignored.
 */
const OWNED_SIZING = /^(?:[\w-]+:)*(?:max-)?[wh]-/;

function withoutSizing(className: string): string {
  return className
    .split(/\s+/)
    .filter((cls) => cls && !OWNED_SIZING.test(cls))
    .join(" ");
}

export type ModalSize = keyof typeof SIZES;
export type ModalHeight = keyof typeof HEIGHTS;
export type ModalFooterAlign = keyof typeof FOOTER_ALIGN;

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Heading text rendered in the panel and wired to `aria-labelledby`. */
  title?: ReactNode;
  /** Secondary line under the heading. */
  subtitle?: ReactNode;
  /** Icon rendered inline before the heading text. */
  icon?: ReactNode;
  /**
   * Supply when the panel is labelled by an element you render yourself. The
   * value must match the `id` on that element. When omitted and `title` is
   * given, the internal heading is used instead.
   */
  labelledBy?: string;
  /** Panel width. The only supported way to widen or narrow a dialog. */
  size?: ModalSize;
  /**
   * How the panel takes its height. `auto` sizes to the content and caps at
   * 90vh; `fill` is a fixed 90vh; `none` removes the cap. Pass this rather
   * than a `max-h-*` in `className`.
   */
  height?: ModalHeight;
  /** Set false to drop the `×` in the header. */
  showClose?: boolean;
  /**
   * Set false while a save is in flight. Blocks every way of closing: the
   * backdrop, Escape and the close button, which is disabled. Blocking only the
   * backdrop let Escape abandon the dialog half-way, so a late failure landed
   * in a dialog that was already gone.
   */
  dismissible?: boolean;
  /** Replaces the `×` glyph, for the headers that close with a Lucide `X`. */
  closeIcon?: ReactNode;
  /**
   * Render into `document.body` instead of in place. Needed where an ancestor
   * creates a stacking or clipping context the panel must escape.
   */
  portal?: boolean;
  /**
   * Opened on top of another dialog: a payment over an invoice, a quick-create
   * inside a form. Raises the overlay above a top-level dialog and always
   * portals it, because the parent panel animates with a transform, and a
   * transformed ancestor traps both `fixed` positioning and z-index.
   */
  stacked?: boolean;
  /**
   * Action row, rendered in the tinted bar at the bottom of the panel. Buttons
   * are laid out with the standard gap, so pass the buttons alone.
   */
  footer?: ReactNode;
  /**
   * How the footer actions are spread. `end` is the default. `between` pushes
   * the first child left and the last right, for a wizard's Back and Continue
   * pair; pass the two slots as two children.
   */
  footerAlign?: ModalFooterAlign;
  /**
   * Freeze the page behind the dialog. `useDialog` deliberately leaves scroll
   * alone, so this stays opt-in: turn it on where the page behind would
   * otherwise scroll under the panel.
   */
  lockScroll?: boolean;
  /**
   * Extra classes for the panel, for radius, border and shadow. Width and
   * height utilities are dropped: use `size` and `height`.
   */
  className?: string;
  /**
   * Replaces the default body padding and scroll treatment. Pass `null` to drop
   * the wrapper entirely, so `children` become direct flex children of the
   * panel, needed when the caller renders its own header/body/footer and
   * relies on `flex-1` to size them.
   */
  bodyClassName?: string | null;
  children: ReactNode;
}

/**
 * The app's dialog shape, as one component.
 *
 * Renders the standard fixed `inset-0` overlay (backdrop click closes) plus a
 * centered panel with `role="dialog"` / `aria-modal`, wired to `useDialog`
 * (focus trap, focus restore, Escape) and the shared open/close animation. The
 * header, body and tinted footer reproduce the shape the app already used in
 * roughly a hundred hand-rolled copies, so a migrated dialog renders
 * identically to the one it replaced.
 *
 * Render it unconditionally with an `isOpen` prop rather than behind
 * `{open && …}`: the exit animation only plays while the panel stays mounted.
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  labelledBy,
  size = "md",
  height = "auto",
  showClose = true,
  dismissible = true,
  closeIcon,
  portal = false,
  stacked = false,
  footer,
  footerAlign = "end",
  lockScroll = false,
  className = "",
  bodyClassName = "px-6 py-5 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar",
  children,
}: ModalProps) {
  const { mounted, exiting } = useMountTransition(isOpen, 100);
  const guardedClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);
  const { dialogRef, titleId } = useDialog({ isOpen, onClose: guardedClose });

  // The panel stays on screen for its exit animation, and whatever closes it
  // routinely changes what it would render in the same update: a form resets, a
  // busy label reverts, a result screen replaces the form, the record being shown
  // is cleared. Render what was on screen when it closed instead, so the dialog
  // fades out exactly as the user last saw it.
  const shownTitle = useLastOpenValue(isOpen, title);
  const shownSubtitle = useLastOpenValue(isOpen, subtitle);
  const shownIcon = useLastOpenValue(isOpen, icon);
  const shownFooter = useLastOpenValue(isOpen, footer);
  const shownChildren = useLastOpenValue(isOpen, children);

  useBodyScrollLock(lockScroll && mounted);

  if (!mounted) return null;
  const portaled = portal || stacked;
  if (portaled && typeof document === "undefined") return null;

  const headingId = labelledBy ?? (shownTitle ? titleId : undefined);

  // Drop any base class the caller overrides. Two competing Tailwind utilities
  // on one element resolve by their order in the generated stylesheet, not by
  // the order they appear here, so `rounded-lg` would silently beat a caller's
  // `rounded-xl` if Tailwind happened to emit it later. Removing the loser is
  // the only way to make the override deterministic.
  const panelClassName = withoutSizing(className);
  //
  // Below `sm` the panel stops being a centred card and becomes a bottom sheet:
  // full width whatever `size` asked for, square along the bottom edge, and
  // capped against `svh` rather than `vh`. `vh` is the large viewport, so a
  // sheet sized in `vh` puts its footer under the browser chrome; `svh` is the
  // chrome-visible height and does not move as the chrome hides, which `dvh`
  // would. The `max-sm:` utilities are emitted after the plain ones, so they
  // win over a caller's radius without the class-stripping the widths need.
  const base = [
    "w-full",
    SIZES[size],
    "max-sm:max-w-none",
    /\brounded-(?!b-)/.test(panelClassName) ? "" : "rounded-lg",
    "max-sm:rounded-b-none",
    "bg-surface",
    /\bshadow-/.test(panelClassName) ? "" : "shadow-xl",
    "pointer-events-auto",
    HEIGHTS[height],
    "max-sm:max-h-[85svh]",
    "flex flex-col",
  ].filter(Boolean).join(" ");

  const overlay = (
    <div className={`fixed inset-0 ${stacked ? "z-[60]" : "z-50"}`}>
      <div
        className={`absolute inset-0 bg-black/40 ${backdropAnim(exiting)}`}
        onClick={guardedClose}
      />
      <div className="absolute inset-0 flex items-end justify-center p-0 sm:items-center sm:p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className={[base, cardAnim(exiting), panelClassName].filter(Boolean).join(" ")}
          onClick={(e) => e.stopPropagation()}
        >
          {(shownTitle || showClose) && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
              <div>
                {shownTitle && (
                  <h2
                    id={titleId}
                    className="flex items-center gap-2 text-lg font-semibold text-on-surface"
                  >
                    {shownIcon}
                    {shownTitle}
                  </h2>
                )}
                {shownSubtitle && (
                  <p className="text-sm text-on-surface-secondary mt-1">{shownSubtitle}</p>
                )}
              </div>
              {showClose && (
                <button
                  type="button"
                  onClick={guardedClose}
                  disabled={!dismissible}
                  aria-label="Close"
                  className={
                    closeIcon
                      ? "text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      : "text-on-surface-muted hover:text-on-surface text-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  }
                >
                  {closeIcon ?? <>&times;</>}
                </button>
              )}
            </div>
          )}

          {bodyClassName === null ? shownChildren : <div className={bodyClassName}>{shownChildren}</div>}

          {shownFooter && (
            <div className="px-6 py-4 bg-surface-alt rounded-b-lg max-sm:rounded-b-none border-t border-outline shrink-0">
              <div className={`flex items-center ${FOOTER_ALIGN[footerAlign]} gap-2`}>{shownFooter}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return portaled ? createPortal(overlay, document.body) : overlay;
}
