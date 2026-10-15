"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import { useNotificationsRealtime } from "@/hooks/notificationHooks/useNotificationsRealtime";
import { notificationHref } from "./notificationHref";

interface ToastItem {
  id: string;
  title: string;
  body: string;
  href: string | null;
}

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 6000;

/**
 * Global, single-mount toaster for newly-arrived notifications. Subscribes to
 * the shared Realtime channel via `useNotificationsRealtime`'s `onNew` callback
 * and shows a transient toast per inserted row. Mounted once in the law-firm
 * layout (the NotificationBell mounts subscribe to the same channel for the
 * badge, so only this mount registers `onNew`. The toast fires once per row.
 */
export default function NotificationToaster({ lawFirmId }: { lawFirmId: string }) {
  const { navigate } = useNavigation();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Per-toast auto-dismiss timers, keyed by toast id. Tracked so a manual
  // dismiss can cancel the pending auto-dismiss, and so all pending timers can
  // be cleared on unmount (otherwise a timer firing after navigation would
  // setState on an unmounted toaster).
  const dismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = dismissTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // The Realtime row is raw DB shape (snake_case columns), not the camelCase API
  // entity, map the few fields the toast needs.
  const onNew = useCallback((row: any) => {
    if (!row?.id) return;
    const item: ToastItem = {
      id: row.id,
      title: row.title || "New notification",
      body: row.body || "",
      href: notificationHref(
        {
          type: row.type,
          actionUrl: row.action_url,
          entityType: row.entity_type,
          entityId: row.entity_id,
          matterId: row.matter_id,
        },
        "firm",
        lawFirmId,
      ),
    };
    setToasts((prev) => {
      if (prev.some((t) => t.id === item.id)) return prev;
      // Keep only the most recent MAX_VISIBLE toasts on screen.
      return [...prev, item].slice(-MAX_VISIBLE);
    });
    // Schedule auto-dismiss off the ref (read synchronously. The setToasts
    // updater above may run during a deferred render, so its result can't gate
    // this). A pending timer for this id means a duplicate realtime event, so
    // keep the original rather than stacking a second timer.
    if (!dismissTimers.current.has(item.id)) {
      const timer = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
      dismissTimers.current.set(item.id, timer);
    }
  }, [dismiss, lawFirmId]);

  useNotificationsRealtime(lawFirmId, { onNew });

  // Cancel any pending auto-dismiss timers when the toaster unmounts so they
  // can't fire setState after navigation away from the layout.
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const handleClick = (toast: ToastItem) => {
    dismiss(toast.id);
    // Navigate with the in-app router so the loading spinner shows.
    if (toast.href) navigate(toast.href);
  };

  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 print:hidden">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onClick={() => handleClick(toast)}
          className="w-80 max-w-[calc(100vw-3rem)] cursor-pointer rounded-xl border border-outline bg-surface shadow-xl p-3 flex items-start gap-3 hover:bg-surface-hover transition-colors"
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
            <Bell size={15} strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-on-surface truncate">{toast.title}</p>
            {toast.body && (
              <p className="text-xs text-on-surface-secondary line-clamp-2">{toast.body}</p>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); dismiss(toast.id); }}
            className="text-on-surface-muted hover:text-on-surface cursor-pointer"
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
