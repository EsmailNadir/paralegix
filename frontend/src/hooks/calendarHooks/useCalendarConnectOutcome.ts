"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import settingsService from "@/services/settings.service";
import { track } from "@/lib/analytics/analytics";
import type { StatusVariant } from "@/constants/statusMeta";
import {
  CONNECT_OUTCOME_PARAMS,
  connectOutcomeMessage,
  connectOutcomeQuery,
  connectedMessage,
  readConnectOutcome,
  unconfirmedConnectMessage,
} from "@/lib/utils/calendarConnectOutcome";

export interface CalendarConnectNotice {
  message: string;
  tone: StatusVariant;
}

/**
 * Reads the outcome a calendar connect callback left on the URL, removes it,
 * and turns it into one notice.
 *
 * The URL only says the API finished its callback, so a success is confirmed
 * by a fresh settings read before it is shown or tracked. Mounted once per
 * shell (the firm layout and the dashboard), so whichever page the callback
 * returns to reports the outcome.
 */
export default function useCalendarConnectOutcome({
  lawFirmId,
  onConnected,
}: {
  lawFirmId?: string;
  /** Runs after a confirmed connect, for the shell to refresh what it caches. */
  onConnected?: () => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [notice, setNotice] = useState<CalendarConnectNotice | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  // Removing the params changes `searchParams` and re-runs this effect, so the
  // outcome being handled is remembered rather than cancelled on cleanup.
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const outcome = readConnectOutcome(searchParams);
    const key = connectOutcomeQuery(searchParams);
    if (!outcome || handledRef.current === key) return;
    handledRef.current = key;

    const rest = new URLSearchParams(searchParams.toString());
    CONNECT_OUTCOME_PARAMS.forEach((param) => rest.delete(param));
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });

    if (!outcome.connected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- turns the callback's URL outcome (external input) into a notice once
      setNotice({ message: connectOutcomeMessage(outcome.provider, outcome.code ?? ""), tone: "danger" });
      return;
    }

    const unconfirmed = { message: unconfirmedConnectMessage(outcome.provider), tone: "danger" as const };
    settingsService
      .getUserSettings(lawFirmId)
      .then(({ preferences }) => {
        const state = outcome.provider === "google"
          ? preferences?.googleCalendarState
          : preferences?.microsoftCalendarState;
        if (state !== "connected") {
          setNotice(unconfirmed);
          return;
        }
        track("calendar_connected", { provider: outcome.provider === "google" ? "google" : "outlook" });
        onConnectedRef.current?.();
        setNotice({ message: connectedMessage(outcome.provider), tone: "success" });
      })
      .catch(() => setNotice(unconfirmed));
  }, [searchParams, router, pathname, lawFirmId]);

  return { notice, dismiss: () => setNotice(null) };
}
