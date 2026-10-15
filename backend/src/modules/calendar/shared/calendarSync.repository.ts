/**
 * Calendar sync ENGINE bookkeeping repository (Postgres, relational).
 *
 * Replaces the legacy NoSQL-emulation jsonb kv collections:
 *   calendar_mapping_docs      -> calendar_mappings
 *   google_watch_channel_docs  -> calendar_subscriptions (provider 'google')
 *   outlook_subscription_docs  -> calendar_subscriptions (provider 'outlook')
 *
 * Mappings record which Paralegix entity a provider event came from, using
 * entity_type + entity_id (+ scope_id = matterId/clientId for nested entities)
 * instead of a Firestore-style docPath.
 */

const { privilegedParameterizedQuery } = require('../../../shared/database/queryContext');

const calendarSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'calendar sync state is scoped by provider identity, user, or firm', text, params,
);

// ── calendar_mappings ───────────────────────────────────────────────────────

export async function saveMapping({
  provider, externalEventId, calendarId, userId, lawFirmId,
  entityType, entityId, scopeId, itemKey, pushedVersion, pushedModifiedAt,
}: any) {
  await calendarSql(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key, pushed_version, pushed_modified_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (provider, external_event_id) do update set
       calendar_id = excluded.calendar_id,
       user_id     = excluded.user_id,
       law_firm_id = excluded.law_firm_id,
       entity_type = excluded.entity_type,
       entity_id   = excluded.entity_id,
       scope_id    = excluded.scope_id,
       item_key    = excluded.item_key,
       pushed_version = coalesce(excluded.pushed_version, calendar_mappings.pushed_version),
       pushed_modified_at = coalesce(excluded.pushed_modified_at, calendar_mappings.pushed_modified_at),
       updated_at  = now()`,
    [
      provider, externalEventId, calendarId || null, userId || null,
      lawFirmId || null, entityType || null, entityId || null,
      scopeId || null, itemKey || null, pushedVersion || null, pushedModifiedAt || null,
    ]
  );
}

/**
 * The remote event this (user, entity, item) is already mapped to, if any.
 *
 * This is the durable answer to "have we already created this event?", and it
 * exists because the in-memory one is not trustworthy. Both providers decide
 * create-versus-PATCH from a writeback field on the entity row they were handed
 * (`adapter.getGoogleEventId` / `getOutlookEventId`), which was loaded before
 * the sync started. Two saves landing concurrently both read the row before
 * either writeback commits, both see no external id, and both POST — producing
 * two events on the user's real calendar. `calendar_mappings` is written
 * immediately after a successful create, so consulting it closes that window.
 *
 * The primary key `(provider, external_event_id)` cannot serve this: it is
 * unique per REMOTE event, not per local entity. The lookup below matches the
 * unique index added in migration 0139, which is keyed the other way round.
 *
 * Only meaningful inside the calendar sync lock — without it this is just a
 * narrower check-then-act.
 */
export async function findMappingForEntityItem({ provider, userId, entityType, entityId, itemKey }: any) {
  if (!provider || !userId || !entityType || !entityId) return null;
  const { rows } = await calendarSql(
    `select * from calendar_mappings
      where provider = $1 and user_id = $2 and entity_type = $3
        and entity_id = $4 and item_key is not distinct from $5
      limit 1`,
    [provider, userId, entityType, String(entityId), itemKey ?? null]
  );
  return mapRow(rows[0]);
}

/**
 * Every copy one member has of one entity on one provider, by item key.
 *
 * The delete and stale-key paths read this rather than trusting the payload's
 * `calendar_sync` map, which is a snapshot taken before the sync that wrote it
 * and is absent altogether from a task payload.
 */
export async function listMappingsForEntityUser({ provider, userId, entityType, entityId }: any) {
  if (!provider || !userId || !entityType || !entityId) return [];
  const { rows } = await calendarSql(
    `select * from calendar_mappings
      where provider = $1 and user_id = $2 and entity_type = $3 and entity_id = $4`,
    [provider, userId, entityType, String(entityId)]
  );
  return rows.map(mapRow);
}

function mapRow(r: any) {
  if (!r) return null;
  return {
    provider: r.provider,
    externalEventId: r.external_event_id,
    calendarId: r.calendar_id || null,
    userId: r.user_id || null,
    lawFirmId: r.law_firm_id || null,
    entityType: r.entity_type || null,
    entityId: r.entity_id || null,
    scopeId: r.scope_id || null,
    itemKey: r.item_key || null,
    pushedVersion: r.pushed_version || null,
    pushedModifiedAt: r.pushed_modified_at || null,
  };
}

/** Look up a mapping by external event id across providers (provider-agnostic). */
export async function getMappingByExternalId(externalEventId: any) {
  if (!externalEventId) return null;
  const { rows } = await calendarSql(
    `select * from calendar_mappings where external_event_id = $1 limit 1`,
    [externalEventId]
  );
  return mapRow(rows[0]);
}

/**
 * C3: batch the reverse-index lookup for a delta page. One query resolves every
 * provider event id in the set instead of issuing a separate getMappingByExternalId
 * per event. Returns a Map<externalEventId, mappingRow>. The per-event upsert path
 * consults this cache first, preserving the existing task -> externalEvent -> mapping
 * priority order. It only collapses N mapping round-trips into one.
 */
export async function getMappingsByExternalIds(externalEventIds: any) {
  const ids = Array.from(new Set((externalEventIds || []).filter(Boolean)));
  if (ids.length === 0) return new Map();
  const { rows } = await calendarSql(
    `select * from calendar_mappings where external_event_id = any($1::text[])`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) {
    const mapped = mapRow(r);
    if (mapped && !map.has(mapped.externalEventId)) map.set(mapped.externalEventId, mapped);
  }
  return map;
}

export async function deleteMapping(provider: any, externalEventId: any) {
  if (!externalEventId) return;
  await calendarSql(
    `delete from calendar_mappings where provider = $1 and external_event_id = $2`,
    [provider, externalEventId]
  );
}

// ── google watch channels (calendar_subscriptions where provider = 'google') ──
//
// The table is shared with Outlook since migration 0203. These mappers keep
// Google's own key names (`resourceId`, `token`) so the sync engine and webhook
// routes never learn that the storage is shared.

function watchRow(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    channelId: r.id,
    userId: r.user_id || null,
    lawFirmId: r.law_firm_id || null,
    calendarId: r.calendar_id || null,
    resourceId: r.resource || null,
    token: r.secret || null,
    expiration: r.expiration || null,
    lastOutboundPushAt: r.last_outbound_push_at || null,
    createdAt: r.created_at || null,
  };
}

export async function saveWatchChannel({ channelId, userId, lawFirmId, calendarId, resourceId, token, expiration }: any) {
  await calendarSql(
    `insert into calendar_subscriptions (id, provider, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ($1,'google',$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       provider = 'google',
       user_id = excluded.user_id, law_firm_id = excluded.law_firm_id,
       calendar_id = excluded.calendar_id, resource = excluded.resource,
       secret = excluded.secret, expiration = excluded.expiration`,
    [channelId, userId || null, lawFirmId || null, calendarId || null, resourceId || null, token || null, expiration || null]
  );
}

export async function getWatchChannel(channelId: any) {
  if (!channelId) return null;
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'google' and id = $1 limit 1`, [channelId]);
  return watchRow(rows[0]);
}

export async function findWatchChannelForUser(userId: string) {
  if (!userId) return null;
  const { rows } = await calendarSql(
    `select * from calendar_subscriptions where provider = 'google' and user_id = $1 order by created_at desc limit 1`,
    [userId]
  );
  return watchRow(rows[0]);
}

export async function listWatchChannelsForUser(userId: string) {
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'google' and user_id = $1`, [userId]);
  return rows.map(watchRow);
}

export async function listWatchChannelsForLawFirm(lawFirmId: string) {
  if (!lawFirmId) return [];
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'google' and law_firm_id = $1`, [lawFirmId]);
  return rows.map(watchRow);
}

export async function listExpiringWatchChannels(cutoff: any) {
  const { rows } = await calendarSql(
    `select * from calendar_subscriptions where provider = 'google' and expiration < $1`,
    [cutoff]
  );
  return rows.map(watchRow);
}

export async function stampWatchChannelOutboundPush(channelId: any) {
  await calendarSql(
    `update calendar_subscriptions set last_outbound_push_at = now() where provider = 'google' and id = $1`,
    [channelId]
  );
}

export async function deleteWatchChannel(channelId: any) {
  await calendarSql(`delete from calendar_subscriptions where provider = 'google' and id = $1`, [channelId]);
}

// ── outlook subscriptions (calendar_subscriptions where provider = 'outlook') ──
//
// Shares the table with Google since migration 0203; these mappers keep
// Outlook's own key names (`resource`, `clientState`) so Graph-facing code is
// unchanged.

function subRow(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    subscriptionId: r.id,
    userId: r.user_id || null,
    lawFirmId: r.law_firm_id || null,
    calendarId: r.calendar_id || null,
    resource: r.resource || null,
    clientState: r.secret || null,
    expirationDateTime: r.expiration || null,
    lastOutboundPushAt: r.last_outbound_push_at || null,
    createdAt: r.created_at || null,
  };
}

