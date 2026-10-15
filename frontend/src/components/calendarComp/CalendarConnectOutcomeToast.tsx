"use client";

import Toast from "@/components/ui/Toast";
import useCalendarConnectOutcome from "@/hooks/calendarHooks/useCalendarConnectOutcome";

/**
 * Reports a calendar connect outcome on whichever page the OAuth callback
 * returned to. The trigger (the Connect button) is gone by then, so the
 * outcome is a toast rather than an inline banner.
 */
export default function CalendarConnectOutcomeToast({
  lawFirmId,
  onConnected,
}: {
  lawFirmId?: string;
  onConnected?: () => void;
}) {
  const { notice, dismiss } = useCalendarConnectOutcome({ lawFirmId, onConnected });
  if (!notice) return null;
  return <Toast message={notice.message} tone={notice.tone} onDismiss={dismiss} />;
}
