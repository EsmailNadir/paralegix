/**
 * Shared cross-component / cross-tab dedupe primitives for calendar sync.
 *
 * Used by both `useCalendarBackgroundSync` (mounted on matters/tasks/calendar
 * pages) and `Calendar.tsx`'s in-component sync effect, so that navigating
 * between pages does not re-trigger a sync that was already done recently.
 *
 * Persistence is `localStorage` so the timestamp survives component unmount
 * and is shared across browser tabs.
 */

export type CalendarSyncProvider = "google" | "outlook";

export const CALENDAR_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const CALENDAR_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;  // 5 min

function key(provider: CalendarSyncProvider, lawFirmId: string, suffix: string) {
  return `paralegix:${provider}:calendar-sync:${lawFirmId}:${suffix}`;
}

export function getSharedLastSyncAt(provider: CalendarSyncProvider, lawFirmId: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(provider, lawFirmId, "last"));
    const value = raw ? Number(raw) : null;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function setSharedLastSyncAt(provider: CalendarSyncProvider, lawFirmId: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(provider, lawFirmId, "last"), String(value));
  } catch {
    // Best-effort cross-tab dedupe; backend throttling still protects production.
  }
}

export function claimSyncLock(provider: CalendarSyncProvider, lawFirmId: string, ownerId: string): boolean {
  if (typeof window === "undefined") return true;
  const lockKey = key(provider, lawFirmId, "lock");
  const now = Date.now();
  try {
    const current = JSON.parse(window.localStorage.getItem(lockKey) || "null");
    if (current?.expiresAt && current.expiresAt > now && current.ownerId !== ownerId) {
      return false;
    }
    window.localStorage.setItem(lockKey, JSON.stringify({
      ownerId,
      expiresAt: now + CALENDAR_SYNC_LOCK_TTL_MS,
    }));
    return true;
  } catch {
    return true;
  }
}

export function releaseSyncLock(provider: CalendarSyncProvider, lawFirmId: string, ownerId: string): void {
  if (typeof window === "undefined") return;
  const lockKey = key(provider, lawFirmId, "lock");
  try {
    const current = JSON.parse(window.localStorage.getItem(lockKey) || "null");
    if (current?.ownerId === ownerId) {
      window.localStorage.removeItem(lockKey);
    }
  } catch {
    window.localStorage.removeItem(lockKey);
  }
}