export async function saveSubscription({ subscriptionId, userId, lawFirmId, calendarId, resource, clientState, expiration }: any) {
  await calendarSql(
    `insert into calendar_subscriptions (id, provider, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ($1,'outlook',$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       provider = 'outlook',
       user_id = excluded.user_id, law_firm_id = excluded.law_firm_id,
       calendar_id = excluded.calendar_id, resource = excluded.resource,
       secret = excluded.secret, expiration = excluded.expiration`,
    [subscriptionId, userId || null, lawFirmId || null, calendarId || null, resource || null, clientState || null, expiration || null]
  );
}

export async function getSubscription(subscriptionId: any) {
  if (!subscriptionId) return null;
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'outlook' and id = $1 limit 1`, [subscriptionId]);
  return subRow(rows[0]);
}

export async function findSubscriptionForUser(userId: string) {
  if (!userId) return null;
  const { rows } = await calendarSql(
    `select * from calendar_subscriptions where provider = 'outlook' and user_id = $1 order by created_at desc limit 1`,
    [userId]
  );
  return subRow(rows[0]);
}

export async function listSubscriptionsForUser(userId: string) {
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'outlook' and user_id = $1`, [userId]);
  return rows.map(subRow);
}

export async function listSubscriptionsForLawFirm(lawFirmId: string) {
  if (!lawFirmId) return [];
  const { rows } = await calendarSql(`select * from calendar_subscriptions where provider = 'outlook' and law_firm_id = $1`, [lawFirmId]);
  return rows.map(subRow);
}

