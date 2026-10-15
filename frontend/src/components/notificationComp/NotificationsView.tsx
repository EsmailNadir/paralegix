"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Tooltip from "@/components/ui/Tooltip";
import { Bell, Settings } from "lucide-react";
import PageHeader from "@/components/ui/PageHeader";
import ErrorNotification from "@/components/ErrorNotification";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { useNotificationActions } from "@/hooks/notificationHooks/useNotifications";
import { useNotificationsRealtime } from "@/hooks/notificationHooks/useNotificationsRealtime";
import notificationsService, { type Notification } from "@/services/notifications.service";
import NotificationList from "./NotificationList";
import { notificationHref } from "./notificationHref";
import type { FirmFeatures } from "@/types/preferences";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import Button from "@/components/ui/Button";

const PAGE_SIZE = 30;

type ReadFilter = "all" | "unread";

// Type filter chips. Each chip maps to every notification `type` that belongs to
// it, and the set is sent to the server so filtering spans the whole feed rather
// than only the rows already paged in. Keep this covering every type the backend
// emits: a type in no chip is reachable only under "All".
const TYPE_FILTERS: { label: string; types: string[]; feature?: keyof FirmFeatures }[] = [
  { label: "All", types: [] },
  { label: "Mentions", types: ["mention"] },
  { label: "Messages", types: ["message"] },
  { label: "Tasks", types: ["task_assigned"] },
  { label: "Matters", types: ["matter_added"] },
  { label: "Documents", types: ["document_requested", "document_uploaded", "file_shared", "intake_submitted"] },
  { label: "Signatures", types: ["signing_requested", "signing_reminder", "signing_completed", "signing_declined"] },
  {
    label: "Invoices",
    types: [
      "invoice_paid",
      "invoice_issued",
      "invoice_overdue",
      "invoice_credit_note_added",
      "invoice_payment_reversed",
      "invoice_payment_recredited",
    ],
  },
  // Hidden for a firm without trust accounting: these types can never reach its
  // feed, so the chip would filter to a permanently empty list.
  {
    label: "Trust",
    types: ["trust_deposit_received", "trust_deposit_failed", "trust_low_balance", "trust_reversal_failed"],
    feature: "trustAccounting",
  },
  { label: "Account", types: ["subscription_payment_failed", "subscription_trial_ending", "member_role_changed"] },
];

