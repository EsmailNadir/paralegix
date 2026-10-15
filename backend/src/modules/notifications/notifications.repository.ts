const crypto = require('crypto');
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { messages, notifications } from '../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsertManyOnConflictDoNothing,
  scopedUpdate,
} from '../../shared/database/scopedWrite';
const { isUuid } = require('../../shared/utils/isUuid');

/**
 * Notifications (flattened from the Firestore members/{userId}/notifications
 * subcollection into the top-level `notifications` table, keyed by user_id).
 */

function toEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    lawFirmId: r.lawFirmId,
    userId: r.userId,
    type: r.type,
    title: r.title,
    body: r.body,
    read: r.read,
    entityType: r.entityType,
    entityId: r.entityId,
    matterId: r.matterId,
    actionUrl: r.actionUrl,
    createdBy: r.createdBy,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    // Only the paging read selects this; every other caller leaves it null.
    cursorAt: r.cursorAt || null,
  };
}

/**
 * The paging cursor, rendered by Postgres at the column's full precision.
 *
 * `created_at` is `timestamptz`, which stores MICROseconds, but node-pg parses
 * it into a JS `Date`, and a `Date` holds MILLIseconds. Handing the parsed value
 * back as the cursor therefore rounds it DOWN, and the comparison below is
 * strictly less-than, so every row that shares that millisecond with more
 * microseconds sorts ABOVE the cursor and is skipped by that page and by every
 * page after it. The row is not delayed, it is unreachable.
 *
 * A batched fan-out was never exposed: one statement gives every row an
 * identical timestamp, and the composite `(created_at, id)` cursor already
 * handles an exact tie. The gap was two SEPARATE inserts landing in the same
 * millisecond, which is ordinary under load.
 *
 * Rendering the cursor in SQL keeps all six digits, and the string casts back to
 * `timestamptz` exactly. The format stays ISO-8601 so an existing client can
 * still echo it into `before`.
 */
const CURSOR_AT = sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The identity of a notification for dedupe purposes, hashed into `dedupe_hash`.
 *
 * By default this is the whole VISIBLE payload (type + title + body + entity), so
 * "the same notification" means "the reader would see the same thing twice". An
 * at-least-once outbox retry re-sends a byte-identical payload and collapses,
 * while two genuinely different notifications about one entity — two documents
 * signed on the same matter, a partial payment then the closing payment on the
 * same invoice — both land.
 *
 * A caller that wants coarser collapsing passes an explicit `dedupeKey` and owns
 * the meaning: message notifications key on the conversation so a burst of
 * messages stays one bell item regardless of the differing previews.
 */
function dedupeSignature(data: any) {
  // NUL separator: it cannot occur inside any part, so two different field
  // splits can never join into the same string.
  const raw = data.eventId
    ? `event:${data.eventId}`
    : data.dedupeKey
    ? `key:${data.dedupeKey}`
    : [data.type, data.title, data.body, data.entityType || '', data.entityId || ''].join('\u0000');
  return crypto.createHash('md5').update(raw).digest('hex');
}

// Idempotency window for the duplicate-suppression guard below. The event
// outbox worker (when enabled) re-dispatches a row at-least-once, which would
// otherwise double-insert the same notification on retry. A retry lands well
// within this window, so a recent row with the same dedupe signature is treated
// as already-created and not re-inserted.
//
// Sized for OUTBOX-RETRY IDEMPOTENCY ONLY: long enough to outlast the outbox
// backoff for a single retry, short enough that a legitimately new
// re-notification minutes later (e.g. re-assignment with an identical signature)
// is NOT swallowed.
const DEDUPE_WINDOW_MS = 60 * 1000; // 60s: outbox-retry idempotency only

/**
 * For a fixed notification payload, return the most recent matching row per
 * recipient within the dedupe window, in ONE query, so an at-least-once retry
 * can't create a visible duplicate. Returns a Map keyed by user_id.
 *
 * Matches on `dedupe_hash` — the SAME key the unique index enforces. When the
 * two disagreed (the index keyed on the entity, this pre-check additionally on
 * the title), a payload that passed here could still collide on the index and be
 * swallowed by `on conflict do nothing` with no error.
 *
 * A fan-out to N users costs one query, not N. The `created_at >= now() -
 * window` filter catches retries regardless of which unix-minute bucket they
 * land in, so it also subsumes minute-boundary-straddle special-casing.
 */
