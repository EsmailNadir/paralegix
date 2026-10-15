"use client";

import { createContext, useContext } from "react";

// Live status of the layout-level background calendar sync (Google + Outlook →
// Paralegix). The sync engine runs once per firm session in the layout; the
// calendar UI reads this context to show "Syncing…" indicators and the Outlook
// reconnect prompt without owning its own duplicate sync engine.
export type CalendarSyncStatus = {
  syncingGoogle: boolean;
  syncingOutlook: boolean;
  outlookError: string | null;
};

const DEFAULT_STATUS: CalendarSyncStatus = {
  syncingGoogle: false,
  syncingOutlook: false,
  outlookError: null,
};

export const CalendarSyncContext = createContext<CalendarSyncStatus>(DEFAULT_STATUS);

export function useCalendarSyncStatus(): CalendarSyncStatus {
  return useContext(CalendarSyncContext);
}
