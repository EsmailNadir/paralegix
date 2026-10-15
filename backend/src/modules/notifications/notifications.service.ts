const notificationsRepo = require('./notifications.repository');
const settingsService = require('../settings/settings.service');
const { assertLawFirmMembership } = require('../../shared/utils/membership');

export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Drop recipients who have muted this notification category in their per-user
// in-app preferences (`notifications.inApp.<category>`). One batched settings
// query for the whole recipient set. A null/absent category means "not gated"
// (always notify): used by callers that don't map to a toggle.
async function filterByPreference(userIds: string[], category: any) {
  const recipients = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!category || !recipients.length) return recipients;
  const prefs = await settingsService.getNotificationPrefsForUsers(recipients);
  return recipients.filter((userId) => {
    const inApp = prefs.get(userId);
    // Default to enabled when the user has no stored row / key.
    return !inApp || inApp[category] !== false;
  });
}

function formatNotification(data: any) {
  return {
    id: data.id,
    type: data.type,
    title: data.title,
    body: data.body,
    read: data.read || false,
    entityType: data.entityType || null,
    entityId: data.entityId || null,
    matterId: data.matterId || null,
    lawFirmId: data.lawFirmId,
    actionUrl: data.actionUrl || null,
    createdAt: data.createdAt || null,
    createdBy: data.createdBy || null,
  };
}

/** Query-string flags arrive as strings; accept the boolean too. */
function isTrue(value: any) {
  return value === true || value === 'true';
}

/** Normalize the `types` filter (repeated param, CSV, or absent) to an array or null. */
function toTypeList(types: any) {
  const list = (Array.isArray(types) ? types : String(types || '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  return list.length ? list : null;
}

export async function listNotifications({ lawFirmId, userId, unreadOnly, types, limit, before, beforeId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const pageSize = limit || 50;
  const filters = { unreadOnly: isTrue(unreadOnly), types: toTypeList(types) };
  const [raw, total] = await Promise.all([
    notificationsRepo.findForUser(lawFirmId, userId, {
      ...filters,
      limit: pageSize,
      before: before || null,
      beforeId: beforeId || null,
    }),
    notificationsRepo.countForUser(lawFirmId, userId, filters),
  ]);
  const last = raw[raw.length - 1];
  const hasMore = raw.length === pageSize;
  return {
    notifications: raw.map(formatNotification),
    // Rows matching the filters, not the size of this page.
    total,
    // Composite cursor for the next page (the sort is created_at desc, id desc),
    // or null when this page is short of `limit` (no more rows).
    //
    // `cursorAt`, NOT `createdAt`. The display value is a JS `Date` rendered to
    // ISO, so it carries milliseconds, while the column holds microseconds;
    // paging on it skipped every row that shared a millisecond with the last row
    // of a page. See CURSOR_AT in the repository.
    nextBefore: hasMore ? last.cursorAt : null,
    nextBeforeId: hasMore ? last.id : null,
  };
}

export async function getUnreadCount({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const count = await notificationsRepo.countUnread(lawFirmId, userId);
  return { unreadCount: count };
}

export async function getFeed({ lawFirmId, userId, unreadOnly, types, limit }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const pageSize = limit || 50;
  const filters = { unreadOnly: isTrue(unreadOnly), types: toTypeList(types) };
  const [raw, total, unreadCount] = await Promise.all([
    notificationsRepo.findForUser(lawFirmId, userId, { ...filters, limit: pageSize }),
    notificationsRepo.countForUser(lawFirmId, userId, filters),
    notificationsRepo.countUnread(lawFirmId, userId),
  ]);
  return {
    notifications: raw.map(formatNotification),
    total,
    unreadCount,
  };
}

export async function markRead({ lawFirmId, userId, notificationId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await notificationsRepo.markRead(lawFirmId, userId, notificationId);
  return { message: 'Notification marked as read' };
}

export async function markUnread({ lawFirmId, userId, notificationId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await notificationsRepo.markUnread(lawFirmId, userId, notificationId);
  return { message: 'Notification marked as unread' };
}

export async function remove({ lawFirmId, userId, notificationId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await notificationsRepo.remove(lawFirmId, userId, notificationId);
  return { message: 'Notification deleted' };
}

export async function markAllRead({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const count = await notificationsRepo.markAllRead(lawFirmId, userId);
  return { message: 'All notifications marked as read', updated: count };
}

/**
 * Create the same notification for many recipients in one batched insert.
 * Used by the assignment/event fan-outs where a single event notifies every
 * recipient with an identical payload. `category` (optional) filters out
 * recipients who have muted this notification category.
 *
 * `dedupeKey` (optional) overrides what counts as "the same notification" for
 * idempotency. `eventId` identifies one durable event and deduplicates beyond
 * the content window. Leave `dedupeKey` unset unless the caller genuinely wants distinct
 * notifications to collapse: by default two notifications only merge when the
 * reader would see identical text, which is what an outbox retry produces.
 */
export async function createNotifications(lawFirmId: string, userIds: string[], {
  category, type, title, body, entityType, entityId, matterId, actionUrl, createdBy, dedupeKey, eventId,
}: any) {
  const recipients = await filterByPreference(userIds, category);
  if (!recipients.length) return [];
  return notificationsRepo.createMany(lawFirmId, recipients, {
    type,
    title,
    body,
    entityType: entityType || null,
    entityId: entityId || null,
    matterId: matterId || null,
    actionUrl: actionUrl || null,
    createdBy: createdBy || null,
    dedupeKey: dedupeKey || null,
    eventId: eventId || null,
  });
}