async function findRecentDuplicatesForUsers(lawFirmId: string, userIds: string[], dedupeHash: any) {
  if (!userIds.length) return new Map();
  const rows = await tenantQuery(notifications, lawFirmId, ({ executor, scope }) => executor
    .selectDistinctOn([notifications.userId]).from(notifications).where(and(
      scope,
      inArray(notifications.userId, userIds),
      eq(notifications.dedupeHash, dedupeHash),
      sql`${notifications.createdAt} >= now() - (${DEDUPE_WINDOW_MS}::bigint * interval '1 millisecond')`,
    )).orderBy(notifications.userId, desc(notifications.createdAt)));
  return new Map(rows.map((r: any) => [r.userId, toEntity(r)]));
}

/**
 * Recover the rows the unique index collapsed against, per recipient, in ONE
 * query. Authoritative last lookup after an `on conflict do nothing` insert
 * returns nothing for some recipients. Matches the index key exactly — hash AND
 * bucket — so it can only return the row the insert actually lost the race to,
 * never an older row that merely shares the payload. Returns a Map keyed by
 * user_id.
 */
async function findByDedupeKeyForUsers(lawFirmId: string, userIds: string[], dedupeHash: any, dedupeBucket: any) {
  if (!userIds.length) return new Map();
  const rows = await tenantQuery(notifications, lawFirmId, ({ executor, scope }) => executor
    .selectDistinctOn([notifications.userId]).from(notifications).where(and(
      scope,
      inArray(notifications.userId, userIds),
      eq(notifications.dedupeHash, dedupeHash),
      eq(notifications.dedupeBucket, dedupeBucket),
    )).orderBy(notifications.userId, desc(notifications.createdAt)));
  return new Map(rows.map((r: any) => [r.userId, toEntity(r)]));
}

/**
 * Create the same notification for many recipients. Idempotency is preserved per
 * recipient (an outbox retry can't create visible duplicates) using THREE queries
 * total regardless of recipient count:
 *
 *   1. one batched sliding-window pre-check: skip recipients with a recent
 *      identical row (and return that row so callers see the persisted state);
 *   2. one multi-row `insert ... on conflict do nothing returning *` for the
 *      survivors. The unique index `notifications_dedupe_uq` makes concurrent
 *      same-minute retries collapse atomically;
 *   3. one recovery `select` for any survivor whose row the unique index
 *      suppressed (lost an insert race), so the result reflects what persisted.
 *
 * All three steps key on the same `dedupe_hash` (see `dedupeSignature`), so a
 * payload that clears the pre-check can never be silently swallowed by the index.
 *
 * @returns {Promise<object[]>} the created (or pre-existing/recovered) notifications.
 */
