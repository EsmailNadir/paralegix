"use client";

import { Bell } from "lucide-react";
import { useNotifications, useNotificationActions } from "@/hooks/notificationHooks/useNotifications";
import { useNavigation } from "@/contexts/NavigationContext";
import { menuAnim } from "@/components/ui/transitionClasses";
import type { Notification } from "@/services/notifications.service";
import NotificationList from "./NotificationList";
import { notificationHref } from "./notificationHref";

/** The dropdown is a quick glance, not the full feed - cap it and send the rest to the notifications page. */
const DROPDOWN_LIMIT = 5;

interface NotificationDropdownProps {
  lawFirmId: string;
  onClose: () => void;
  style?: React.CSSProperties;
  exiting?: boolean;
  direction?: "up" | "down";
  ref?: React.Ref<HTMLDivElement>;
}

function NotificationDropdown({ lawFirmId, onClose, style, exiting = false, direction = "up", ref }: NotificationDropdownProps) {
    const { notifications: allNotifications, loading } = useNotifications(lawFirmId);
    const notifications = allNotifications.slice(0, DROPDOWN_LIMIT);
    const { markRead, markUnread, markAllRead, remove } = useNotificationActions(lawFirmId);
    const { navigate } = useNavigation();

    // markRead applies its optimistic cache update synchronously and rolls it
    // back itself on failure, so the request is started but not awaited. An
    // await here delayed every click on an unread row by a full round trip
    // before the route changed.
    const handleOpen = (notification: Notification) => {
      if (!notification.read) {
        void markRead(notification.id).catch(() => { /* rolled back in markRead */ });
      }
      const href = notificationHref(notification, "firm", lawFirmId);
      if (href) navigate(href);
      onClose();
    };

    const handleToggleRead = (n: Notification) => {
      if (n.read) markUnread(n.id);
      else markRead(n.id);
    };

    const handleViewAll = () => {
      navigate(`/lawfirm/${lawFirmId}/notifications`);
      onClose();
    };

    // Checked against the full fetched set, not just the visible slice, so "Mark
    // all read" still appears when the unread items are past the dropdown's cap.
    const hasUnread = allNotifications.some((n) => !n.read);

    return (
      <div ref={ref} style={style}>
      <div
        className={`w-full max-h-[70vh] rounded-xl bg-surface border border-outline shadow-xl flex flex-col overflow-hidden ${direction === "up" ? "origin-bottom" : "origin-top"} ${menuAnim(exiting)}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline-subtle shrink-0">
          <h3 className="text-sm font-semibold text-on-surface">Notifications</h3>
          {hasUnread && (
            <button
              onClick={() => markAllRead()}
              className="text-xs text-accent-emphasis hover:underline cursor-pointer"
            >
              Mark all read
            </button>
          )}
        </div>

        {/* List */}
        <div className="overflow-y-auto overflow-x-hidden styled-scrollbar flex-1">
          {loading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-3.5 bg-surface-alt rounded w-3/4 mb-1.5" />
                  <div className="h-2.5 bg-surface-alt rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-8 text-center">
              <Bell size={28} className="text-on-surface-muted mx-auto mb-2" />
              <p className="text-sm text-on-surface-secondary">No notifications</p>
            </div>
          ) : (
            <NotificationList
              notifications={notifications}
              onOpen={handleOpen}
              onToggleRead={handleToggleRead}
              onDelete={(n) => remove(n.id)}
              compact
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-outline-subtle shrink-0">
          <button
            onClick={handleViewAll}
            className="w-full px-4 py-2.5 text-xs font-medium text-accent-emphasis hover:bg-surface-hover transition-colors cursor-pointer"
          >
            View all notifications
          </button>
        </div>
      </div>
      </div>
    );
}

export default NotificationDropdown;
