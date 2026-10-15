/**
 * Formatting and filter helpers shared by the platform-admin console tables.
 *
 * These live outside the pages because the user list and the client list ask the
 * same questions of different tables - when did this appear, how long ago - and
 * the two answers have to read identically for the numbers to be comparable.
 */

import { formatTimeAgo } from "@/lib/utils/dateUtils";

/** Rolling windows the console offers for "created in the last …". */
export const RECENCY_WINDOWS = [
  { label: "Any time", value: "" },
  { label: "Last 24 hours", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
] as const;

/**
 * Resolve a window value into the ISO instant it starts at, for the endpoints'
 * `createdAfter` bound. Returns undefined for "any time", which is the signal to
 * omit the filter rather than send an unbounded one.
 */
export function recencyWindowStart(value: string): string | undefined {
  const days = Number(value);
  if (!days || Number.isNaN(days)) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Absolute local date + time, or an em dash when there is nothing to show. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * How long ago something happened. Paired with the absolute timestamp in a
 * tooltip rather than replacing it: the relative form is what makes a list
 * scannable, the absolute one is what makes it verifiable.
 */
export function formatAge(iso: string | null | undefined): string {
  return formatTimeAgo(iso, "-");
}

/** Percentage of `total`, rendered as a share label. Empty when there is no total. */
export function shareLabel(value: number, total: number, suffix = "of total"): string | undefined {
  if (!total) return undefined;
  return `${Math.round((value / total) * 100)}% ${suffix}`;
}