export async function createMany(lawFirmId: string, userIds: string[], data: any) {
  const recipients = Array.from(new Set<string>((userIds || []).filter(Boolean)));
  if (!recipients.length) return [];

  const dedupeHash = dedupeSignature(data);

  // 1. Batched sliding-window pre-check.
  // Stable event identities use a fixed bucket: retries remain idempotent
  // beyond the short window used for ordinary rendered-content deduplication.
  const existing = data.eventId
    ? await findByDedupeKeyForUsers(lawFirmId, recipients, dedupeHash, 0)
    : await findRecentDuplicatesForUsers(lawFirmId, recipients, dedupeHash);
  const results = [];
  const survivors = [];
  for (const userId of recipients) {
    const dup = existing.get(userId);
    if (dup) results.push(dup);
    else survivors.push(userId);
  }
  if (!survivors.length) return results;

  // 2. Single multi-row insert for the survivors. One coarse unix-minute bucket
  //    for the whole batch backs the unique index (concurrent retries in the
  //    same minute collapse; a real re-notification a minute+ later is a new
  //    bucket and allowed).
  const dedupeBucket = data.eventId ? 0 : Math.floor(Date.now() / 60000);
  const rows = await scopedInsertManyOnConflictDoNothing(notifications, lawFirmId, survivors.map((userId) => ({
    userId,
    type: data.type,
    title: data.title,
    body: data.body,
    read: data.read || false,
    entityType: data.entityType || null,
    entityId: isUuid(data.entityId) ? data.entityId : null,
    matterId: isUuid(data.matterId) ? data.matterId : null,
    actionUrl: data.actionUrl || null,
    createdBy: data.createdBy || null,
    dedupeBucket,
    dedupeHash,
  })));
  const inserted = new Map(rows.map((r: any) => [r.userId, toEntity(r)]));

  // 3. Recover any survivor the unique index suppressed (lost an insert race) so
  //    the result reflects the persisted notification rather than dropping it.
  const missing = survivors.filter((userId) => !inserted.has(userId));
  const recovered = await findByDedupeKeyForUsers(lawFirmId, missing, dedupeHash, dedupeBucket);

  for (const userId of survivors) {
    const row = inserted.get(userId) || recovered.get(userId);
    if (row) results.push(row);
  }
  return results;
}

export async function create(lawFirmId: string, userId: string, data: any) {
  // Single-recipient create is the batched path with one recipient; createMany
  // always returns the created/pre-existing/recovered row for a given user, so
  // this never returns a phantom null.
  const [row] = await createMany(lawFirmId, [userId], data);
  return row || null;
}

/**
 * Build the shared `where` fragment for a user's feed. Returns the SQL tail and
 * pushes its parameters onto `params`, so the list and count queries can never
 * drift apart on what they filter.
 */
function feedFilter(userId: string, { unreadOnly, types }: any) {
  const filters: SQL[] = [eq(notifications.userId, userId)];
  if (unreadOnly) filters.push(eq(notifications.read, false));
  if (types && types.length) filters.push(inArray(notifications.type, types));
  return filters;
}

/**
 * One page of a user's feed, newest first.
 *
 * The cursor is the composite `(created_at, id)` of the last row on the previous
 * page, matching the sort. A created_at-only cursor silently skipped a row
 * whenever two notifications shared a timestamp across a page boundary — which a
 * batched fan-out makes entirely possible. `beforeId` is optional so an older
 * caller passing only `before` still works (with the original tie behaviour).
 */
export async function findForUser(lawFirmId: string, userId: string, {
  unreadOnly = false, types = null, limit = 50, before = null, beforeId = null,
} = {}) {
  const filters = feedFilter(userId, { unreadOnly, types });
  if (before && isUuid(beforeId)) {
    filters.push(sql`(${notifications.createdAt}, ${notifications.id}) < (${before}::timestamptz, ${beforeId}::uuid)`);
  } else if (before) {
    filters.push(sql`${notifications.createdAt} < ${before}`);
  }
  const rows = await tenantQuery<any[]>(notifications, lawFirmId, ({ executor, scope }) => {
    let query: any = executor
      .select({ ...getTableColumns(notifications), cursorAt: CURSOR_AT })
      .from(notifications).where(and(scope, ...filters))
      .orderBy(desc(notifications.createdAt), desc(notifications.id));
    if (limit) query = query.limit(limit);
    return query;
  });
  return rows.map(toEntity);
}

/** Total rows matching a feed's filters, ignoring pagination. */
export async function countForUser(lawFirmId: string, userId: string, { unreadOnly = false, types = null } = {}) {
  const [row] = await tenantQuery(notifications, lawFirmId, ({ executor, scope }) => executor
    .select({ total: count() }).from(notifications)
    .where(and(scope, ...feedFilter(userId, { unreadOnly, types }))));
  return row?.total || 0;
}

export async function countUnread(lawFirmId: string, userId: string) {
  return countForUser(lawFirmId, userId, { unreadOnly: true });
}

export async function markRead(lawFirmId: string, userId: string, notificationId: any) {
  if (!isUuid(notificationId)) return;
  await scopedUpdate(notifications, lawFirmId, and(
    eq(notifications.userId, userId),
    eq(notifications.id, notificationId),
  )!, { read: true });
}

