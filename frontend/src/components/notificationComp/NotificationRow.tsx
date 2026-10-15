"use client";

import { Check, CornerDownRight, Trash2, Undo2 } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ActionIconButton from "@/components/ui/ActionIconButton";
import type { Notification } from "@/services/notifications.service";
import NotificationIcon from "./NotificationIcon";
import { notificationHref } from "./notificationHref";
import { formatTimeAgo } from "./notificationUtils";

interface NotificationRowProps {
  notification: Notification;
  onOpen: (n: Notification) => void;
  onToggleRead: (n: Notification) => void;
  onDelete: (n: Notification) => void;
  /** Slightly tighter padding inside the dropdown vs. the full page. */
  compact?: boolean;
  /** Rendered inside an expanded group: extra indent + a connector glyph instead of the repeated type icon, so it reads as a child of the group header rather than a peer row. */
  nested?: boolean;
}

/**
 * A single notification row with hover actions (toggle read/unread, delete).
 * Shared by the dropdown and the notifications page so their behavior matches.
 */
export default function NotificationRow({ notification: n, onOpen, onToggleRead, onDelete, compact, nested }: NotificationRowProps) {
  // A row with nowhere to go still marks itself read on click, but it should
  // not look like a link.
  const opensSomething = notificationHref(n, "firm", n.lawFirmId) !== null;
  return (
    <div
      className={`group relative flex items-start gap-2.5 ${compact ? "px-4 py-3" : "px-4 py-3.5"} ${nested ? "pl-6" : ""} hover:bg-surface-hover transition-colors ${!n.read ? "bg-accent-soft dark:bg-accent-row-selected" : ""}`}
    >
      <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${!n.read ? "bg-accent-selection" : "bg-transparent"}`} />

      <button
        type="button"
        onClick={() => onOpen(n)}
        className={`flex flex-1 min-w-0 items-start gap-2 text-left ${opensSomething ? "cursor-pointer" : "cursor-default"}`}
      >
        {nested ? (
          <CornerDownRight size={12} className="mt-1 shrink-0 text-on-surface-muted/60" />
        ) : (
          <NotificationIcon
            notification={n}
            className={`mt-0.5 shrink-0 ${!n.read ? "text-accent-emphasis" : "text-on-surface-muted"}`}
          />
        )}
        <div className="flex-1 min-w-0">
          <span className={`block text-xs font-medium truncate ${!n.read ? "text-on-surface" : "text-on-surface-secondary"}`}>
            {n.title}
          </span>
          <p className="text-xs text-on-surface-muted mt-0.5 line-clamp-2">{n.body}</p>
          <span className="text-[10px] text-on-surface-muted mt-1 block">{formatTimeAgo(n.createdAt)}</span>
        </div>
      </button>

      {/* Hover actions */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip title={n.read ? "Mark as unread" : "Mark as read"} enterDelay={300}>
          <button
            type="button"
            onClick={() => onToggleRead(n)}
            aria-label={n.read ? "Mark as unread" : "Mark as read"}
            className="p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-alt transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            {n.read ? <Undo2 size={13} /> : <Check size={13} />}
          </button>
        </Tooltip>
        <ActionIconButton label="Delete notification" tooltip="Delete" onClick={() => onDelete(n)} tone="danger">
          <Trash2 size={13} />
        </ActionIconButton>
      </div>
    </div>
  );
}
