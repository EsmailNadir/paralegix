"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useNavigation } from "@/contexts/NavigationContext";

/**
 * Listens for calendar API 401s and shows a dismissible strip with a link to Settings
 * (OAuth redirect only happens from Settings → Connect Google, not from background sync).
 */
export default function CalendarReconnectBanner({ eventName }: { eventName: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const { navigate } = useNavigation();
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId;

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ message?: string }>;
      setMessage(ce.detail?.message ?? null);
    };
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [eventName]);

  const onOpenSettings = useCallback(() => {
    if (lawFirmId) navigate(`/lawfirm/${lawFirmId}/settings/general`);
    setMessage(null);
  }, [lawFirmId, navigate]);

  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
        >
          Open Settings
        </button>
        <button
          type="button"
          onClick={() => setMessage(null)}
          className="rounded-md px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
