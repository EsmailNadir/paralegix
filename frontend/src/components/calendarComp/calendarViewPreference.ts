export type CalendarViewMode = "month" | "week" | "day";

const STORAGE_KEY = "paralegix-calendar-view";
const MOBILE_BREAKPOINT = 768;

function isViewMode(value: string | null): value is CalendarViewMode {
  return value === "month" || value === "week" || value === "day";
}

/**
 * The view the calendar should open on: the user's saved choice, or month on a
 * phone-width viewport where the week grid is too cramped to be useful.
 *
 * Both the calendar and its loading skeleton resolve the view through this, so
 * the placeholder draws the same grid the real calendar is about to draw.
 * Returns "week" during SSR, where neither storage nor a viewport exists.
 */
export function readSavedCalendarView(): CalendarViewMode {
  if (typeof window === "undefined") return "week";
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); fall through
    // to the viewport-based default rather than failing to render.
  }
  if (isViewMode(saved)) return saved;
  return window.innerWidth < MOBILE_BREAKPOINT ? "month" : "week";
}

export function saveCalendarView(view: CalendarViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // A failed write only costs the preference on the next visit.
  }
}
