import type { QueryClient } from "@tanstack/react-query";
import { fetchAndSeed } from "@/lib/query/seedQueries";
import calendarEventsService, { type CalendarFeedResponse } from "@/services/calendarEvents.service";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { Event, PaymentDate, Task } from "@/types";
import type { MatterEvent } from "@/types/matterEvent";
import type { ClientEvent } from "@/types/clientEvent";

/**
 * The cache keys and response shaping for the five datasets the calendar draws,
 * shared by the per-section hooks and by the one-request calendar feed that
 * fills them.
 *
 * Every key keeps the prefix the rest of the app invalidates (["matterEvents",
 * firm], ["clientEvents", firm], ["externalEvents", firm], ["tasks", firm],
 * ["billing", "paymentDates", firm]), so a mutation or the background sync still
 * refreshes a section by prefix match. The section hooks keep their own
 * per-endpoint query functions for exactly that: an invalidated section re-reads
 * only itself.
 */

type Bounds = Pick<CalendarWindow, "from" | "to"> | undefined;

export const matterEventsWindowKey = (lawFirmId: string | undefined, window: Bounds, tz: string) =>
  ["matterEvents", lawFirmId, "window", window?.from ?? null, window?.to ?? null, tz] as const;

export const clientEventsWindowKey = (lawFirmId: string | undefined, window: Bounds, tz: string) =>
  ["clientEvents", lawFirmId, "window", window?.from ?? null, window?.to ?? null, tz] as const;

export const externalEventsWindowKey = (lawFirmId: string | undefined, window: Bounds, tz: string) =>
  ["externalEvents", lawFirmId, "window", window?.from ?? null, window?.to ?? null, tz] as const;

export const calendarTasksWindowKey = (lawFirmId: string | undefined, window: Bounds, tz: string) =>
  ["tasks", lawFirmId, "calendarWindow", window?.from ?? null, window?.to ?? null, tz] as const;

export const paymentDatesWindowKey = (lawFirmId: string | undefined, window: Bounds) =>
  ["billing", "paymentDates", lawFirmId, "window", window?.from ?? null, window?.to ?? null] as const;

export const calendarFeedKey = (lawFirmId: string | undefined, window: Bounds, tz: string) =>
  ["calendarFeed", lawFirmId, window?.from ?? null, window?.to ?? null, tz] as const;

// The calendar never renders cancelled events, so the cached lists leave them out.
export const selectMatterEvents = (body: { events: MatterEvent[] }): MatterEvent[] =>
  body.events.filter((e) => e.status !== "cancelled");

export const selectClientEvents = (body: { events?: ClientEvent[] }): ClientEvent[] =>
  (Array.isArray(body?.events) ? body.events : []).filter((e) => e.status !== "cancelled");

export const selectExternalEvents = (body: { events?: Event[] }): Event[] =>
  (Array.isArray(body?.events) ? body.events : []);

export const selectTasks = (body: { tasks: Task[] }): Task[] => body.tasks;

export const selectPaymentDates = (body: { paymentDates?: PaymentDate[] }): PaymentDate[] =>
  body.paymentDates || [];

/**
 * Read one window through the calendar feed and write each section it returned
 * into that section's own cache entry (see `fetchAndSeed`).
 *
 * A null section (no permission) is left unwritten, so its hook falls back to
 * its own endpoint and renders exactly what it did before the feed existed.
 *
 * Resolves to the sections it wrote, which is all the feed query caches.
 */
export function loadCalendarFeed(
  queryClient: QueryClient,
  lawFirmId: string,
  window: CalendarWindow,
  tz: string,
): Promise<string[]> {
  return fetchAndSeed<CalendarFeedResponse>(
    queryClient,
    () => calendarEventsService.getCalendarFeed(lawFirmId, window),
    (feed) => [
      feed.matterEvents && { name: "matterEvents", key: matterEventsWindowKey(lawFirmId, window, tz), data: selectMatterEvents(feed.matterEvents) },
      feed.clientEvents && { name: "clientEvents", key: clientEventsWindowKey(lawFirmId, window, tz), data: selectClientEvents(feed.clientEvents) },
      feed.calendarEvents && { name: "externalEvents", key: externalEventsWindowKey(lawFirmId, window, tz), data: selectExternalEvents(feed.calendarEvents) },
      feed.tasks && { name: "tasks", key: calendarTasksWindowKey(lawFirmId, window, tz), data: selectTasks(feed.tasks) },
      feed.paymentDates && { name: "paymentDates", key: paymentDatesWindowKey(lawFirmId, window), data: selectPaymentDates(feed.paymentDates) },
    ],
  );
}