export default function NotificationsView({ lawFirmId }: { lawFirmId: string }) {
  const { navigate } = useNavigation();
  const { features } = useFirmSettings();
  const { markRead, markUnread, markAllRead, remove } = useNotificationActions(lawFirmId);

  // A chip with no `feature` is always shown; one with a feature only while the
  // firm has it.
  const typeFilters = useMemo(
    () => TYPE_FILTERS.filter((t) => !t.feature || features[t.feature]),
    [features],
  );

  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  // Separate from `loading` so only the FIRST read swaps the list for a
  // skeleton. A filter chip re-reads the same feed, and blanking the rows for it
  // makes every chip click flash - the busy line beside the filters carries that
  // wait instead, which is how the rest of the app acknowledges a filter.
  const [initialLoad, setInitialLoad] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<{ before: string; beforeId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [typeFilter, setTypeFilter] = useState<string>("All");
  const readFilterToggle = useSlidingHighlight<HTMLDivElement>(readFilter);

  const activeTypes = TYPE_FILTERS.find((t) => t.label === typeFilter)?.types ?? [];
  // Stable across renders as long as the selection is unchanged, so it can be an
  // effect dependency without refetching on every render.
  const typesKey = activeTypes.join(",");

  // (Re)load the first page whenever a filter changes. Both filters are applied
  // server-side, so a chip narrows the whole feed rather than just the rows
  // already loaded, and paging keeps working while one is active.
  const reload = useCallback(async () => {
    const res = await notificationsService.list(lawFirmId, {
      limit: PAGE_SIZE,
      unreadOnly: readFilter === "unread",
      types: typesKey ? typesKey.split(",") : undefined,
    });
    setItems(res.notifications);
    setCursor(res.nextBefore ? { before: res.nextBefore, beforeId: res.nextBeforeId ?? null } : null);
  }, [lawFirmId, readFilter, typesKey]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets list loading state when a filter changes before refetching
    setLoading(true);
    setError(null);
    reload()
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load notifications"); })
      .finally(() => { if (!cancelled) { setLoading(false); setInitialLoad(false); } });
    return () => { cancelled = true; };
  }, [reload]);

  // Keep the page live. The bell badge already refreshes on push; without this
  // the list it links to would sit stale for as long as it stays open. Only the
  // first page is re-read - older pages are immutable relative to it - and the
  // merge is by id so anything already paged in survives.
  const handleRealtimeChange = useCallback(() => {
    notificationsService
      .list(lawFirmId, {
        limit: PAGE_SIZE,
        unreadOnly: readFilter === "unread",
        types: typesKey ? typesKey.split(",") : undefined,
      })
      .then((res) => {
        setItems((prev) => {
          const fresh = res.notifications;
          const freshIds = new Set(fresh.map((n) => n.id));
          return [...fresh, ...prev.filter((n) => !freshIds.has(n.id))];
        });
      })
      .catch(() => { /* the next change or a manual reload will catch up */ });
  }, [lawFirmId, readFilter, typesKey]);

  useNotificationsRealtime(lawFirmId, { onChange: handleRealtimeChange });

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await notificationsService.list(lawFirmId, {
        limit: PAGE_SIZE,
        unreadOnly: readFilter === "unread",
        types: typesKey ? typesKey.split(",") : undefined,
        before: cursor.before,
        beforeId: cursor.beforeId ?? undefined,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...res.notifications.filter((n) => !seen.has(n.id))];
      });
      setCursor(res.nextBefore ? { before: res.nextBefore, beforeId: res.nextBeforeId ?? null } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [lawFirmId, cursor, loadingMore, readFilter, typesKey]);

  // The row is marked read in local state first, so the request is started but
  // not awaited. An await here delayed every click on an unread row by a full
  // round trip before the route changed.
  const handleOpen = (n: Notification) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      void markRead(n.id).catch(() => { /* the next reload restores the server state */ });
    }
    const href = notificationHref(n, "firm", lawFirmId);
    if (href) navigate(href);
  };

  const handleToggleRead = (n: Notification) => {
    const nextRead = !n.read;
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: nextRead } : x)));
    if (nextRead) markRead(n.id);
    else markUnread(n.id);
  };

  const handleDelete = (n: Notification) => {
    setItems((prev) => prev.filter((x) => x.id !== n.id));
    remove(n.id);
  };

  const handleMarkAllRead = () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    markAllRead();
  };

  const hasUnread = items.some((n) => !n.read);

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[900px] mx-auto space-y-5 min-w-0">
        <PageHeader
          title="Notifications"
          description="Everything that's happened across your firm."
          actions={
            <div className="flex items-center gap-2">
              {hasUnread && (
                <Button
                  type="secondary"
                  size="compact"
                  onClick={handleMarkAllRead}
                >
                  Mark all read
                </Button>
              )}
              <Tooltip title="Notification settings" enterDelay={300}>
                <button
                  onClick={() => navigate(`/lawfirm/${lawFirmId}/settings/notifications`)}
                  aria-label="Notification settings"
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-surface border border-outline-subtle text-on-surface text-xs font-medium rounded-xl hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Settings size={14} />
                </button>
              </Tooltip>
            </div>
          }
        />

        <ErrorNotification error={error} onClose={() => setError(null)} />

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            ref={readFilterToggle.containerRef}
            className="relative flex rounded-lg border border-outline-subtle bg-surface overflow-hidden"
          >
            {readFilterToggle.rect && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-accent-solid transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  width: readFilterToggle.rect.width,
                  transform: `translateX(${readFilterToggle.rect.left}px)`,
                }}
              />
            )}
            {(["all", "unread"] as ReadFilter[]).map((f) => (
              <button
                key={f}
                ref={readFilterToggle.registerItem(f)}
                onClick={() => setReadFilter(f)}
                className={`relative z-10 px-3 py-1.5 text-xs font-medium capitalize cursor-pointer transition-colors ${readFilter === f ? "text-white" : "text-on-surface-secondary hover:bg-surface-hover"}`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {typeFilters.map((t) => (
              <button
                key={t.label}
                onClick={() => setTypeFilter(t.label)}
                className={`px-2.5 py-1 text-xs rounded-full border cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${typeFilter === t.label ? "border-accent-border-soft bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis" : "border-outline-subtle bg-surface text-on-surface-secondary hover:bg-surface-hover"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <ListBusyIndicator busy={loading && !initialLoad} />
        </div>

        {/* List */}
        <div className="rounded-xl border border-outline bg-surface overflow-hidden">
          {initialLoad ? (
            <ListSkeleton rows={5} bordered={false} label="Loading notifications" />
          ) : items.length === 0 ? (
            <div className="p-12 text-center">
              <Bell size={32} className="text-on-surface-muted mx-auto mb-3" />
              <p className="text-sm text-on-surface-secondary">No notifications</p>
            </div>
          ) : (
            <>
              <NotificationList
                notifications={items}
                onOpen={handleOpen}
                onToggleRead={handleToggleRead}
                onDelete={handleDelete}
              />
              {cursor && (
                <div className="p-3 border-t border-outline-subtle">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full px-4 py-2 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
