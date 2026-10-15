const eventBus = require('../../shared/events/eventBus');
const mattersRepo = require('../matters/matters.repository');
const {
  TASK_CREATED, TASK_UPDATED, TASK_DELETED,
  MATTER_EVENT_CREATED, MATTER_EVENT_UPDATED, MATTER_EVENT_DELETED,
  CLIENT_EVENT_CREATED, CLIENT_EVENT_UPDATED, CLIENT_EVENT_DELETED,
  INVOICE_CREATED, INVOICE_UPDATED, INVOICE_DELETED,
  MATTER_MEMBERS_UPDATED,
  MEMBER_ROLE_CHANGED, MEMBER_REMOVED, ROLE_PERMISSIONS_CHANGED,
} = require('../../shared/events/eventTypes');
const { privilegedParameterizedQuery } = require('../../shared/database/queryContext');
const googleService = require('./google/google.service');
const outlookService = require('./outlook/outlook.service');
const { getAdapter } = require('./shared/calendarAdapters');
const calendarTokens = require('./shared/calendarTokens');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { onShutdown } = require('../../shared/utils/shutdownHooks');
// Required up front, never inside a handler: the coalesced sync runs on a timer,
// and loading a module from there can land after the process (or a test file)
// has started tearing down. Namespace imports keep the require cycles through
// the provider services safe.
const outboundRetry = require('./shared/calendarOutboundRetry');
const calendarSyncRepo = require('./shared/calendarSync.repository');
const calendarEntityResolver = require('./shared/calendarEntityResolver');
const membership = require('../../shared/utils/membership');
import { createBoundedCache } from '../../shared/utils/boundedCache';
import { isCalendarRecipient } from './shared/calendarRecipients';

const calendarSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'calendar event fan-out is scoped by the originating firm and entity', text, params,
);

/**
 * Pool connections one sync unit (one entity for one user) can hold at once.
 *
 *   1. The working connection for the unit's own token, mapping and writeback
 *      queries.
 *   2. A lock statement: acquiring or releasing the CALENDAR_SYNC or
 *      OAUTH_REFRESH lease borrows a connection for one statement. Neither lock
 *      holds a connection across the provider API calls (`advisoryLock.ts`).
 *   3. Headroom. Three is the figure from when both locks pinned a connection
 *      for their whole duration; it is kept as a conservative bound rather than
 *      widening sync concurrency as a side effect of the lock change.
 */
const CONNECTIONS_PER_SYNC_UNIT = 3;

/**
 * Pool connections one backfill or one fan-out to matter members may hold in
 * total. An API instance's pool is 12 (against a 15-connection session pooler)
 * and is shared by every live request, and this work runs detached from the
 * request that triggered it, so it gets half the pool at most.
 */
const CALENDAR_SYNC_CONNECTION_BUDGET = 6;

/** Sync units in flight at once: 6 connections / 3 per unit = 2. */
const CALENDAR_SYNC_WIDTH = Math.max(1, Math.floor(CALENDAR_SYNC_CONNECTION_BUDGET / CONNECTIONS_PER_SYNC_UNIT));

/** Matter members synced at once when an entity changes. */
const MATTER_MEMBER_SYNC_CONCURRENCY = Number(process.env.MATTER_MEMBER_SYNC_CONCURRENCY) || CALENDAR_SYNC_WIDTH;

// C2: RBAC is currently disabled server-side. roles.service.resolvePermissions
// returns the full permission set for EVERY member (see TD1, "restore before
// prod"). So today every firm member is a billing-calendar recipient, and the
// behavior-equivalent set-based resolution is simply "all member user ids" in
// one query. When RBAC is restored, flip RBAC_ENFORCED to true to use the
// permission-filtered query (it leans on the roles_perms_gin index via
// permissions @> ARRAY[...]). Either way it is ONE query, not a per-member loop.
// RBAC has been restored (TD1). resolvePermissions enforces per-role permissions
// again, so billing-calendar recipients must be filtered to members holding
// billing.viewInvoices + calendar.sync (the permission-filtered, GIN-indexed query).
const RBAC_ENFORCED = true;

// ── C1: per-user token/settings cache (scoped to one fan-out) ───────────────
//
// A single save fans out to (members × 2 providers). Without caching, EACH
// provider call re-runs getUserDataAndSettings = 3 queries. We instead resolve
// each user's { userData, settings } exactly once per fan-out and pass it into
// both providers. A cheap capability pre-check (one small query) lets us skip
// users with no connected+sync-enabled provider before paying for the full load.