export async function listExpiringSubscriptions(cutoff: any) {
  const { rows } = await calendarSql(
    `select * from calendar_subscriptions where provider = 'outlook' and expiration < $1`,
    [cutoff]
  );
  return rows.map(subRow);
}

export async function updateSubscriptionExpiration(subscriptionId: any, expiration: any) {
  await calendarSql(
    `update calendar_subscriptions set expiration = $2 where provider = 'outlook' and id = $1`,
    [subscriptionId, expiration]
  );
}

export async function stampSubscriptionOutboundPush(subscriptionId: any) {
  await calendarSql(
    `update calendar_subscriptions set last_outbound_push_at = now() where provider = 'outlook' and id = $1`,
    [subscriptionId]
  );
}

export async function deleteSubscription(subscriptionId: any) {
  await calendarSql(`delete from calendar_subscriptions where provider = 'outlook' and id = $1`, [subscriptionId]);
}

// ── one person leaving one firm ─────────────────────────────────────────────

/** Both providers' live-import subscriptions a person holds stamped with one firm. */
export async function listSubscriptionsForUserInFirm(userId: string, lawFirmId: string) {
  if (!userId || !lawFirmId) return [];
  const { rows } = await calendarSql(
    'select id, provider from calendar_subscriptions where user_id = $1 and law_firm_id = $2 order by id',
    [userId, lawFirmId],
  );
  return rows.map((row: any) => ({ id: row.id as string, provider: row.provider as 'google' | 'outlook' }));
}

/**
 * Point a person's live import from one firm at another. The provider side is
 * untouched: a watch channel or subscription is the person's own calendar, and
 * only the firm its notifications import into changes. Returns what moved.
 */
export async function restampSubscriptionsForUser(userId: string, fromLawFirmId: string, toLawFirmId: string) {
  if (!userId || !fromLawFirmId || !toLawFirmId) return [];
  const { rows } = await calendarSql(
    'update calendar_subscriptions set law_firm_id = $3 where user_id = $1 and law_firm_id = $2 returning id, provider',
    [userId, fromLawFirmId, toLawFirmId],
  );
  return rows.map((row: any) => ({ id: row.id as string, provider: row.provider as 'google' | 'outlook' }));
}

// ── calendar_sync_failures (durable retry / dead-letter) ────────────────────
// One queue for two kinds of failed calendar work, each a retry-with-backoff
// dead letter (migration 0215 merged `calendar_webhook_failures` and
// `google_watch_channel_stop_failures`).
//
//   webhook       A push notification this backend failed to process. Retrying
//                 means "re-run the user's incremental sync", which is
//                 idempotent, so repeated failures for one (provider, user)
//                 coalesce onto a single row rather than queueing per event.
//
//   stop_channel  A Google watch channel this backend failed to stop, which is
//                 still live at Google and still pushing. The
//                 `calendar_subscriptions` row is deleted after a stop attempt
//                 and holds the only copy of the channel + resource id that
//                 `channels/stop` needs, so an unstopped channel is
//                 unrecoverable unless it is written down here first.
//
// The two differ in exactly three ways, and each is a parameter rather than a
// column: what makes a row unique (`dedupe_key`), the retry budget (the two
// policies below), and whether the row can go stale on its own (`expires_at`,
// set only for a channel, from its own expiry at Google).

