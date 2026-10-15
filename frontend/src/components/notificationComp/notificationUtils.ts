import type { Notification } from "@/services/notifications.service";

export { formatTimeAgo } from "@/lib/utils/dateUtils";

export interface NotificationGroup {
  key: string;
  items: Notification[];
}

/**
 * The viewer's local calendar day. `toISOString()` would give the UTC day, so an
 * evening notification for anyone behind UTC would group under tomorrow and
 * split a run that the reader sees as one day.
 */
function dayKey(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Collapse runs of same-kind notifications into groups for display. The feed is
 * sorted newest-first, so notifications of the same (type, entityType, day)
 * arrive consecutively; we group those runs. A group's `items` preserves order
 * (newest first). Single-item groups render as a normal row; multi-item groups
 * render a collapsed "N notifications" summary the user can expand.
 */
export function groupNotifications(list: Notification[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  for (const n of list) {
    const key = `${n.type}|${n.entityType ?? ""}|${dayKey(n.createdAt)}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(n);
    else groups.push({ key, items: [n] });
  }
  return groups;
}