function makeUserSyncCache() {
  const cache = new Map(); // userId -> Promise<{ userData, settings } | null>

  async function resolve(userId: string) {
    if (!userId) return null;
    if (!cache.has(userId)) {
      cache.set(userId, (async () => {
        const caps = await calendarTokens.getOutboundSyncCapabilities(userId, { includeUnusableGrants: true }).catch(() => null);
        // No stored + outbound-sync-enabled provider. Skip the full load. A
        // grant waiting on a reconnect still counts: its work is parked.
        if (!caps || (!caps.google && !caps.microsoft)) return null;
        return calendarTokens.getUserDataAndSettings(userId).catch(() => null);
      })());
    }
    return cache.get(userId);
  }

  return { resolve };
}

// ── C1: debounce/coalesce rapid saves per (userId, entityId) ────────────────
//
// Rapid successive saves of the same entity (e.g. a burst of field edits)
// collapse into a single sync. The LATEST call wins (including its action), so
// a create→update burst settles as one update, and the final state is what we
// push. Keyed without action so different actions on the same entity don't run
// out of order (e.g. a stale create racing a newer delete).
const COALESCE_WINDOW_MS = 1500;
const pendingSyncs = new Map(); // key -> { timer, latest, resolvers }

function coalesceKey(entityType: any, entityId: any, userId: string) {
  return `${entityType}:${entityId}:${userId}`;
}

function runCoalescedSync(key: any) {
  const entry = pendingSyncs.get(key);
  if (!entry) return;
  pendingSyncs.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  const { latest, resolvers } = entry;
  const done = performSyncToCalendars(latest.action, latest.adapter, latest.entityData, latest.userId, latest.timeZone, latest.preloaded)
    .then(() => resolvers.forEach((r: any) => r()))
    .catch(() => resolvers.forEach((r: any) => r()));
  inFlightSyncs.add(done);
  done.finally(() => inFlightSyncs.delete(done));
  return done;
}

// Syncs that have left the debounce window and are talking to a provider. Held
// so shutdown can wait for them rather than killing them mid-write.
const inFlightSyncs = new Set<Promise<unknown>>();

/**
 * Fire every pending debounced sync now, and wait for what is already running.
 *
 * The 1.5s coalescing `setTimeout` fires AFTER the request that scheduled it has
 * responded — precisely when Cloud Run throttles the instance's CPU, and
 * precisely what a SIGTERM lands in the middle of. Without this, a pending sync
 * is silently dropped on every deploy and every scale-in: no outbox row, no
 * failure record, nothing to reschedule it. A calendar edit made in the last
 * moments before a deploy simply never reaches Google or Outlook. That is a real
 * data-loss path at ONE instance; scaling out only makes it more frequent.
 *
 * Bounded by the shutdown hook budget, so a slow provider cannot hold the
 * shutdown open. Anything still unfinished when that budget expires is lost as
 * before — this narrows the window rather than closing it absolutely.
 */
export async function flushPendingSyncs() {
  const keys = Array.from(pendingSyncs.keys());
  const started = keys.map((key) => runCoalescedSync(key)).filter(Boolean);
  const waiting = [...inFlightSyncs, ...started];
  if (!waiting.length) return;
  console.log(`[shutdown] flushing ${keys.length} pending and ${inFlightSyncs.size} in-flight calendar sync(s)`);
  await Promise.allSettled(waiting);
}

onShutdown('calendar-pending-syncs', flushPendingSyncs);

/**
 * Sync an entity to both Google and Outlook calendars (the actual work).
 * `preloaded` is the cached { userData, settings } for this user (C1).
 */
async function performSyncToCalendars(_action: any, adapter: any, entityData: any, userId: string, _timeZone: any, _preloaded: any) {
  for (const provider of ['google', 'outlook']) {
    const key = `${entityData.lawFirmId}:${provider}:${adapter.entityType}:${entityData.id}:${userId}`;
    try { await outboundRetry.dispatchOutboundWork(key); }
    catch (error: any) { console.error('Calendar write queued for retry:', key, error.message); }
  }
}

/**
 * Sync an entity to both providers for one user. Accepts an optional per-fan-out
 * `userCache` (C1) so tokens/settings load once across both providers and across
 * sibling members. Rapid duplicate (userId, entityId, action) calls coalesce.
 */
