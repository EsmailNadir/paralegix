import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import useUserSyncSettings from "@/hooks/calendarHooks/useUserSyncSettings";
import { GoogleCalendarSync, announceGoogleCalendarReconnect } from "@/services/googleCalendarSync.service";
import { OutlookCalendarSync, announceOutlookCalendarReconnect } from "@/services/outlookCalendarSync.service";
import type { CalendarSyncStatus } from "@/contexts/CalendarSyncContext";
import type { CalendarConnectionState } from "@/types/preferences";
import {
  CALENDAR_SYNC_INTERVAL_MS as SYNC_INTERVAL,
  getSharedLastSyncAt,
  setSharedLastSyncAt,
  claimSyncLock,
  releaseSyncLock,
} from "@/utils/calendarSyncLock";

/** Grant states the API reports with `loggedInWith*: false`, which only a reconnect fixes. */
function needsReconnect(state: CalendarConnectionState | undefined): boolean {
  return state === "reconnect_required" || state === "permission_required";
}

/**
 * Runs background calendar sync (Google + Outlook → Paralegix) at the layout level
 * so it triggers regardless of which page the user is on. This is the SOLE sync
 * engine. The calendar component reads the returned status (and the cached event
 * queries this invalidates) instead of running its own duplicate sync.
 *
 * Returns live sync status so the calendar UI can render "Syncing…" indicators
 * and the Outlook reconnect prompt via CalendarSyncContext.
 */
export function useCalendarBackgroundSync(lawFirmId: string | undefined): CalendarSyncStatus {
  const { features, loading: firmSettingsLoading } = useFirmSettings();
  const queryClient = useQueryClient();
  const calendarSyncEnabled = features.calendarSync;
  // Shared cache with the calendar UI, one GET /settings/user across consumers.
  const { syncFlags } = useUserSyncSettings(lawFirmId, calendarSyncEnabled);

  const [syncingGoogle, setSyncingGoogle] = useState(false);
  const [syncingOutlook, setSyncingOutlook] = useState(false);
  const [outlookError, setOutlookError] = useState<string | null>(null);

  const lastGoogleSyncRef = useRef<number | null>(null);
  const lastOutlookSyncRef = useRef<number | null>(null);
  const googleInFlightRef = useRef(false);
  const outlookInFlightRef = useRef(false);
  const tabIdRef = useRef(`tab_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  const isLocal = typeof window !== "undefined" && window.location.hostname === "localhost";

  // Refresh the calendar's cached data after a sync pulls in new external events.
  // External events feed the calendar from both the tasks query (provider-backed
  // tasks) and the dedicated externalEvents query, so both are invalidated.
  const refreshCalendarData = () => {
    if (!lawFirmId) return;
    queryClient.invalidateQueries({ queryKey: ["tasks", lawFirmId] });
    queryClient.invalidateQueries({ queryKey: ["externalEvents", lawFirmId] });
    queryClient.invalidateQueries({ queryKey: ["matterEvents", lawFirmId] });
    queryClient.invalidateQueries({ queryKey: ["clientEvents", lawFirmId] });
  };

  // A grant that needs a reconnect turns `loggedInWith*` off, so sync never
  // calls the provider and never meets the 401 that raises the reconnect
  // banner. Raise it from the API's state instead, once per state change, so a
  // refetch of the same state does not reopen a banner the person dismissed.
  const announcedStateRef = useRef<{ google?: CalendarConnectionState; microsoft?: CalendarConnectionState }>({});
  useEffect(() => {
    if (!syncFlags || firmSettingsLoading || !calendarSyncEnabled) return;
    const announced = announcedStateRef.current;
    const google = syncFlags.googleCalendarState;
    const microsoft = syncFlags.microsoftCalendarState;
    if (needsReconnect(google) && announced.google !== google) announceGoogleCalendarReconnect();
    if (needsReconnect(microsoft) && announced.microsoft !== microsoft) announceOutlookCalendarReconnect();
    announced.google = google;
    announced.microsoft = microsoft;
  }, [syncFlags, firmSettingsLoading, calendarSyncEnabled]);

  // Run sync on mount and on an interval
  useEffect(() => {
    if (!lawFirmId || !syncFlags || isLocal || firmSettingsLoading || !calendarSyncEnabled) return;

    const syncGoogle = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!syncFlags.loggedInWithGoogle || !syncFlags.allowGoogleToParalegixSync) return;
      const now = Date.now();
      const lastSharedSync = getSharedLastSyncAt("google", lawFirmId);
      if (lastGoogleSyncRef.current && now - lastGoogleSyncRef.current < SYNC_INTERVAL) return;
      if (lastSharedSync && now - lastSharedSync < SYNC_INTERVAL) return;
      if (googleInFlightRef.current) return;
      if (!claimSyncLock("google", lawFirmId, tabIdRef.current)) return;
      try {
        googleInFlightRef.current = true;
        setSyncingGoogle(true);
        try { await GoogleCalendarSync.initParalegixCalendar(); } catch {}
        await GoogleCalendarSync.syncFromGoogle(lawFirmId);
        lastGoogleSyncRef.current = now;
        setSharedLastSyncAt("google", lawFirmId, now);
        refreshCalendarData();
      } catch (err: any) {
        console.warn("Background Google sync failed:", err?.message || err);
      } finally {
        setSyncingGoogle(false);
        googleInFlightRef.current = false;
        releaseSyncLock("google", lawFirmId, tabIdRef.current);
      }
    };

    const syncOutlook = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!syncFlags.loggedInWithMicrosoft || !syncFlags.allowOutlookToParalegixSync) return;
      const now = Date.now();
      const lastSharedSync = getSharedLastSyncAt("outlook", lawFirmId);
      if (lastOutlookSyncRef.current && now - lastOutlookSyncRef.current < SYNC_INTERVAL) return;
      if (lastSharedSync && now - lastSharedSync < SYNC_INTERVAL) return;
      if (outlookInFlightRef.current) return;
      if (!claimSyncLock("outlook", lawFirmId, tabIdRef.current)) return;
      try {
        outlookInFlightRef.current = true;
        setSyncingOutlook(true);
        try { await OutlookCalendarSync.initParalegixCalendar(); } catch {}
        const syncResult = await OutlookCalendarSync.syncFromOutlook(lawFirmId);
        if (syncResult && syncResult.success === false) {
          setOutlookError(syncResult.error || "Failed to sync from Outlook");
          return;
        }
        lastOutlookSyncRef.current = now;
        setSharedLastSyncAt("outlook", lawFirmId, now);
        setOutlookError(null);
        refreshCalendarData();
      } catch (err: any) {
        setOutlookError(err?.message || "Outlook sync failed");
        console.warn("Background Outlook sync failed:", err?.message || err);
      } finally {
        setSyncingOutlook(false);
        outlookInFlightRef.current = false;
        releaseSyncLock("outlook", lawFirmId, tabIdRef.current);
      }
    };

    // Run immediately
    syncGoogle();
    syncOutlook();

    // Then repeat on interval
    const interval = setInterval(() => {
      syncGoogle();
      syncOutlook();
    }, SYNC_INTERVAL);

    const onVisible = () => {
      if (!document.hidden) { void syncGoogle(); void syncOutlook(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshCalendarData is stable per lawFirmId; queryClient identity is stable
  }, [lawFirmId, syncFlags, isLocal, firmSettingsLoading, calendarSyncEnabled]);

  return { syncingGoogle, syncingOutlook, outlookError };
}
