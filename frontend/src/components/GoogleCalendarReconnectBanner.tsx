"use client";

import CalendarReconnectBanner from "./CalendarReconnectBanner";
import { GOOGLE_CALENDAR_RECONNECT_EVENT } from "@/services/googleCalendarSync.service";

export default function GoogleCalendarReconnectBanner() {
  return <CalendarReconnectBanner eventName={GOOGLE_CALENDAR_RECONNECT_EVENT} />;
}