async function syncToCalendars(action: any, adapter: any, entityData: any, userId: string, timeZone: any, userCache: any, queueOnly = false) {
  if (!userId) return;
  const deleting = action === 'deleteEventsFromEntity';
  const preloaded = !deleting && userCache ? await userCache.resolve(userId) : undefined;
  // Skip entirely when the pre-check ruled the user out (no provider to sync).
  if (preloaded === null) return;

  // Queued on a stored connection, whatever its grant state: a write made while
  // the grant waits on a reconnect is parked by the dispatcher and released by
  // the reconnect. Creates and updates honour the outbound-sync switch; a delete
  // always runs, so a copy already on the calendar is never left behind.
  const caps = await calendarTokens.getOutboundSyncCapabilities(userId, { includeUnusableGrants: true, ignoreSyncSetting: deleting });
  for (const [provider, enabled] of [['google', caps?.google], ['outlook', caps?.microsoft]]) {
    if (enabled) await calendarSyncRepo.recordOutboundWork({ provider, userId, entityType: adapter.entityType, entityData, action, timeZone });
  }

  if (queueOnly) return;

  const key = coalesceKey(adapter.entityType, entityData?.id, userId);
  const existing = pendingSyncs.get(key);
  if (existing) {
    // Collapse into the in-flight window. Latest payload wins.
    existing.latest = { action, adapter, entityData, userId, timeZone, preloaded };
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => runCoalescedSync(key), COALESCE_WINDOW_MS);
    return new Promise((resolve) => existing.resolvers.push(resolve));
  }

  // A debounce record: the newest sync request for this key, everyone waiting on
  // it, and the coalescing timer.
  const entry: {
    latest: Record<string, any>;
    resolvers: Array<(value?: unknown) => void>;
    timer: ReturnType<typeof setTimeout> | null;
  } = {
    latest: { action, adapter, entityData, userId, timeZone, preloaded },
    resolvers: [],
    timer: null,
  };
  pendingSyncs.set(key, entry);
  const done = new Promise((resolve) => entry.resolvers.push(resolve));
  entry.timer = setTimeout(() => runCoalescedSync(key), COALESCE_WINDOW_MS);
  return done;
}

/**
 * The entity payload a mapping row alone can address: enough for a delete to
 * find the copies, and for the dispatcher to re-read the entity. An invoice's
 * scope is `matter:<id>` or `client:<id>`, which is its billing context.
 */
function mappingReference(lawFirmId: string, mapping: { entity_type: string; entity_id: string; scope_id?: string | null }) {
  const reference: Record<string, unknown> = { lawFirmId, id: mapping.entity_id };
  if (mapping.entity_type === 'matterEvent') reference.matterId = mapping.scope_id;
  if (mapping.entity_type === 'clientEvent') reference.clientId = mapping.scope_id;
  if (mapping.entity_type === 'invoiceBilling') {
    const [type, contextId] = String(mapping.scope_id || '').split(':');
    reference.contextType = type === 'matter' ? 'matter' : 'client';
    reference.entityId = contextId || undefined;
    if (type === 'matter') reference.matterId = contextId;
    else reference.clientContextId = contextId;
  }
  return reference;
}

async function getMatterMemberUserIds(lawFirmId: string, matterId: string) {
  if (!lawFirmId || !matterId) return new Set<string>();

  const matterData = await mattersRepo.findByIdRaw(lawFirmId, matterId).catch(() => null);
  if (!matterData) return new Set<string>();

  // matters.repository reconstructs memberUserIds[] via JOIN to matter_members.
  const memberUserIds = Array.isArray(matterData.memberUserIds)
    ? matterData.memberUserIds
    : (Array.isArray(matterData.members) ? matterData.members.map((member: any) => member?.userId).filter(Boolean) : []);

  return new Set<string>(memberUserIds);
}

// Per-lawFirm cache for the firm-wide billing-recipient candidate set.
// Calendar-webhook bursts cluster within seconds; the underlying members
// + users + permission lookups are stable across that window.
// Matched to permissionCache's 30s so the cross-instance staleness bound is
// uniform across everything that caches an authorization answer. This cache IS
// the authorization decision (who may receive billing calendar events), not an
// optimization over one — at 60s a member whose access was just revoked kept
// receiving synced billing entries for a full minute on every instance that had
// not served the change.
const BILLING_RECIPIENTS_TTL_MS = 30_000;

/**
 * Firms held at once. Keyed by firm id, so it grows with the customer base, and
 * the 30s TTL does not bound it: a firm's entry leaves only when that firm is
 * looked up again, and a firm that syncs once and goes quiet never is.
 */
const BILLING_RECIPIENTS_MAX_ENTRIES = Number(process.env.BILLING_RECIPIENTS_CACHE_MAX_ENTRIES) || 2000;

const billingRecipientsCache = createBoundedCache<string[]>({
  name: 'billingRecipients',
  maxEntries: BILLING_RECIPIENTS_MAX_ENTRIES,
  ttlMs: BILLING_RECIPIENTS_TTL_MS,
});

// The billing-recipient set is a permissions query result, so it goes stale for
// exactly the same reasons permissionCache does. Reuse its invalidation events
// so an in-process change is immediate rather than waiting out the TTL. Other
// instances still wait for the TTL — a shared invalidation channel is the
// deferred LISTEN/NOTIFY work.
for (const evt of [MEMBER_ROLE_CHANGED, MEMBER_REMOVED, ROLE_PERMISSIONS_CHANGED]) {
  eventBus.on(evt, async ({ lawFirmId }: any = {}) => {
    try { if (lawFirmId) billingRecipientsCache.delete(lawFirmId); }
    catch (err: any) { console.error('calendar.events: billing recipient cache invalidation failed:', err.message); }
  });
}

