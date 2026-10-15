"use client";

import CalendarReconnectBanner from "./CalendarReconnectBanner";
import { OUTLOOK_CALENDAR_RECONNECT_EVENT } from "@/services/outlookCalendarSync.service";

export default function OutlookCalendarReconnectBanner() {
  return <CalendarReconnectBanner eventName={OUTLOOK_CALENDAR_RECONNECT_EVENT} />;
}
