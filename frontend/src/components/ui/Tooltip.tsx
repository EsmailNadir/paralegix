"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Which side of the anchor the label sits on. It is a preference, not a
 * guarantee - the tooltip flips to the opposite side when the preferred one
 * would push it off screen.
 */
export type TooltipPlacement = "top" | "bottom";

/** Distance between the anchor's edge and the label. */
const GAP = 14;
/** With an arrow the label sits closer, so the arrow reaches the anchor rather than floating. */
const ARROW_GAP = 8;
/** Side of the (rotated 45°) arrow square, so it shows as an 8×4 triangle. */
const ARROW_SIZE = 8;
/** Closest the label may come to a viewport edge before it is clamped. */
const EDGE = 8;
/**
 * The chip fill, shared by the label and its arrow. A fixed near-black in both
 * themes rather than a surface token: this floats above the page instead of
 * sitting in it, so it reads against a dark card and a light one alike.
 */
const CHIP_BG = "bg-[rgba(97,97,97,0.92)]";

/**
 * Whether a child renders any visible text of its own, looking through nested
 * elements. Text produced inside a component's render (rather than passed to it
 * as children) is invisible from here, so such a child counts as icon-only.
 */
function hasTextContent(node: ReactNode): boolean {
  if (typeof node === "string") return node.trim() !== "";
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(hasTextContent);
  if (isValidElement<{ children?: ReactNode }>(node)) return hasTextContent(node.props.children);
  return false;
}

/** `useLayoutEffect` warns when it runs during SSR, and this renders on the server. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TooltipProps {
  /**
   * The label. An empty string (or `null`/`false`) renders the child with no
   * tooltip at all, so a call site can drop the label conditionally - 
   * `title={canEdit ? "" : "You cannot edit this"}` · without branching.
   */
  title: ReactNode;
  /**
   * A single element. Its pointer and focus handlers are wrapped, so it has to
   * be something that puts them on a DOM node: a host element, or a component
   * that spreads its props onto one.
   */
  children: ReactElement<Record<string, unknown>>;
  /** Hover time before the label opens. Long enough not to fire while passing over. */
  enterDelay?: number;
  placement?: TooltipPlacement;
  /**
   * Point at the anchor. For a callout that explains something - why a control
   * is in the state it is in - not for the label on an action button, where 200
   * arrows in a row is noise.
   */
  arrow?: boolean;
}

type Position = {
  top: number;
  left: number;
  placement: TooltipPlacement;
  /** Arrow offset from the label's left edge, already clamped to stay on it. */
  arrowLeft: number;
};

/**
 * The hover label used across the app, on icon buttons and on text that has
 * been shortened or relativised ("3d ago" → the full timestamp).
 *
 * It is deliberately not interactive: it closes the moment the pointer leaves
 * and never takes pointer events itself, because every label here is a label
 * and not somewhere to move the pointer onto. That is also why it opens on
 * `:focus-visible` but not on touch - a tap has no matching "leave", so a
 * touch tooltip would open and stay open.
 *
 * The label is portalled to `<body>` and positioned in fixed coordinates so a
 * row's `overflow-hidden` cannot clip it.
 */