interface RetryPolicy {
  kind: 'webhook' | 'stop_channel' | 'outbound';
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

/** 8 attempts from 30s, doubling to a 2h cap. */
export const WEBHOOK_RETRY: RetryPolicy = {
  kind: 'webhook', maxAttempts: 8, baseMs: 30_000, capMs: 2 * 60 * 60 * 1000,
};
const OUTBOUND_RETRY: RetryPolicy = { kind: 'outbound', maxAttempts: 12, baseMs: 30_000, capMs: 2 * 60 * 60 * 1000 };
/** 10 attempts from 5m, doubling to a 6h cap. Longer because a live channel
 *  keeps pushing until Google's own 7-day ttl expires it. */
export const CHANNEL_STOP_RETRY: RetryPolicy = {
  kind: 'stop_channel', maxAttempts: 10, baseMs: 5 * 60 * 1000, capMs: 6 * 60 * 60 * 1000,
};

/** Kept as named exports because the cron sweeps import them for their summaries. */
export const WEBHOOK_RETRY_MAX_ATTEMPTS = WEBHOOK_RETRY.maxAttempts;
export const CHANNEL_STOP_RETRY_MAX_ATTEMPTS = CHANNEL_STOP_RETRY.maxAttempts;

function failureRow(r: any) {
  if (!r) return null;
  const payload = r.payload || {};
  return {
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    leaseToken: r.lease_token,
    provider: r.provider || null,
    userId: r.user_id || null,
    lawFirmId: r.law_firm_id || null,
    lastError: r.last_error || null,
    attempts: r.attempts || 0,
    nextAttemptAt: r.next_attempt_at || null,
    expiresAt: r.expires_at || null,
    // The webhook kind's arguments, flattened back onto the row so the sweep
    // reads them the way it always has.
    changeType: payload.changeType ?? null,
    eventId: payload.eventId ?? null,
    resource: payload.resource ?? null,
    // The stop kind's argument. `channels/stop` cannot be called without it.
    channelId: r.kind === 'stop_channel' ? r.dedupe_key : null,
    resourceId: payload.resourceId ?? null,
    payload,
  };
}

/**
 * Flags on a payload's `entityData` that describe ONE save rather than the
 * entity's state: `locationCleared` says that save cleared a task location
 * Paralegix had set. A later save of the same entity, recorded before this work
 * ran, replaces the payload and does not repeat the flag, so a set flag is
 * carried into the replacement until the work runs.
 */
const OUTBOUND_ONE_SHOT_FLAGS = ['locationCleared'];

export async function recordOutboundWork({ provider, userId, entityType, entityData, action, timeZone }: any) {
  return recordFailure(OUTBOUND_RETRY, {
    dedupeKey: `${entityData.lawFirmId}:${provider}:${entityType}:${entityData.id}:${userId}`,
    provider, userId, lawFirmId: entityData.lawFirmId,
    payload: { entityType, entityData, action, timeZone }, pending: true,
    stickyEntityFlags: OUTBOUND_ONE_SHOT_FLAGS,
  });
}

export async function getOutboundWork(dedupeKey: string) {
  const { rows } = await calendarSql("select *, xmin::text as lease_token from calendar_sync_failures where kind = 'outbound' and dedupe_key = $1", [dedupeKey]);
  return failureRow(rows[0]);
}

export const listDueOutboundWork = (limit = 50) => listDueFailures(OUTBOUND_RETRY, limit);
export const resolveOutboundWork = (key: string, leaseToken: string) => resolveFailure(OUTBOUND_RETRY, key, leaseToken);
export const rescheduleOutboundWork = (key: string, error: any, leaseToken: string) => rescheduleFailure(OUTBOUND_RETRY, key, error, leaseToken);
export const listDeadLetteredOutboundWork = (limit = 100) => listDeadLetteredFailures(OUTBOUND_RETRY, limit);
export const countDeadLetteredOutboundWork = () => countDeadLetteredFailures(OUTBOUND_RETRY);

/**
 * How long work parked behind a lost grant waits before the sweep looks at it
 * again. A reconnect releases it at once (`releaseOutboundWorkForUser`); the
 * recheck only exists so work for a connection that was disconnected instead is
 * eventually resolved, and it is long so parked rows do not crowd the sweep.
 */
const PARKED_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * The work cannot run until the person reconnects: hold it without spending an
 * attempt. Fenced on the lease like a reschedule, so a parked row that a newer
 * write re-queued in the meantime keeps that newer schedule.
 */
export async function parkOutboundWork(dedupeKey: string, error: any, leaseToken: string) {
  if (!dedupeKey) return;
  await calendarSql(
    `update calendar_sync_failures set
       last_error      = $2,
       next_attempt_at = now() + ($3 || ' milliseconds')::interval,
       updated_at      = now()
     where kind = 'outbound' and dedupe_key = $1${leaseToken ? ' and xmin::text = $4' : ''}`,
    [dedupeKey, errorText(error), PARKED_RECHECK_MS, ...(leaseToken ? [leaseToken] : [])],
  );
}

/**
 * A connection for `provider` just started working again: make every outbound
 * row it owes due now with a fresh budget, including rows parked behind the lost
 * grant and rows that spent their attempts before it came back. Returns the
 * released dedupe keys so the caller can dispatch them straight away.
 */
export async function releaseOutboundWorkForUser(userId: string, provider: 'google' | 'outlook') {
  if (!userId) return [];
  const { rows } = await calendarSql(
    `update calendar_sync_failures set attempts = 0, next_attempt_at = now(), updated_at = now()
      where kind = 'outbound' and user_id = $1 and provider = $2
      returning dedupe_key`,
    [userId, provider],
  );
  return rows.map((row: any) => row.dedupe_key as string);
}

function errorText(error: any) {
  return String(error?.stack || error?.message || error || '').slice(0, 2000);
}

/**
 * Record (or coalesce) a failed work item for later retry. The first failure is
 * due immediately on the next sweep; subsequent failures back off.
 *
 * Two correctness details on the conflict path, both carried over from the
 * webhook queue and now applied to both kinds:
 *
 *   1. RESET a dead-lettered row. If the existing row already exhausted its
 *      attempts, a genuinely-new failure would otherwise be absorbed into the
 *      stranded row and never retried, because that row is past the
 *      `attempts < max` selection filter. A new failure on a dead-lettered row
 *      resets attempts to 1 and makes it due now, so the new work gets a fresh
 *      budget.
 *   2. Backoff uses the POST-increment attempt count. `attempts + 1` is the
 *      attempt this scheduling represents, so the exponent must match it.
 */
async function recordFailure(policy: RetryPolicy, {
  dedupeKey, provider, userId, lawFirmId, payload, expiresAt, error, pending = false, stickyEntityFlags = [],
}: any) {
  if (!dedupeKey) return;
  const { rows } = await calendarSql(
    `insert into calendar_sync_failures
       (kind, dedupe_key, provider, user_id, law_firm_id, payload, expires_at,
        last_error, attempts, next_attempt_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, case when $12 then 0 else 1 end, now())
     on conflict (kind, dedupe_key) do update set
       attempts        = case when $12 then 0 when calendar_sync_failures.attempts >= $11
                              then 1
                              else calendar_sync_failures.attempts + 1 end,
       last_error      = excluded.last_error,
       law_firm_id     = coalesce(excluded.law_firm_id, calendar_sync_failures.law_firm_id),
       provider        = coalesce(excluded.provider, calendar_sync_failures.provider),
       user_id         = coalesce(excluded.user_id, calendar_sync_failures.user_id),
       -- A sticky flag already set on the row's entityData survives the
       -- replacement payload (see OUTBOUND_ONE_SHOT_FLAGS).
       payload         = case when cardinality($13::text[]) = 0 or jsonb_typeof(excluded.payload->'entityData') <> 'object'
                              then excluded.payload
                              else jsonb_set(excluded.payload, '{entityData}',
                                     (excluded.payload->'entityData') || coalesce((
                                       select jsonb_object_agg(flag, true) from unnest($13::text[]) as flag
                                        where calendar_sync_failures.payload->'entityData'->>flag = 'true'
                                     ), '{}'::jsonb)) end,
       expires_at      = coalesce(excluded.expires_at, calendar_sync_failures.expires_at),
       next_attempt_at = case when $12 then now() when calendar_sync_failures.attempts >= $11
                              then now()
                              else now() + (least($9, $10 * power(2, calendar_sync_failures.attempts + 1)) || ' milliseconds')::interval end,
       updated_at      = now()
     returning dedupe_key, xmin::text as lease_token`,
    [
      policy.kind, dedupeKey, provider || null, userId || null, lawFirmId || null,
      JSON.stringify(payload || {}), expiresAt || null, errorText(error),
      policy.capMs, policy.baseMs, policy.maxAttempts, pending, stickyEntityFlags,
    ],
  );
  return { dedupeKey: rows[0].dedupe_key, leaseToken: rows[0].lease_token };
}

/**
 * Work items whose retry time has arrived and whose budget is not spent.
 *
 * The `expires_at` guard is what makes the stop kind self-limiting: a channel
 * Google has already expired needs no stopping, so the row is skipped (and
 * `purgeExpiredFailures` removes it). A null `expires_at`, which is every
 * webhook row, never expires.
 */
async function listDueFailures(policy: RetryPolicy, limit = 50) {
  const { rows } = await calendarSql(
    `select *, xmin::text as lease_token from calendar_sync_failures
      where kind = $1
        and next_attempt_at <= now()
        and attempts < $2
        and (expires_at is null or expires_at > now())
      order by next_attempt_at asc
      limit $3`,
    [policy.kind, policy.maxAttempts, limit],
  );
  return rows.map(failureRow);
}

/** The work succeeded (or is no longer needed): drop the item. */
async function resolveFailure(policy: RetryPolicy, dedupeKey: any, leaseToken?: string) {
  if (!dedupeKey) return;
  await calendarSql(
    `delete from calendar_sync_failures where kind = $1 and dedupe_key = $2${leaseToken ? ' and xmin::text = $3' : ''}`,
    leaseToken ? [policy.kind, dedupeKey, leaseToken] : [policy.kind, dedupeKey],
  );
}

/** It failed again: push the next attempt out with backoff, on the same curve
 *  `recordFailure` uses, so a row's spacing does not depend on which path
 *  rescheduled it. */
async function rescheduleFailure(policy: RetryPolicy, dedupeKey: any, error: any, leaseToken?: string) {
  if (!dedupeKey) return;
  await calendarSql(
    `update calendar_sync_failures set
       attempts        = attempts + 1,
       last_error      = $3,
       next_attempt_at = now() + (least($4, $5 * power(2, attempts + 1)) || ' milliseconds')::interval,
       updated_at      = now()
     where kind = $1 and dedupe_key = $2${leaseToken ? ' and xmin::text = $6' : ''}`,
    [policy.kind, dedupeKey, errorText(error), policy.capMs, policy.baseMs, ...(leaseToken ? [leaseToken] : [])],
  );
}

/**
 * Rows that exhausted their retry budget and are no longer selected by the
 * sweep, so the cron can log or alert on them instead of letting them sit
 * silently. Expired rows are excluded: those are self-healed, not stranded.
 */
async function listDeadLetteredFailures(policy: RetryPolicy, limit = 100) {
  const { rows } = await calendarSql(
    `select * from calendar_sync_failures
      where kind = $1 and attempts >= $2
        and (expires_at is null or expires_at > now())
      order by updated_at asc
      limit $3`,
    [policy.kind, policy.maxAttempts, limit],
  );
  return rows.map(failureRow);
}

async function countDeadLetteredFailures(policy: RetryPolicy) {
  const { rows } = await calendarSql(
    `select count(*)::int as n from calendar_sync_failures
      where kind = $1 and attempts >= $2 and (expires_at is null or expires_at > now())`,
    [policy.kind, policy.maxAttempts],
  );
  return rows[0]?.n || 0;
}

// ── the two kinds, as thin named wrappers ───────────────────────────────────
// The names are kept so every caller and test reads the same as before; only
// the storage and the shared body underneath changed.

/**
 * The key one failed notification coalesces on. A Google retry re-reads the
 * whole calendar, so one row per user covers every failure. An Outlook retry
 * re-fetches exactly the event its row names, so each event keeps its own row:
 * coalescing them per user kept only the last event and lost the others.
 */
function webhookDedupeKey(provider: string, userId: string, eventId: string | null | undefined) {
  return provider === 'outlook' && eventId ? `outlook:${userId}:${eventId}` : `${provider}:${userId}`;
}

/** A push notification failed to process. See `webhookDedupeKey` for what coalesces. */
export async function recordWebhookFailure({ provider, userId, lawFirmId, changeType, eventId, resource, error, pending = false }: any) {
  if (!provider || !userId) return;
  return recordFailure(WEBHOOK_RETRY, {
    dedupeKey: webhookDedupeKey(provider, userId, eventId),
    provider, userId, lawFirmId,
    payload: { changeType: changeType || null, eventId: eventId || null, resource: resource || null },
    error, pending,
  });
}

export const listDueWebhookFailures = (limit = 50) => listDueFailures(WEBHOOK_RETRY, limit);
export const resolveWebhookFailure = (dedupeKey: any, leaseToken?: string) => resolveFailure(WEBHOOK_RETRY, dedupeKey, leaseToken);
export const rescheduleWebhookFailure = (dedupeKey: any, error: any, leaseToken?: string) => rescheduleFailure(WEBHOOK_RETRY, dedupeKey, error, leaseToken);
export const listDeadLetteredWebhookFailures = (limit = 100) => listDeadLetteredFailures(WEBHOOK_RETRY, limit);
export const countDeadLetteredWebhookFailures = () => countDeadLetteredFailures(WEBHOOK_RETRY);

/**
 * Drop every queued retry belonging to one firm.
 *
 * `law_firm_id` carries no foreign key: a webhook failure is recorded from the
 * provider's push before the firm has been resolved, so the column is genuinely
 * unknown at insert time. Nothing cascades these when a firm is deleted, and the
 * sweep would otherwise keep re-attempting sync work for a firm that is gone.
 */
export async function deleteWebhookFailuresForLawFirm(lawFirmId: string) {
  if (!lawFirmId) return 0;
  const { rowCount } = await calendarSql(
    `delete from calendar_sync_failures where law_firm_id = $1`,
    [lawFirmId],
  );
  return rowCount;
}

/**
 * Drop the inbound notifications still queued to import one person's calendar
 * into a firm they have left. Outbound rows are kept: those are the deletes that
 * take the firm's copies back off that person's calendar.
 */
export async function deleteWebhookFailuresForUserInFirm(userId: string, lawFirmId: string) {
  if (!userId || !lawFirmId) return 0;
  const { rowCount } = await calendarSql(
    `delete from calendar_sync_failures where kind = 'webhook' and user_id = $1 and law_firm_id = $2`,
    [userId, lawFirmId],
  );
  return rowCount;
}

/**
 * Remove the meetings imported from one person's own calendar into a firm they
 * have left. Every `calendar_events` row is an import, owned by the member whose
 * calendar it came from (`created_by`). The mappings of copies Paralegix pushed
 * for those rows are left for the queued outbound deletes, which address the
 * provider copies through them and remove them afterwards.
 */
export async function purgeFirmImportsForUser(lawFirmId: string, userId: string) {
  if (!lawFirmId || !userId) return 0;
  const { rowCount } = await calendarSql(
    'delete from calendar_events where law_firm_id = $1 and created_by = $2',
    [lawFirmId, userId],
  );
  return rowCount;
}

/**
 * A watch channel that could not be stopped at Google. Keyed by channel id.
 *
 * `resourceId` is required: `channels/stop` cannot be called without it, so a
 * channel missing one is not retryable and is not worth a row.
 */
export async function recordWatchChannelStopFailure({ channelId, resourceId, userId, lawFirmId, expiration, error }: any) {
  if (!channelId || !resourceId) return;
  await recordFailure(CHANNEL_STOP_RETRY, {
    dedupeKey: channelId,
    provider: 'google', userId, lawFirmId,
    payload: { resourceId },
    expiresAt: expiration || null,
    error,
  });
}

/** The stop-retry row for one channel, due or not, or null. */
export async function getWatchChannelStopFailure(channelId: any) {
  if (!channelId) return null;
  const { rows } = await calendarSql(
    'select * from calendar_sync_failures where kind = $1 and dedupe_key = $2',
    [CHANNEL_STOP_RETRY.kind, channelId],
  );
  return failureRow(rows[0]);
}

export const listDueWatchChannelStopFailures = (limit = 50) => listDueFailures(CHANNEL_STOP_RETRY, limit);
export const resolveWatchChannelStopFailure = (channelId: any) => resolveFailure(CHANNEL_STOP_RETRY, channelId);
export const rescheduleWatchChannelStopFailure = (channelId: any, error: any) => rescheduleFailure(CHANNEL_STOP_RETRY, channelId, error);
export const countDeadLetteredWatchChannelStopFailures = () => countDeadLetteredFailures(CHANNEL_STOP_RETRY);

/**
 * Drop rows whose channel has expired at Google. A watch channel carries a
 * 7-day ttl, so an unstopped one stops pushing on its own eventually; this is
 * the self-healing path, and the only one that removes a row automatically. A
 * channel that spent its retry budget while still live is kept, so the count
 * above can report it. Returns how many were removed.
 */
export async function purgeExpiredWatchChannelStopFailures() {
  const { rowCount } = await calendarSql(
    `delete from calendar_sync_failures
      where kind = $1 and expires_at is not null and expires_at <= now()`,
    [CHANNEL_STOP_RETRY.kind],
  );
  return rowCount;
}

// ── shared calendar_sync jsonb writeback applier ────────────────────────────
// Mutates the `calendar_sync` jsonb value-map + `last_synced_to_{provider}`
// column on a relational row, via real SQL (jsonb_set / #- delete). Used by the
// entity repos (tasks, events, events, invoices) to apply the
// normalized descriptors the calendar adapters emit. Plain SQL only, no write
// sentinels, no dotted writeback string parsing.
//
//   table  : relational table name (validated by caller, never user input)
//   where  : { sql, params } the row-identifying WHERE clause + its params
//   descriptor ops:
//     { op:'setKey', provider, userId, key, eventId, changeKey? }
//     { op:'deleteKey', provider, userId, key }
//     { op:'touch', provider }
//     { op:'setField', field/col, value }   (scalar column writeback)
//     { op:'deleteField', field/col }

export async function applyCalendarSyncDescriptor(table: any, where: any, descriptor: any, columnFor: any) {
  if (!descriptor) return;
  const stamp = (provider: any) =>
    provider === 'google' ? 'last_synced_to_google = now()'
      : provider === 'outlook' ? 'last_synced_to_outlook = now()'
        : null;

  switch (descriptor.op) {
    case 'setKey': {
      const { provider, userId, key, eventId, changeKey } = descriptor;
      // Build the nested value object for {provider}.{userId}.{key}.
      const value: any = { eventId };
      if (changeKey !== undefined) value.changeKey = changeKey ?? null;
      // jsonb_set requires every intermediate path level to exist; coalesce the
      // map and each level so a first-write doesn't no-op.
      const p = where.params;
      const sql = `
        update ${table} set
          calendar_sync = jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(calendar_sync, '{}'::jsonb),
                $${p.length + 1}::text[],
                coalesce(calendar_sync #> $${p.length + 1}::text[], '{}'::jsonb), true),
              $${p.length + 2}::text[],
              coalesce(calendar_sync #> $${p.length + 2}::text[], '{}'::jsonb), true),
            $${p.length + 3}::text[],
            $${p.length + 4}::jsonb, true),
          ${stamp(provider)}
        where ${where.sql}`;
      await calendarSql(sql, [
        ...p,
        [provider],
        [provider, userId],
        [provider, userId, key],
        JSON.stringify(value),
      ]);
      return;
    }
    case 'deleteKey': {
      const { provider, userId, key } = descriptor;
      const p = where.params;
      const paths = [[provider, userId, key]];
      // Apply each #- delete in sequence on the same column.
      let expr = 'coalesce(calendar_sync, \'{}\'::jsonb)';
      const extraParams = [];
      for (const path of paths) {
        extraParams.push(path);
        expr = `(${expr} #- $${p.length + extraParams.length}::text[])`;
      }
      const sql = `update ${table} set calendar_sync = ${expr}, ${stamp(provider)} where ${where.sql}`;
      await calendarSql(sql, [...p, ...extraParams]);
      return;
    }
    case 'touch': {
      const { provider } = descriptor;
      const s = stamp(provider);
      if (!s) return;
      await calendarSql(`update ${table} set ${s} where ${where.sql}`, where.params);
      return;
    }
    case 'setField': {
      const col = descriptor.col || (columnFor ? columnFor(descriptor.field) : null);
      if (!col) return;
      const p = where.params;
      await calendarSql(
        `update ${table} set ${col} = $${p.length + 1} where ${where.sql}`,
        [...p, descriptor.value === undefined ? null : descriptor.value]
      );
      return;
    }
    case 'deleteField': {
      const col = descriptor.col || (columnFor ? columnFor(descriptor.field) : null);
      if (!col) return;
      await calendarSql(`update ${table} set ${col} = null where ${where.sql}`, where.params);
      return;
    }
    default:
      return;
  }
}

/** Owned Paralegix copies, paged by provider event id for disconnect cleanup. */
export async function listMappingsForUser(provider: string, userId: string, afterId = '') {
  const { rows } = await calendarSql(`select * from calendar_mappings
    where provider = $1 and user_id = $2 and external_event_id > $3 order by external_event_id limit 100`, [provider, userId, afterId]);
  return rows.map(mapRow);
}
