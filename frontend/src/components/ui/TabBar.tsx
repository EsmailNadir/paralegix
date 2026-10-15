"use client";

import { useCallback } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import useHorizontalOverflow from "@/hooks/useHorizontalOverflow";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";

export interface TabBarTab<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Badge on the tab. Zero or undefined draws nothing. */
  count?: number;
  /**
   * Push this tab to the right-hand group. Only has an effect under
   * `align="split"`; see the note on that prop.
   */
  secondary?: boolean;
  /**
   * Greys the tab out and stops it being selected. For a view that cannot be
   * entered *right now* (a save is in flight), not for one the user lacks
   * permission for - filter those out of `tabs` instead, so the bar does not
   * advertise a view that will never open.
   */
  disabled?: boolean;
}

/**
 * The underlined tab strip that splits one page into several views.
 *
 * This is for views of a whole page - a page's own top-level sections, each with
 * its own search, filters and paging. `SegmentedToggle` is the other control and
 * a different job: it swaps how one list is drawn (rows or cards), not which
 * list is on screen.
 *
 * The active tab is marked by a single indigo underline that slides to match
 * whichever tab is selected, continuing the bar's own border so the selected
 * view reads as attached to the content below it. Counts ride on the tab
 * itself, which is what lets someone choose a view before opening it.
 *
 * The strip scrolls horizontally when the tabs outrun their container, and shows
 * a fade plus a chevron at whichever end still has tabs behind it. The scrollbar
 * is hidden and a mouse wheel only scrolls vertically, so without the chevrons a
 * mouse user on a narrow window has no way to reach the tabs off-screen - and no
 * way to know they exist.
 */
export default function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  align = "start",
  density = "comfortable",
  trailing,
  className = "",
}: {
  tabs: TabBarTab<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `start` runs every tab together from the left.
   *
   * `split` pins the tabs marked `secondary` to the right-hand end, which is how
   * a bar separates the views someone works in daily from the ones they
   * configure occasionally (billing's "Rates & setup" against its five working
   * views). The separation is spatial only: a secondary tab is the same control
   * with the same states, so nothing about it reads as lesser.
   */
  align?: "start" | "split";
  /**
   * `comfortable` (the default) is the page-level bar: the underline hugs the
   * label rather than a padded box, and the tabs are spaced far enough apart to
   * read as separate destinations on a full-width page.
   *
   * `compact` tightens both for a strip inside a card or a modal, where the
   * page-level spacing would push the last tab off the edge.
   */
  density?: "comfortable" | "compact";
  /**
   * Content pinned to the right-hand end of the bar - an action that belongs to
   * the strip rather than to one tab ("Edit lines" beside an invoice's tabs).
   * Sits outside the tab list, so it is not reachable by the tab semantics and
   * does not shift when tabs scroll.
   */
  trailing?: React.ReactNode;
  className?: string;
}) {
  const tabMetrics = density === "compact" ? "px-4 py-2.5" : "px-1 py-3";
  const groupGap = density === "compact" ? "gap-1" : "gap-6 md:gap-8";
  const { ref: scrollRef, overflow, scrollStep, onWheel } = useHorizontalOverflow<HTMLDivElement>();
  const underline = useSlidingHighlight<HTMLDivElement>(value);
  // The scrolling strip is what the underline has to move with (so it stays
  // under its tab while the strip scrolls), but `useHorizontalOverflow` also
  // needs that same node for its own overflow measurement: one DOM element,
  // two refs to attach. Memoized so the ref callback's identity is stable:
  // an inline function here would get a new identity every render, and React
  // re-invokes a ref whose identity changed on every commit, re-triggering
  // the highlight's measure-and-setState on every render, forever.
  const setScrollNode = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      underline.containerRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `underline` is a fresh object every render; only its (stable) `containerRef` matters here, and including the whole object would defeat the memoization this exists for
    [scrollRef, underline.containerRef]
  );

  const renderTab = (tab: TabBarTab<T>) => {
    const active = tab.value === value;
    const Icon = tab.icon;

    return (
      <button
        key={tab.value}
        type="button"
        disabled={tab.disabled}
        aria-current={active ? "true" : undefined}
        onClick={() => onChange(tab.value)}
        className={`group flex items-center whitespace-nowrap rounded text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          tab.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        } ${
          active
            ? "text-accent-emphasis"
            : "text-on-surface-secondary hover:text-on-surface"
        }`}
      >
        {/* The shared underline (rendered once, below) tracks whichever of these
            spans is active, so this per-tab border only ever shows on hover. It
            still has to measure the tab's whole content, count included: the
            span carries the tab's padding so the underline spans the button's
            full height and its border lands on the bar's own. */}
        <span
          ref={underline.registerItem(tab.value)}
          className={`flex items-center gap-2 border-b-2 ${tabMetrics} transition-colors ${
            active ? "border-transparent" : "border-transparent group-hover:border-outline"
          }`}
        >
          {Icon && <Icon size={16} />}
          {tab.label}
          {tab.count ? (
            <span className="rounded-full bg-surface-alt px-2 py-0.5 text-xs font-semibold text-on-surface-secondary">
              {tab.count}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  // The two groups are separate flex children so `justify-between` can hold them
  // apart. Under `align="start"` they collapse back to one run, which keeps a
  // stray `secondary` flag from silently changing a bar that never opted in.
  const primary = align === "split" ? tabs.filter((t) => !t.secondary) : tabs;
  const secondary = align === "split" ? tabs.filter((t) => t.secondary) : [];

  return (
    <div className={`relative border-b-2 border-outline ${className}`}>
      {overflow.left && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-surface to-transparent" />
          <button
            type="button"
            onClick={() => scrollStep(-1)}
            aria-label="Scroll tabs left"
            className="absolute inset-y-0 left-0 z-20 flex items-center justify-center px-1.5 text-on-surface-secondary hover:text-on-surface cursor-pointer"
          >
            <ChevronLeft size={18} />
          </button>
        </>
      )}

      <div
        ref={setScrollNode}
        onWheel={onWheel}
        // `overflow-y-hidden` is deliberate, not decorative: setting only
        // overflow-x leaves the y-axis's used value at `auto` per the CSS
        // Overflow spec, so a single stray pixel of vertical overflow (icon
        // baseline, an underline riding a hair below the row) is enough to
        // make a vertical scrollbar appear on a strip that only ever needs
        // to scroll sideways.
        className="relative flex items-center justify-between gap-1 overflow-x-auto overflow-y-hidden scrollbar-hide"
      >
        {underline.rect && (
          <span
            aria-hidden
            className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis transition-[transform,width] duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            style={{
              width: underline.rect.width,
              transform: `translateX(${underline.rect.left}px)`,
            }}
          />
        )}
        <div className={`flex items-center ${groupGap}`}>{primary.map(renderTab)}</div>
        {(secondary.length > 0 || trailing) && (
          <div className={`flex items-center ${groupGap}`}>
            {secondary.map(renderTab)}
            {trailing}
          </div>
        )}
      </div>

      {overflow.right && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-surface to-transparent" />
          <button
            type="button"
            onClick={() => scrollStep(1)}
            aria-label="Scroll tabs right"
            className="absolute inset-y-0 right-0 z-20 flex items-center justify-center px-1.5 text-on-surface-secondary hover:text-on-surface cursor-pointer"
          >
            <ChevronRight size={18} />
          </button>
        </>
      )}
    </div>
  );
}
