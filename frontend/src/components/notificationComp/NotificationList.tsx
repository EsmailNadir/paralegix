"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Notification } from "@/services/notifications.service";
import NotificationIcon from "./NotificationIcon";
import NotificationRow from "./NotificationRow";
import { formatTimeAgo, groupNotifications } from "./notificationUtils";

interface NotificationListProps {
  notifications: Notification[];
  onOpen: (n: Notification) => void;
  onToggleRead: (n: Notification) => void;
  onDelete: (n: Notification) => void;
  compact?: boolean;
}

/**
 * Renders the notification feed with same-kind runs collapsed into expandable
 * groups (see groupNotifications). Single-item groups render as a plain row;
 * multi-item groups show a summary ("N notifications") that expands to the
 * individual rows. Shared by the dropdown and the full notifications page.
 */
export default function NotificationList({ notifications, onOpen, onToggleRead, onDelete, compact }: NotificationListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupNotifications(notifications);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="divide-y divide-outline-subtle">
      {groups.map((group) => {
        if (group.items.length === 1) {
          return (
            <NotificationRow
              key={group.items[0].id}
              notification={group.items[0]}
              onOpen={onOpen}
              onToggleRead={onToggleRead}
              onDelete={onDelete}
              compact={compact}
            />
          );
        }

        const latest = group.items[0];
        const unreadCount = group.items.filter((n) => !n.read).length;
        const isOpen = expanded.has(group.key);

        return (
          <div key={group.key}>
            <button
              type="button"
              onClick={() => toggle(group.key)}
              className={`group w-full flex items-start gap-2.5 ${compact ? "px-4 py-3" : "px-4 py-3.5"} text-left hover:bg-surface-hover transition-colors cursor-pointer ${unreadCount ? "bg-accent-soft dark:bg-accent-row-selected" : ""}`}
            >
              <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${unreadCount ? "bg-accent-selection" : "bg-transparent"}`} />
              <NotificationIcon
                notification={latest}
                className={`mt-0.5 shrink-0 ${unreadCount ? "text-accent-emphasis" : "text-on-surface-muted"}`}
              />
              <div className="flex-1 min-w-0">
                <span className={`block text-xs font-medium truncate ${unreadCount ? "text-on-surface" : "text-on-surface-secondary"}`}>
                  {group.items.length} notifications
                </span>
                <p className="text-xs text-on-surface-muted mt-0.5 truncate">{latest.title}</p>
                <span className="text-[10px] text-on-surface-muted mt-1 block">{formatTimeAgo(latest.createdAt)}</span>
              </div>
              <ChevronRight
                size={15}
                className="mt-0.5 shrink-0 text-on-surface-muted transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
                style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
              />
            </button>

            <div
              className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
            >
              <div className="overflow-hidden">
                <div className="bg-surface-alt/60 ml-4 border-l-2 border-accent-border-soft dark:border-accent-border-soft/25">
                  {group.items.map((n) => (
                    <NotificationRow
                      key={n.id}
                      notification={n}
                      onOpen={onOpen}
                      onToggleRead={onToggleRead}
                      onDelete={onDelete}
                      compact
                      nested
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