async function getFirmBillingRecipients(lawFirmId: string) {
  const cached = billingRecipientsCache.get(lawFirmId);
  if (cached) return cached;

  // C2: ONE set-based query instead of a per-member resolvePermissions loop.
  let rows;
  if (RBAC_ENFORCED) {
    // Owners (all permissions) OR members whose role grants BOTH required perms.
    // permissions @> ARRAY[...] is served by the roles_perms_gin index.
    ({ rows } = await calendarSql(
      `select m.user_id
         from members m
         left join roles r
           on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true
               or r.permissions @> array['billing.viewInvoices','calendar.sync']::text[])`,
      [lawFirmId]
    ).catch(() => ({ rows: [] })));
  } else {
    // RBAC disabled: every member is a recipient (matches resolvePermissions
    // returning ALL_PERMISSIONS for everyone).
    ({ rows } = await calendarSql(
      `select user_id from members where law_firm_id = $1`,
      [lawFirmId]
    ).catch(() => ({ rows: [] })));
  }

  // Filter before mapping: `String(null)` is the truthy string "null", which a
  // filter on the mapped value would let through as a recipient id.
  const userIds: string[] = Array.from(
    new Set(rows.map((r: any) => r.user_id).filter(Boolean).map((id: any) => String(id))),
  );
  billingRecipientsCache.set(lawFirmId, userIds);
  return userIds;
}

async function resolveBillingRecipients(lawFirmId: string, invoiceData: any) {
  if (!lawFirmId || !invoiceData) return [];

  const firmRecipients = await getFirmBillingRecipients(lawFirmId);

  if (invoiceData.contextType === 'matter') {
    const matterMemberUserIds = await getMatterMemberUserIds(lawFirmId, invoiceData.matterId || invoiceData.entityId);
    return firmRecipients.filter((uid: string) => matterMemberUserIds.has(uid));
  }

  return firmRecipients;
}

// ── Task helpers ─────────────────────────────────────────────

/**
 * Returns the set of user IDs that should receive calendar events for a
 * standalone task (no matter): the task creator plus all assigned users.
 */
function getStandaloneTaskUserIds(taskData: any, fallbackUserId: any) {
  const ids = new Set<string>();
  const creator = taskData?.createdBy || fallbackUserId;
  if (creator) ids.add(creator);
  const assignedTo = Array.isArray(taskData?.assignedTo) ? taskData.assignedTo : [];
  for (const uid of assignedTo) {
    if (uid) ids.add(uid);
  }
  return ids;
}

