"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import dayjs, { type Dayjs } from "dayjs";
import { useMountTransition } from "@/hooks/useMountTransition";

export const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_FMT = "YYYY-MM-DD";

/** The 6x7 day grid for the month `cursor` falls in, including the leading/trailing days of adjacent months that fill out the first/last week. */
export function useCalendarWeeks(cursor: Dayjs) {
  return useMemo(() => {
    const gridStart = cursor.startOf("month").startOf("week");
    const days: Dayjs[] = [];
    let d = gridStart;
    for (let i = 0; i < 42; i++) {
      days.push(d);
      d = d.add(1, "day");
    }
    const rows: Dayjs[][] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [cursor]);
}

/** Clearance kept from every viewport edge. */
const VIEWPORT_MARGIN = 8;
/** The step between the trigger and the popover, on whichever side it opens. */
const TRIGGER_GAP = 4;
/** Used until the popover is in the DOM and can be measured. */
const ASSUMED_HEIGHT = 340;
/** A calendar narrower than this is unusable, so it scrolls sideways instead. */
const MIN_WIDTH = 240;

/**
 * Where a calendar popover goes, given its trigger and its own size.
 *
 * Split out from the hook so the rules can be read and tested on their own:
 * every branch here exists for a viewport that some screen actually has.
 *
 * `triggerRect` is viewport-relative, matching the `position: fixed` the result
 * carries. `measuredHeight` is absent on the first pass, before the popover is
 * in the DOM.
 */
export function placePopover(
  triggerRect: { top: number; bottom: number; left: number; right: number },
  popoverWidth: number,
  measuredHeight?: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): CSSProperties {
  const popH = measuredHeight || ASSUMED_HEIGHT;
  const spaceBelow = viewport.height - triggerRect.bottom - VIEWPORT_MARGIN - TRIGGER_GAP;
  const spaceAbove = triggerRect.top - VIEWPORT_MARGIN - TRIGGER_GAP;

  // Prefer opening below; flip above only when below doesn't fit the popover's
  // real height AND above has more room, so the side that actually fits (when
  // one does) wins rather than whichever is merely bigger. If neither fits (a
  // short viewport, or `DateTimePicker`'s taller popover), `maxHeight` clamps
  // to whatever room exists so the popover scrolls internally instead of being
  // clipped with no way to reach the Clear/Done row.
  const openUp = popH > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(120, openUp ? spaceAbove : spaceBelow);

  // A phone can be narrower than the calendar. Shrink to the viewport before
  // placing it, so the clamps below cannot be defeated by the width itself.
  const width = Math.max(MIN_WIDTH, Math.min(popoverWidth, viewport.width - VIEWPORT_MARGIN * 2));

  // Lined up with the trigger's left edge, flipping to its right edge only when
  // the left-aligned box would leave the viewport. A picker at the end of a
  // filter row is the case that flip is for. The outer clamps catch the rest: a
  // trigger near the left edge, and a viewport narrower than the popover.
  const overflowsRight = triggerRect.left + width + VIEWPORT_MARGIN > viewport.width;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, overflowsRight ? triggerRect.right - width : triggerRect.left),
    Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN),
  );

  // Opening upward pins the BOTTOM edge rather than deriving a top from the
  // height: `popH` is a measurement that is only right once the popover is in
  // the DOM, and every pixel it overshoots by would otherwise open a gap
  // between the popover and the trigger it belongs to.
  return {
    position: "fixed",
    left,
    width,
    maxHeight: Math.min(popH, available),
    ...(openUp
      ? { bottom: Math.max(VIEWPORT_MARGIN, viewport.height - triggerRect.top + TRIGGER_GAP) }
      : { top: Math.min(triggerRect.bottom + TRIGGER_GAP, viewport.height - VIEWPORT_MARGIN) }),
  };
}

/**
 * Shared open/close + positioning/outside-click/escape state for the calendar
 * popovers (`DatePicker`, `DateRangePicker`). Mirrors `Dropdown.tsx`'s portal
 * shape (fixed position measured off the trigger, flips above when there
 * isn't room below, closes on an outside mousedown or Escape) so both read as
 * just another menu in the app rather than a one-off widget.
 */
export function useDatePickerPopover(seedDate: string | undefined, popoverWidth = 288) {
  const [openState, setOpenState] = useState(false);
  const openRef = useRef(false);
  const setOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(openRef.current) : next;
    if (value === openRef.current) return;
    openRef.current = value;
    setOpenState(value);
  }, []);

  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [cursor, setCursor] = useState<Dayjs>(() => dayjs(seedDate || undefined).startOf("month"));
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const { mounted, exiting } = useMountTransition(openState, 150);

  // Re-seed the visible month from the current selection each time the
  // popover opens, so reopening after picking a date in another month doesn't
  // strand the viewer on whatever month they last scrolled to.
  useEffect(() => {
    if (!openState) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reseeds the visible month from the current selection each time the popover opens
    setCursor(dayjs(seedDate || undefined).startOf("month"));
  }, [openState, seedDate]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!openRef.current) return;
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (!openRef.current) return;
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [setOpen]);

  useEffect(() => {
    if (!openState) return;
    const update = () => {
      if (!btnRef.current) return;
      setMenuStyle(
        placePopover(btnRef.current.getBoundingClientRect(), popoverWidth, popoverRef.current?.offsetHeight),
      );
    };
    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [openState, popoverWidth]);

  return { openState, setOpen, menuStyle, cursor, setCursor, btnRef, popoverRef, mounted, exiting };
}