export default function Tooltip({
  title,
  children,
  enterDelay = 300,
  placement = "bottom",
  arrow = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();

  // A call site drops its label by emptying it rather than by dropping the
  // `<Tooltip>`, and several do so on state that changes while the user is on
  // the page. So an empty label is a state of the same component and never a
  // different shape of tree: returning the bare child here instead of the usual
  // fragment would remount that child every time the label came and went.
  //
  // `open` stays latched underneath while the label is empty, so a label that
  // empties and refills under a stationary pointer comes back without a second
  // enter delay. That is the hover it already paid for, not a new one.
  const isEmpty = title === "" || title === null || title === undefined || title === false;
  const active = open && !isEmpty;

  const close = useCallback(() => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    setOpen(false);
    setPos(null);
  }, []);

  const openAfterDelay = useCallback(
    (anchor: HTMLElement) => {
      anchorRef.current = anchor;
      if (enterTimer.current) clearTimeout(enterTimer.current);
      enterTimer.current = setTimeout(() => {
        enterTimer.current = null;
        setOpen(true);
      }, enterDelay);
    },
    [enterDelay]
  );

  useEffect(() => close, [close]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;

    const rect = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const gap = arrow ? ARROW_GAP : GAP;

    // Flip only when the preferred side has no room *and* the other side does,
    // so a label taller than either gap stays where the caller asked for it.
    let side = placement;
    if (side === "bottom" && rect.bottom + gap + height > vh - EDGE && rect.top - gap - height >= EDGE) {
      side = "top";
    } else if (side === "top" && rect.top - gap - height < EDGE && rect.bottom + gap + height <= vh - EDGE) {
      side = "bottom";
    }

    const top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
    const anchorCenter = rect.left + rect.width / 2;
    const left = Math.min(Math.max(anchorCenter - width / 2, EDGE), Math.max(EDGE, vw - width - EDGE));

    // Once the label has been clamped against an edge it no longer straddles the
    // anchor, so the arrow slides along it to keep pointing at the anchor - 
    // stopping short of the rounded corners.
    const arrowLeft = Math.min(
      Math.max(anchorCenter - left - ARROW_SIZE / 2, EDGE),
      Math.max(EDGE, width - EDGE - ARROW_SIZE)
    );

    setPos((prev) =>
      prev && prev.top === top && prev.left === left && prev.placement === side && prev.arrowLeft === arrowLeft
        ? prev
        : { top, left, placement: side, arrowLeft }
    );
  }, [placement, arrow]);

  // Measure before paint so the label never flashes at its pre-positioned spot.
  useIsomorphicLayoutEffect(() => {
    if (active) reposition();
  }, [active, reposition, title]);

  useEffect(() => {
    if (!active) return;

    // `capture` so a scroll inside any ancestor container is seen, not just the page.
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);

    // An anchor scrolled out from under a stationary pointer never sends a
    // leave event, so without this the label stays up, detached from anything.
    // The observer reports clipping by scroll containers too, not just the
    // viewport, which is what makes it the right test rather than a rect check.
    const anchor = anchorRef.current;
    const observer = anchor
      ? new IntersectionObserver(
          ([entry]) => {
            if (!entry.isIntersecting) close();
          },
          { threshold: 0 }
        )
      : null;
    if (anchor && observer) observer.observe(anchor);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
    };
  }, [active, reposition, close]);

  if (!isValidElement(children)) return <>{children}</>;

  const childProps = children.props;

  // The child keeps whatever handlers it already had; ours run after them.
  function chain<E>(theirs: unknown, ours: (event: E) => void) {
    return (event: E) => {
      if (typeof theirs === "function") (theirs as (e: E) => void)(event);
      ours(event);
    };
  }

  const handlers = {
    onPointerEnter: chain(childProps.onPointerEnter, (e: ReactPointerEvent<HTMLElement>) => {
      // Touch and pen have no "leave", so a label opened by them would never close.
      if (e.pointerType !== "mouse") return;
      openAfterDelay(e.currentTarget);
    }),
    onPointerLeave: chain(childProps.onPointerLeave, close),
    // Pressing the control has answered whatever the label was there to say. It
    // also means no click can strand a label on screen - a press that opens a
    // file dialog or starts a download takes the pointer away without ever
    // sending a leave.
    onPointerDown: chain(childProps.onPointerDown, close),
    onFocus: chain(childProps.onFocus, (e: ReactFocusEvent<HTMLElement>) => {
      // Keyboard focus only - a click already focuses the button it just pressed.
      if (e.currentTarget.matches(":focus-visible")) openAfterDelay(e.currentTarget);
    }),
    onBlur: chain(childProps.onBlur, close),
  };

  // An icon button with no text is named by its tooltip unless it already says
  // otherwise. Losing that name is the one way a tooltip change breaks a screen
  // reader, so it is worth doing here rather than at 200 call sites. A control
  // that shows its own text is already named by it; overwriting that name with
  // the tooltip would hide what is on screen, so the tooltip describes it instead.
  const hasOwnName = Boolean(childProps["aria-label"] || childProps["aria-labelledby"]);
  const hasText = hasTextContent(childProps.children as ReactNode);
  const needsName = typeof title === "string" && !hasOwnName && !hasText;
  const describes = hasText && !hasOwnName && active;
  const theirDescription = typeof childProps["aria-describedby"] === "string" ? childProps["aria-describedby"] : "";

  return (
    <>
      {cloneElement(
        children,
        isEmpty
          ? {}
          : {
              ...handlers,
              ...(needsName ? { "aria-label": title } : {}),
              ...(describes ? { "aria-describedby": `${theirDescription} ${tipId}`.trim() } : {}),
            }
      )}
      {active &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              // Hidden for the frame between mount and measurement.
              visibility: pos ? "visible" : "hidden",
              transformOrigin: pos?.placement === "top" ? "center bottom" : "center top",
            }}
            // Above the z-50/z-[60] modal ladder rather than on it: this is
            // portalled to <body>, and plenty of the labels are on buttons
            // inside a modal. Same reasoning as `Dropdown`'s portalled menu.
            className={`pointer-events-none z-[9999] max-w-[300px] rounded px-2 py-1 text-[0.6875rem] font-medium leading-[1.4] text-white break-words ${CHIP_BG} overlay-menu-enter`}
          >
            {title}
            {arrow && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: pos?.arrowLeft ?? 0,
                  [pos?.placement === "top" ? "bottom" : "top"]: -ARROW_SIZE / 2,
                  width: ARROW_SIZE,
                  height: ARROW_SIZE,
                  transform: "rotate(45deg)",
                }}
                className={CHIP_BG}
              />
            )}
          </div>,
          document.body
        )}
    </>
  );
}

export { Tooltip };