export async function markUnread(lawFirmId: string, userId: string, notificationId: any) {
  if (!isUuid(notificationId)) return;
  await scopedUpdate(notifications, lawFirmId, and(
    eq(notifications.userId, userId),
    eq(notifications.id, notificationId),
  )!, { read: false });
}

/**
 * Mark read every unread message/mention notification tied to a conversation the
 * user just opened. Message notifications point at the conversation two ways: a
 * plain "new message" carries entity_id = conversationId, while an @mention
 * carries entity_id = the messageId. Both are cleared here by matching the
 * conversation directly and any of its messages, so opening a thread dismisses
 * its bell notifications regardless of which kind fired. Scoped to the user's own
 * rows in the firm. Returns the number of rows updated.
 */
export async function markReadForConversation(lawFirmId: string, userId: string, conversationId: string) {
  if (!isUuid(conversationId)) return 0;
  const rows = await scopedUpdate(notifications, lawFirmId, and(
    eq(notifications.userId, userId),
    eq(notifications.read, false),
    eq(notifications.entityType, 'message'),
    or(
      eq(notifications.entityId, conversationId),
      inArray(notifications.entityId, sql`select ${messages.id} from ${messages} where ${messages.conversationId} = ${conversationId}`),
    ),
  )!, { read: true });
  return rows.length;
}

export async function markAllRead(lawFirmId: string, userId: string) {
  const rows = await scopedUpdate(notifications, lawFirmId, and(
    eq(notifications.userId, userId),
    eq(notifications.read, false),
  )!, { read: true });
  return rows.length;
}

export async function remove(lawFirmId: string, userId: string, notificationId: any) {
  if (!isUuid(notificationId)) return 0;
  const rows = await scopedDelete(notifications, lawFirmId, and(
    eq(notifications.userId, userId),
    eq(notifications.id, notificationId),
  )!);
  return rows.length;
}

/**
 * Delete every notification pointing at one entity, for all recipients in the
 * firm. Called when the entity itself is deleted: without this, the bell keeps
 * offering a link to a matter or task that no longer exists and the click
 * dead-ends. Returns the number of rows removed.
 */
export async function removeForEntity(lawFirmId: string, entityType: any, entityId: any) {
  if (!entityType || !isUuid(entityId)) return 0;
  const rows = await scopedDelete(notifications, lawFirmId, and(
    eq(notifications.entityType, entityType),
    eq(notifications.entityId, entityId),
  )!);
  return rows.length;
}

/**
 * Delete every notification attached to a matter, whichever entity it names.
 * Deleting a matter cascades to its tasks, notes and invoices, so their
 * notifications are dead links too; they all carry `matter_id`.
 */
export async function removeForMatter(lawFirmId: string, matterId: string) {
  if (!isUuid(matterId)) return 0;
  const rows = await scopedDelete(notifications, lawFirmId, or(
    eq(notifications.matterId, matterId),
    and(eq(notifications.entityType, 'matter'), eq(notifications.entityId, matterId)),
  )!);
  return rows.length;
}

/**
 * Retention sweep across every firm. Read notifications are dropped after
 * `readAfterDays`; anything at all is dropped after `maxAgeDays`, so a feed that
 * is never opened can't grow without bound either. Deletes in bounded batches so
 * one pass can't hold a long lock or blow the statement timeout. Returns the
 * number of rows removed.
 */
export async function purgeOld({ readAfterDays = 90, maxAgeDays = 365, batchSize = 5000, maxBatches = 20 } = {}) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await systemQuery('scheduler', (executor) => executor.delete(notifications).where(inArray(
      notifications.id,
      executor.select({ id: notifications.id }).from(notifications).where(or(
        and(
          eq(notifications.read, true),
          lt(notifications.createdAt, sql`now() - (${readAfterDays}::int * interval '1 day')`),
        ),
        lt(notifications.createdAt, sql`now() - (${maxAgeDays}::int * interval '1 day')`),
      )).limit(batchSize),
    )).returning({ id: notifications.id }));
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return deleted;
}