// timeZone is optional because the delete path has always omitted it.
/** Reconcile assigned recipients with every copy already recorded for the entity. */
async function syncAssignedRecipients(action: string, adapter: any, data: any, fallbackUserId?: string, timeZone?: string, queueOnly = false) {
  if (!data?.lawFirmId || !data?.id) return;
  const requested = adapter.entityType === 'task'
    ? getStandaloneTaskUserIds(data, fallbackUserId)
    : new Set<string>(data.assignedTo?.length ? data.assignedTo : [data.createdBy || fallbackUserId].filter(Boolean));
  const { rows: members } = await calendarSql(
    'select user_id from members where law_firm_id = $1 and user_id = any($2::text[])',
    [data.lawFirmId, Array.from(requested)],
  );
  const allowed = new Set<string>();
  for (const member of members) {
    if (!data.matterId || await membership.isFirmOwnerOrAdmin(data.lawFirmId, member.user_id)
      || (await membership.getAccessibleMatterIds(data.lawFirmId, [data.matterId], member.user_id)).has(data.matterId)) {
      allowed.add(member.user_id);
    }
  }
  const { rows: mappings } = await calendarSql(
    'select distinct user_id from calendar_mappings where law_firm_id = $1 and entity_type = $2 and entity_id = $3',
    [data.lawFirmId, adapter.entityType, String(data.id)],
  );
  const existing = new Set<string>(mappings.map((row: any) => row.user_id).filter(Boolean));
  for (const provider of ['google', 'outlook']) {
    Object.keys(data.calendarSync?.[provider] || {}).forEach((uid) => existing.add(uid));
  }
  const deleting = action === 'deleteEventsFromEntity';
  const recipients = new Set([...allowed, ...existing]);
  // Queue-only inbound work must surface capability read failures instead of
  // treating the optional fan-out cache's missing result as a disconnect.
  const cache = queueOnly ? undefined : makeUserSyncCache();
  const settled = await runWithConcurrency(Array.from(recipients).map((uid) => () => syncToCalendars(
    deleting || !allowed.has(uid) ? 'deleteEventsFromEntity' : action, adapter, data, uid, timeZone, cache, queueOnly,
  )), MATTER_MEMBER_SYNC_CONCURRENCY);
  if (queueOnly) {
    const failed = settled.find((result: PromiseSettledResult<unknown>) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

// ── Task listeners ──────────────────────────────────────────

for (const [eventType, action] of [[TASK_CREATED, 'createEventsFromEntity'], [TASK_UPDATED, 'updateEventsFromEntity'], [TASK_DELETED, 'deleteEventsFromEntity']]) {
  eventBus.on(eventType, async ({ lawFirmId, entityData, userId, timeZone }: any) => {
    try {
      await syncAssignedRecipients(action, getAdapter('task'), { ...entityData, lawFirmId }, userId, timeZone);
    } catch (error) { console.error('calendar.events: task sync reconciliation failed:', error); }
  });
}

// ── Matter listeners ──────────────────────────────────────────
// Matters themselves are NOT calendar items. Matter *events* are.
// MATTER_CREATED / MATTER_UPDATED / MATTER_DELETED have no calendar adapter,
// so we intentionally skip them here. Calendar sync happens via
// MATTER_EVENT_* listeners below.

// ── Matter Event listeners ─────────────────────────────────────

eventBus.on(MATTER_EVENT_CREATED, async ({ lawFirmId, matterId, eventData, userId, timeZone }: any) => {
  if (!eventData) return;
  try {
    const lfId = lawFirmId || eventData.lawFirmId;
    const csId = matterId || eventData.matterId;
    await syncAssignedRecipients('createEventsFromEntity', getAdapter('matterEvent'), { ...eventData, lawFirmId: lfId, matterId: csId }, userId, timeZone);
  } catch (err: any) {
    console.error('calendar.events: MATTER_EVENT_CREATED handler failed:', err);
  }
});

eventBus.on(MATTER_EVENT_UPDATED, async ({ lawFirmId, matterId, eventData, userId, timeZone }: any) => {
  if (!eventData) return;
  try {
    const lfId = lawFirmId || eventData.lawFirmId;
    const csId = matterId || eventData.matterId;
    await syncAssignedRecipients('updateEventsFromEntity', getAdapter('matterEvent'), { ...eventData, lawFirmId: lfId, matterId: csId }, userId, timeZone);
  } catch (err: any) {
    console.error('calendar.events: MATTER_EVENT_UPDATED handler failed:', err);
  }
});

eventBus.on(MATTER_EVENT_DELETED, async ({ lawFirmId, matterId, eventData, userId }: any) => {
  if (!eventData) return;
  try {
    const lfId = lawFirmId || eventData.lawFirmId;
    const csId = matterId || eventData.matterId;
    await syncAssignedRecipients('deleteEventsFromEntity', getAdapter('matterEvent'), { ...eventData, lawFirmId: lfId, matterId: csId }, userId);
  } catch (err: any) {
    console.error('calendar.events: MATTER_EVENT_DELETED handler failed:', err);
  }
});

// ── Client Event listeners ───────────────────────────────────

eventBus.on(CLIENT_EVENT_CREATED, async ({ eventData, userId, timeZone }: any) => {
  if (!eventData || !userId) return;
  try {
    await syncAssignedRecipients('createEventsFromEntity', getAdapter('clientEvent'), eventData, userId, timeZone);
  } catch (err: any) {
    console.error('calendar.events: CLIENT_EVENT_CREATED handler failed:', err);
  }
});

eventBus.on(CLIENT_EVENT_UPDATED, async ({ eventData, userId, timeZone }: any) => {
  if (!eventData || !userId) return;
  try {
    await syncAssignedRecipients('updateEventsFromEntity', getAdapter('clientEvent'), eventData, userId, timeZone);
  } catch (err: any) {
    console.error('calendar.events: CLIENT_EVENT_UPDATED handler failed:', err);
  }
});

eventBus.on(CLIENT_EVENT_DELETED, async ({ eventData, userId }: any) => {
  if (!eventData || !userId) return;
  try {
    await syncAssignedRecipients('deleteEventsFromEntity', getAdapter('clientEvent'), eventData, userId);
  } catch (err: any) {
    console.error('calendar.events: CLIENT_EVENT_DELETED handler failed:', err);
  }
});

// ── Matter Members listener (backfill and takeback) ────────────
// When new members are added to a matter, push existing matter events and tasks
// to their external calendars. When members are removed, take the same items
// back off theirs: an ex-member who keeps a matter's hearings on their personal
// calendar is a confidentiality gap, and the mapping rows that address those
// events go with them.

// Bound on a large backfill (events × tasks × users). Each unit costs the same
// pool connections as one member of a fan-out, so it shares that width: a
// backfill of hundreds of units holds at most CALENDAR_SYNC_CONNECTION_BUDGET
// connections, and cannot trip Google/Outlook rate limits either.
const SYNC_CONCURRENCY = CALENDAR_SYNC_WIDTH;

/**
 * Tasks carrying their per-user `calendar_sync` map.
 *
 * The backfill reads tasks through `tasksRepo.findByMatter`, whose projection
 * drops `calendarSync`, having no use for it, since a create writes that map
 * rather than reading it. The removal side does read it: it holds the external
 * event ids belonging to the member being taken off the matter, and without them
 * the delete pass has nothing to address and silently removes nothing. So the
 * removal side reloads each task's calendar state, bounded like the rest of the
 * fan-out because it is one query per task on the matter.
 */
async function tasksWithCalendarState(lawFirmId: string, tasks: any[]) {
  const tasksRepo = require('../tasks/tasks.repository');
  const settled = await runWithConcurrency(
    tasks.map((task: any) => () => tasksRepo.getCalendarState(lawFirmId, task.id || task.taskId)),
    SYNC_CONCURRENCY,
  );
  return settled
    .map((result: any, index: number) => (result.status === 'fulfilled' && result.value ? result.value : tasks[index]))
    .filter(Boolean);
}

eventBus.on(MATTER_MEMBERS_UPDATED, async ({ lawFirmId, matterId, addedUserIds, removedUserIds }: any) => {
  const added = Array.isArray(addedUserIds) ? addedUserIds.filter(Boolean) : [];
  const removed = Array.isArray(removedUserIds) ? removedUserIds.filter(Boolean) : [];
  if (!lawFirmId || !matterId || (added.length === 0 && removed.length === 0)) return;

  try {
    const matterEventsRepo = require('../matters/matterEvents.repository');
    const tasksRepo = require('../tasks/tasks.repository');

    const [matterEvents, rawTasks] = await Promise.all([
      matterEventsRepo.findAll(lawFirmId, matterId).catch(() => []),
      tasksRepo.findByMatter(lawFirmId, matterId).catch(() => []),
    ]);

    const tasks = await tasksWithCalendarState(lawFirmId, rawTasks);
    const matterEventAdapter = getAdapter('matterEvent');
    const taskAdapter = getAdapter('task');

    // C4: one token/settings cache shared across the whole backfill, and
    // short-circuit users with no connected+sync-enabled provider BEFORE
    // iterating their events/tasks (was: a sync call per event/task per user,
    // each reloading tokens).
    const userCache = makeUserSyncCache();
    const syncs = [];
    for (const uid of added) {
      const preloaded = await userCache.resolve(uid); // eslint-disable-line no-await-in-loop
      if (preloaded === null) continue; // no provider to sync: skip this user entirely

      for (const evt of matterEvents) {
        if (evt.status === 'cancelled' || evt.status === 'completed' || !evt.date) continue;
        if (!isCalendarRecipient('matterEvent', evt, uid)) continue;
        syncs.push(() => syncToCalendars('createEventsFromEntity', matterEventAdapter, evt, uid, undefined, userCache));
      }
      for (const task of tasks) {
        if (!task.dueDate || task.status === 'completed') continue;
        // The rule every other push applies: a task goes to its creator as
        // well as its assignees.
        if (!isCalendarRecipient('task', task, uid)) continue;
        syncs.push(() => syncToCalendars('createEventsFromEntity', taskAdapter, task, uid, undefined, userCache));
      }
    }

    if (removed.length > 0) {
      const removableTasks = await tasksWithCalendarState(lawFirmId, tasks);
      for (const uid of removed) {

        // Deliberately unfiltered, unlike the backfill above. The delete path
        // works from the ids already stored FOR THIS USER, so an item that would
        // no longer be created (a cancelled hearing, a task whose due date was
        // cleared) can still have a live event on their calendar. Skipping those
        // is exactly how a copy gets left behind. An item the user never had
        // resolves to no event id and costs no provider call.
        for (const evt of matterEvents) {
          syncs.push(() => syncToCalendars('deleteEventsFromEntity', matterEventAdapter, evt, uid, undefined, userCache));
        }
        for (const task of removableTasks) {
          syncs.push(() => syncToCalendars('deleteEventsFromEntity', taskAdapter, task, uid, undefined, userCache));
        }
      }

      // The matter's invoice billing dates go too: a matter invoice reaches only
      // that matter's members. Addressed through the copies each removed member
      // actually holds, so an invoice they never received costs nothing.
      const invoiceAdapter = getAdapter('invoiceBilling');
      const { rows: invoiceCopies } = await calendarSql(
        `select distinct user_id, entity_type, entity_id, scope_id from calendar_mappings
          where law_firm_id = $1 and entity_type = 'invoiceBilling' and user_id = any($2::text[])
            and (scope_id = $3 or entity_id in (select id::text from invoices where law_firm_id = $1 and matter_id = $4))`,
        [lawFirmId, removed, `matter:${matterId}`, matterId],
      );
      for (const copy of invoiceCopies) {
        const reference = mappingReference(lawFirmId, copy);
        const entity = calendarEntityResolver.resolveFromMapping({ lawFirmId, entityType: copy.entity_type, entityId: copy.entity_id, scopeId: copy.scope_id });
        const state = entity ? await entity.getState().catch(() => null) : null; // eslint-disable-line no-await-in-loop
        syncs.push(() => syncToCalendars('deleteEventsFromEntity', invoiceAdapter, state ? { ...reference, ...state } : reference, copy.user_id, undefined, userCache));
      }
    }

    // Bounded concurrency: thunks aren't started until a worker picks them up.
    await runWithConcurrency(syncs, SYNC_CONCURRENCY);
  } catch (err: any) {
    console.error('calendar.events: MATTER_MEMBERS_UPDATED handler failed:', err);
  }
});

// ── Billing listeners ────────────────────────────────────────

async function syncInvoiceBilling(action: any, lawFirmId: string, invoiceData: any) {
  if (!lawFirmId || !invoiceData?.id) return;

  // Everyone who may see the invoice now, plus everyone who already holds a copy
  // of it. A holder who is no longer a recipient (off the matter, or their role
  // lost billing access) gets a delete, so a copy never outlives the access
  // that put it there.
  const eligible = new Set<string>(await resolveBillingRecipients(lawFirmId, invoiceData));
  const { rows: holders } = await calendarSql(
    'select distinct user_id from calendar_mappings where law_firm_id = $1 and entity_type = $2 and entity_id = $3',
    [lawFirmId, 'invoiceBilling', String(invoiceData.id)],
  );
  const recipients = new Set<string>(eligible);
  holders.forEach((row: any) => { if (row.user_id) recipients.add(row.user_id); });
  for (const provider of ['google', 'outlook']) {
    Object.keys(invoiceData.calendarSync?.[provider] || {}).forEach((uid) => recipients.add(uid));
  }
  if (recipients.size === 0) return;

  const adapter = getAdapter('invoiceBilling');
  // C2: reuse one token/settings cache across all billing recipients.
  const userCache = makeUserSyncCache();
  // Bounded for the same reason as the matter-member fan-out: every recipient
  // costs a capability query, up to five more on a cache miss, and two
  // sequential provider API calls. This path is reached once per created
  // invoice, and split-invoice creation emits one per split with no cap on the
  // split count, so the two multiply — a wide split against a firm where many
  // members can see billing would otherwise put recipients x splits calls in
  // flight at once.
  await runWithConcurrency(
    Array.from(recipients).map((recipientUserId: string) => () =>
      syncToCalendars(eligible.has(recipientUserId) ? action : 'deleteEventsFromEntity', adapter, invoiceData, recipientUserId, undefined, userCache),
    ),
    MATTER_MEMBER_SYNC_CONCURRENCY,
  );
}

eventBus.on(INVOICE_CREATED, async ({ lawFirmId, invoiceData }: any) => {
  try {
    await syncInvoiceBilling('createEventsFromEntity', lawFirmId, invoiceData);
  } catch (err: any) {
    console.error('calendar.events: INVOICE_CREATED handler failed:', err);
  }
});

eventBus.on(INVOICE_UPDATED, async ({ lawFirmId, invoiceData }: any) => {
  try {
    await syncInvoiceBilling('updateEventsFromEntity', lawFirmId, invoiceData);
  } catch (err: any) {
    console.error('calendar.events: INVOICE_UPDATED handler failed:', err);
  }
});

eventBus.on(INVOICE_DELETED, async ({ lawFirmId, invoiceData }: any) => {
  try {
    await syncInvoiceBilling('deleteEventsFromEntity', lawFirmId, invoiceData);
  } catch (err: any) {
    console.error('calendar.events: INVOICE_DELETED handler failed:', err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};

/** Persist each assigned recipient's latest state before acknowledging a provider delta. */
export async function queueInboundFanout(entityType: string, data: any, userId: string) {
  await syncAssignedRecipients('updateEventsFromEntity', getAdapter(entityType), data, userId, data.timeZone, true);
}

/**
 * Take down, or re-check, every copy a firm's members hold after access changed.
 *
 * Two phases, so a failure part-way cannot lose the rest of the cleanup. First
 * every copy gets a durable outbound row (a failed entity read falls back to the
 * reference the mapping carries). Only then is each row dispatched, each in its
 * own try: a dispatch that fails is already rescheduled for the sweep.
 */
async function queueAccessCleanup(eventType: string, lawFirmId: string, userId: string | null) {
  const { rows } = await calendarSql(`select distinct provider, user_id, entity_type, entity_id, scope_id
    from calendar_mappings where law_firm_id = $1 and ($2::text is null or user_id = $2)`, [lawFirmId, userId || null]);
  const queued: string[] = [];
  for (const mapping of rows) {
    try {
      const reference = mappingReference(lawFirmId, mapping);
      let data = null;
      let readFailed = false;
      try {
        const entity = calendarEntityResolver.resolveFromMapping({ lawFirmId, entityType: mapping.entity_type, entityId: mapping.entity_id, scopeId: mapping.scope_id });
        data = entity ? await entity.getState() : null;
      } catch (error: any) {
        console.error('calendar.events: access cleanup could not read', mapping.entity_type, mapping.entity_id, error.message);
        readFailed = true;
      }
      // An entity that is gone takes its copy with it. One that could not be
      // read is queued as an update, which the dispatcher re-resolves and
      // re-checks against the person's access before writing anything.
      const action = eventType === MEMBER_REMOVED || (!data && !readFailed) ? 'deleteEventsFromEntity' : 'updateEventsFromEntity';
      const work = await calendarSyncRepo.recordOutboundWork({ provider: mapping.provider, userId: mapping.user_id, entityType: mapping.entity_type,
        entityData: data ? { ...reference, ...data } : reference, action });
      if (work?.dedupeKey) queued.push(work.dedupeKey);
    } catch (error: any) {
      console.error('calendar.events: access cleanup could not queue', mapping.entity_type, mapping.entity_id, error.message);
    }
  }
  return queued;
}

async function dispatchAccessCleanup(queued: string[]) {
  for (const dedupeKey of queued) {
    try { await outboundRetry.dispatchOutboundWork(dedupeKey, { refreshEntity: true }); }
    catch (error: any) { console.error('Calendar access cleanup queued for retry:', dedupeKey, error.message); }
  }
}

/**
 * Stop importing a person's calendar into a firm they just left.
 *
 * A person has one Google watch channel and one Outlook subscription, stamped
 * with the single firm their imports land in. Left as is, the old firm keeps
 * receiving their meetings and the firm they still belong to never does. So a
 * subscription stamped with the old firm moves to a remaining firm, with a full
 * catch-up queued there, or is stopped when no firm remains. The meetings
 * already imported into the old firm are purged after the watch has moved, so a
 * notification in between cannot re-import one.
 */
async function moveImportsOffFirm(lawFirmId: string, userId: string) {
  const { rows: remaining } = await calendarSql(
    'select law_firm_id from members where user_id = $1 and law_firm_id <> $2 order by joined_at nulls last, law_firm_id limit 1',
    [userId, lawFirmId],
  );
  const nextFirmId: string | null = remaining[0]?.law_firm_id || null;
  if (nextFirmId) {
    const moved = await calendarSyncRepo.restampSubscriptionsForUser(userId, lawFirmId, nextFirmId);
    for (const provider of new Set<string>(moved.map((row: any) => row.provider))) {
      await calendarSyncRepo.recordWebhookFailure({ provider, userId, lawFirmId: nextFirmId, changeType: 'catch_up', eventId: 'reconnect', pending: true });
    }
  } else {
    for (const sub of await calendarSyncRepo.listSubscriptionsForUserInFirm(userId, lawFirmId)) {
      try {
        if (sub.provider === 'google') await googleService.stopWatchChannel(sub.id);
        else await outlookService.stopSubscription(sub.id);
      } catch (error: any) {
        console.error('calendar.events: stopping live import after member removal failed:', sub.provider, sub.id, error.message);
      }
    }
  }
  await calendarSyncRepo.deleteWebhookFailuresForUserInFirm(userId, lawFirmId);
  await calendarSyncRepo.purgeFirmImportsForUser(lawFirmId, userId);
}

for (const eventType of [MEMBER_REMOVED, MEMBER_ROLE_CHANGED, ROLE_PERMISSIONS_CHANGED]) {
  eventBus.on(eventType, async ({ lawFirmId, userId }: any) => {
    if (!lawFirmId) return;
    try {
      const queued = await queueAccessCleanup(eventType, lawFirmId, userId || null);
      if (eventType === MEMBER_REMOVED && userId) {
        try { await moveImportsOffFirm(lawFirmId, userId); }
        catch (error: any) { console.error('calendar.events: moving imports off a firm after member removal failed:', error); }
      }
      await dispatchAccessCleanup(queued);
    } catch (error: any) {
      console.error(`calendar.events: ${eventType} calendar cleanup failed:`, error);
    }
  });
}
