"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bell, CheckCheck, FileText, FolderOpen, MessageSquare, DollarSign } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import Tooltip from "@/components/ui/Tooltip";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import Spinner from "@/components/ui/Spinner";
import { useClientNotifications } from "@/hooks/notificationHooks/useClientNotifications";
import type { PortalNotification } from "@/services/client-portal.service";
import { notificationHref } from "./notificationHref";
import ErrorNotification from '@/components/ErrorNotification';
import { getErrorMessage } from '@/lib/utils/apiErrors';

interface ClientNotificationBellProps {
  lawFirmId?: string;
  /** Rendered smaller in the mobile top bar. */
  compact?: boolean;
}

function iconFor(n: PortalNotification) {
  if (n.entityType === "file" || n.type === "file_shared") return FolderOpen;
  if (n.entityType === "message" || n.type === "message") return MessageSquare;
  if (n.entityType === "invoice") return DollarSign;
  return FileText;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ClientNotificationBell({ lawFirmId, compact = false }: ClientNotificationBellProps) {
  const { navigate } = useNavigation();
  const [open, setOpen] = useState(false);
  const { mounted, exiting } = useMountTransition(open, 150);
  const containerRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [actionError, setActionError] = useState('');
  const { notifications, unreadCount, markRead, markAllRead, loadMore, loadingMore, hasMore, loading, error } =
    useClientNotifications(lawFirmId);

  // Close on outside click / Escape. The bell also sits inside the portal's
  // mobile drawer, a `useDialog` dialog that closes on a document-level Escape.
  // The key is taken in the capture phase and stopped there, so one Escape
  // closes only the bell and the next one closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      bellRef.current?.focus();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const handleRowClick = (n: PortalNotification) => {
    if (!n.read) void Promise.resolve(markRead(n.id)).catch(err => setActionError(getErrorMessage(err, 'Failed to mark notification read')));
    const path = notificationHref(n, "portal", lawFirmId);
    setOpen(false);
    if (path) navigate(path);
  };

  const iconSize = compact ? 20 : 18;

  return (
    <div ref={containerRef} className="relative">
      <Tooltip title="Notifications" enterDelay={300}>
        <button
          ref={bellRef}
          onClick={() => setOpen((v) => !v)}
          aria-label="Notifications"
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={`${panelId}-unread`}
          className={`relative rounded-lg text-on-surface-muted hover:bg-surface-hover hover:text-on-surface transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
            compact ? "p-2" : "p-1.5"
          }`}
        >
          <Bell size={iconSize} strokeWidth={1.8} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center bg-accent-selection text-accent-foreground dark:bg-accent-solid text-[9px] font-bold rounded-full h-[15px] min-w-[15px] px-1 leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </Tooltip>
      <span id={`${panelId}-unread`} className="sr-only">{unreadCount} unread {unreadCount === 1 ? 'notification' : 'notifications'}</span>

      {mounted && (
        <div
          id={panelId}
          inert={exiting}
          aria-hidden={exiting || undefined}
          className={`fixed top-14 right-2 md:absolute md:top-auto md:right-auto md:bottom-full md:left-0 md:mb-2 z-[60] w-[min(360px,calc(100vw-1rem))] rounded-xl bg-surface border border-outline shadow-xl overflow-hidden ${menuAnim(exiting)}`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-outline-subtle">
            <span className="text-sm font-semibold text-on-surface">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={() => { void Promise.resolve(markAllRead()).catch(err => setActionError(getErrorMessage(err, 'Failed to mark notifications read'))); bellRef.current?.focus(); }}
                className="inline-flex items-center gap-1 text-xs font-medium text-accent-emphasis hover:text-accent-emphasis dark:text-accent-emphasis cursor-pointer"
              >
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(70vh,420px)] overflow-y-auto styled-scrollbar">
            <ErrorNotification error={actionError || error} onClose={actionError ? () => { setActionError(''); bellRef.current?.focus(); } : undefined} />
            {loading ? <Spinner label="Loading notifications" /> : error && notifications.length === 0 ? null : notifications.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="w-10 h-10 bg-surface-alt rounded-xl flex items-center justify-center mx-auto mb-3">
                  <Bell size={18} className="text-on-surface-muted" />
                </div>
                <p className="text-sm text-on-surface-secondary">You&apos;re all caught up.</p>
              </div>
            ) : (
              <ul className="divide-y divide-outline-subtle">
                {notifications.map((n) => {
                  const Icon = iconFor(n);
                  const opensSomething = notificationHref(n, "portal", lawFirmId) !== null;
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => handleRowClick(n)}
                        className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-hover transition-colors ${opensSomething ? "cursor-pointer" : "cursor-default"} ${
                          n.read ? "" : "bg-accent-soft dark:bg-accent-soft"
                        }`}
                      >
                        <div className="p-1.5 rounded-lg bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0 mt-0.5">
                          <Icon size={15} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-on-surface leading-snug">{n.title}</p>
                          {n.body && (
                            <p className="text-xs text-on-surface-secondary mt-0.5 line-clamp-2">{n.body}</p>
                          )}
                          <p className="text-[11px] text-on-surface-muted mt-1">{relativeTime(n.createdAt)}</p>
                          {!n.read && <span className="sr-only">Unread</span>}
                        </div>
                        {!n.read && (
                          <span className="mt-1.5 h-2 w-2 rounded-full bg-accent-selection dark:bg-accent-solid flex-shrink-0" />
                        )}
                      </button>
                    </li>
                  );
                })}
                {hasMore && (
                  <li>
                    <button
                      onClick={() => { void Promise.resolve(loadMore()).catch(err => setActionError(getErrorMessage(err, 'Failed to load older notifications'))); }}
                      disabled={loadingMore}
                      className="w-full px-4 py-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-accent-emphasis hover:bg-surface-hover dark:text-accent-emphasis transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingMore && <Spinner size={13} />}
                      {loadingMore ? "Loading…" : "Load older notifications"}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
