/**
 * Shared provider sync engine.
 *
 * The Google and Outlook services were ~80% identical: the inbound upsert
 * priority chain, cross-sync to the other provider, the last-writer-wins
 * stale guards, the outbound-push stamp, the calendar_mappings
 * resolution, and the cancelled/deleted reconciliation differed ONLY in API
 * field names and which sibling provider they push to. That logic now lives here
 * ONCE and is parameterized by a provider STRATEGY object (see
 * google/googleStrategy.js and outlook/outlookStrategy.js).
 *
 * What the strategy supplies (see either strategy file for the full shape):
 *   - provider              : 'google' | 'outlook'
 *   - otherProvider         : the cross-sync target ('outlook' | 'google')
 *   - getServiceModule()    : lazy require of THIS provider's service (for self refs)
 *   - getOtherServiceModule(): lazy require of the SIBLING service (cross-sync target)
 *   - getEventId(event)     : provider event id
 *   - getEventModified(event): provider "last modified" Date or null
 *   - isGoneForUser(event)  : cancelled / declined / not an appointment: inbound treats it as a delete
 *   - isRecurringSeries(event) / isRecurringInstance(event): a series parent / one of its occurrences
 *   - getICalUid(event)     : the invitation's normalized iCalendar UID, shared by both providers
 *   - getProviderIdOnRow(row) / buildTwinLink(event) / buildUnlink(): this provider's id on an imported row
 *   - deleteOwnEvent(userId, eventId): delete one event on this provider
 *   - getEventEnd(event)    : end instant of a timed event, null when all-day
 *   - getAllDayEnd(event)   : an all-day event's exclusive end day at its noon anchor, null when timed
 *   - lastSyncedField        : 'lastSyncedToGoogle' | 'lastSyncedToOutlook'
 *   - otherLastModifiedField : the SIBLING provider's *LastModified field name
 *   - lastModifiedField      : THIS provider's *LastModified field name
 *   - externalIdPrefix       : 'google_' | 'outlook_'
 *   - findTaskIdByEventId(lawFirmId, eventId)
 *   - findExternalByEventId(lawFirmId, eventId)   (calendar_events row)
 *   - getExternalProviderId(externalRow)          (sibling id for cross-delete)
 *   - getTaskProviderId(taskData)                 (sibling id for cross-delete)
 *   - buildDeleteWriteback(adapter, key, userId)  (drop one member's event for an item)
 *   - buildTaskUpdateData(event, existingTitle, entityType?)
 *   - buildMappedEventUpdateData(event, existingTitle, entityType?)
 *       (entityType: what a mapping says was pushed, for a description whose marker was deleted)
 *   - getEventZones(event)                          ([start zone, end zone] of a timed event)
 *   - fetchEvent(userId, eventId, calendarId?)      ({ status, event } for one of the member's events)
 *   - buildExternalEventData(event, existingTitle?)
 *   - applyExternalLastModified(updateData, event)  (stamp *LastModified on external upsert)
 *   - buildNewExternalEventData(event, userId)      (full row for a brand-new external event)
 *   - getOriginatedBodyText(event)                  (text to test isParalegixOriginated)
 *   - syncBillingEvent(event, mappingRecord, lawFirmId, userId)
 *   - findWatchEntityForUser(userId)               (watch channel / subscription row)
 *   - cacheWatchEntityForUser(userId, id)/evict    (handled internally; strategy gives find + stamp)
 *   - stampWatchEntity(id)
 */

const calendarEventsRepo = require('../calendarEvents.repository');
const calendarSyncRepo = require('./calendarSync.repository');
const resolver = require('./calendarEntityResolver');
const tasksRepo = require('../../tasks/tasks.repository');
const { isParalegixOriginated } = require('./calendarHelpers');
const { toInstant, normalizeTimeZone, getTimeZoneOffsetMs } = require('../../../shared/utils/time');
const { DEFAULT_TIMED_BLOCK_MS } = require('./calendarTime');

const DAY_MS = 24 * 60 * 60 * 1000;
const { shiftedEnd } = require('../../../shared/validation/eventRange');
// Property access, not a destructured import: a test simulating "no
// entity-scoped lock" (to prove what the CALENDAR_ENTITY lock below actually
// closes) replaces `advisoryLock.withLock` on this shared module object, and
// that only works when callers read the property at call time rather than
// capturing the function reference at require time.
const advisoryLock = require('../../../shared/database/advisoryLock');


// ── last-writer-wins guard ──────────────────────────────────────────────────
// Returns true when the SIBLING provider's *LastModified or Paralegix updatedAt
// is newer than this provider's event-modified time. In which case the inbound
// event is stale and should be skipped. Mirrors the per-branch comparison the two
// services duplicated three times each.
export function siblingOrParalegixIsNewer(entityData: any, eventModified: any, otherLastModifiedField: any) {
  if (!eventModified) return false;
  const providerTime = eventModified instanceof Date ? eventModified : new Date(eventModified);

  const otherTime = toInstant(entityData?.[otherLastModifiedField]);
  if (otherTime && otherTime > providerTime) return true;

  const paralegixTime = toInstant(entityData?.updatedAt);
  if (paralegixTime && paralegixTime > providerTime) return true;

  return false;
}

const latestOf = (...dates: Array<Date | null>) => dates.reduce<Date | null>(
  (latest, d) => (d && (!latest || d > latest) ? d : latest), null,
);

/**
 * The stale guard for an item a calendar mapping links to this copy.
 *
 * `updated_at` alone cannot tell: every outbound push stamps the row through
 * `touchProviderSync`, which moves it, so a push to one member's calendar made
 * another member's earlier but genuine edit look older than Paralegix. So:
 *   - a newer edit from the sibling provider still wins;
 *   - a Paralegix edit not pushed anywhere yet (`updatedAt` after every
 *     `lastSyncedTo*` stamp) wins when it is newer than the provider edit;
 *   - otherwise the provider edit is the member's own when it was made after
 *     this copy's last push (`pushedModifiedAt`), and that push coming back
 *     when it was not.
 * A mapping with no recorded push keeps the `updatedAt` comparison.
 */
export function mappedInboundIsStale(entityData: any, eventModified: any, otherLastModifiedField: any, pushedModifiedAt: any) {
  const pushedAt = toInstant(pushedModifiedAt);
  if (!eventModified || !pushedAt) return siblingOrParalegixIsNewer(entityData, eventModified, otherLastModifiedField);
  const providerTime = eventModified instanceof Date ? eventModified : new Date(eventModified);

  const otherTime = toInstant(entityData?.[otherLastModifiedField]);
  if (otherTime && otherTime > providerTime) return true;

  const paralegixTime = toInstant(entityData?.updatedAt);
  const lastPush = latestOf(toInstant(entityData?.lastSyncedToGoogle), toInstant(entityData?.lastSyncedToOutlook));
  const unpushed = paralegixTime && (!lastPush || paralegixTime > lastPush);
  if (unpushed && paralegixTime > providerTime) return true;

  return providerTime <= pushedAt;
}

// ── inbound time zone ───────────────────────────────────────────────────────
// A member's copy carries the item's own zone when the item has one. So an
// item with a zone takes another only when the event's start or end is now in
// a zone that puts a different clock on the start (Graph reports Windows
// names, several of which map onto one IANA zone, and an alias is not a
// change). An item without a zone was pushed in a zone the push filled in:
// UTC, or the member's own (`pushDefaults`). Taking that back would hand one
// member's zone to the whole firm, so only a zone other than those, one the
// member chose in the provider, is taken. The start instant is unaffected
// either way. Returns the zone to write, or undefined to leave the column.

const isRealZone = (zone: unknown): zone is string => typeof zone === 'string' && !!zone && normalizeTimeZone(zone) === zone;

export function inboundZone(currentZone: any, zones: unknown[], start: any, pushDefaults: unknown[] = []) {
  const at = toInstant(start)?.getTime() ?? Date.now();
  const sameClock = (a: string, b: string) => getTimeZoneOffsetMs(at, a) === getTimeZoneOffsetMs(at, b);
  const known = isRealZone(currentZone) ? [currentZone] : ['UTC', ...pushDefaults.filter(isRealZone)];
  return zones.find((zone): zone is string => isRealZone(zone) && !known.some((k) => sameClock(zone, k)));
}

// The member's own zone, which a push fills in for an item without one.
async function memberZone(userId: string) {
  const settings = await require('./calendarTokens').getSettings(userId).catch(() => null);
  return settings?.timezone || null;
}

// ── inbound location ────────────────────────────────────────────────────────
// The push sends one location string, read from the item's columns in a fixed
// order (`calendarAdapters`): a matter event's `location`, else its
// `locationName`; a client event's `location`, else its court's name, else its
// `locationName`. So when that string comes back:
//   - unchanged, nothing is written;
//   - as a client event's court name, nothing is copied: the name is joined
//     from `courts`, never stored on the event, so `location` is only cleared
//     to let the court show through;
//   - as a new value, it goes in `location`, the column the next push reads
//     first, so an older value ahead of it cannot overwrite the edit;
//   - cleared, `location` and `locationName` are both cleared, since either
//     would otherwise be pushed straight back. A court still shows.

function pushedLocation(entityType: string, data: any) {
  const value = entityType === 'clientEvent'
    ? data?.location || data?.courtName || data?.locationName
    : data?.location || data?.locationName;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function applyInboundLocation(entityType: string, current: any, update: any) {
  if (update.location === undefined) return;
  const incoming = typeof update.location === 'string' && update.location.trim() ? update.location.trim() : null;
  delete update.location;
  delete update.locationName;
  if (incoming === pushedLocation(entityType, current)) return;
  const courtName = entityType === 'clientEvent' && typeof current?.courtName === 'string' ? current.courtName.trim() : null;
  if (courtName && incoming === courtName) {
    if (current?.location) update.location = null;
    return;
  }
  update.location = incoming;
  if (incoming === null && current?.locationName) update.locationName = null;
}

// ── who may change a mapped item ────────────────────────────────────────────
// The same checks the Paralegix routes make before writing the item: a task
// needs `tasks.update` and, on a matter, membership of it; a matter event
// `matters.update` and `assertEventWriteAccess`; a client event
// `clients.manage`. False on a refusal; any other failure propagates.

async function mayWriteMappedItem(entityType: string, lawFirmId: string, data: any, userId: string) {
  const { assertFirmPermission } = require('../../lawfirms/roles/requirePermission');
  const { assertMatterMembership } = require('../../../shared/utils/membership');
  try {
    if (entityType === 'task') {
      await assertFirmPermission(lawFirmId, userId, 'tasks.update');
      if (data?.matterId) await assertMatterMembership(lawFirmId, data.matterId, userId);
    } else if (entityType === 'matterEvent') {
      await assertFirmPermission(lawFirmId, userId, 'matters.update');
      await require('../../matters/matterEvents.service').assertEventWriteAccess(lawFirmId, data.matterId, userId);
    } else if (entityType === 'clientEvent') {
      await assertFirmPermission(lawFirmId, userId, 'clients.manage');
    }
    return true;
  } catch (err: any) {
    if (err?.statusCode === 403 || err?.statusCode === 404) return false;
    throw err;
  }
}

// ── provider-agnostic mapping resolution ────────────────────────────────────
// (These were byte-identical in both services.) An optional prefetched
// Map<externalEventId, mappingRow> (C3) lets a delta page resolve all mappings in
// one query; falls back to a single lookup when absent.

export async function findExistingCalendarMapping(externalEventId: any, mappingCache: any) {
  const mapping = mappingCache && mappingCache.has(externalEventId)
    ? mappingCache.get(externalEventId)
    : await calendarSyncRepo.getMappingByExternalId(externalEventId);
  if (!mapping) return null;
  if (mapping.entityType === 'invoiceBilling') return null;
  const entity = resolver.resolveFromMapping(mapping);
  if (!entity) return null;
  const data = await entity.getState();
  if (!data) return null;
  return { entity, data };
}

export async function findExistingCalendarMappingRecord(externalEventId: any, mappingCache: any) {
  const mapping = mappingCache && mappingCache.has(externalEventId)
    ? mappingCache.get(externalEventId)
    : await calendarSyncRepo.getMappingByExternalId(externalEventId);
  if (!mapping) return null;

  const entity = resolver.resolveFromMapping(mapping);
  if (!entity) return null;
  const data = await entity.getState();
  if (!data) return null;

  return {
    entity,
    data,
    entityType: mapping.entityType || null,
    itemKey: mapping.itemKey || null,
    mappedUserId: mapping.userId || null,
    pushedModifiedAt: mapping.pushedModifiedAt || null,
  };
}

// ── inbound end time for a mapped matter / client event or a task ──────────
// `events` and `tasks` rows carry an optional `ends_at`, and a CHECK keeps it
// after the start.
// An inbound move that rewrote only `date` therefore failed outright whenever
// the event moved past its old end (a hearing pushed to next week), and the
// change was retried until it dead-lettered. Returns the end to write, or
// undefined to leave the column alone:
//   - an all-day provider event: its own exclusive end day when it covers more
//     than one day, so a span changed in the provider comes back, and a timed
//     item made all-day there does not keep an instant as its end. One that
//     covers a single day drops any end it had.
//   - a timed provider event with an end after the new start: that end, so a
//     duration changed in the provider comes back too. For an event with no
//     end of its own, only when it is not the one-hour block the outbound push
//     fills in, so a mere move does not invent an end the event never had.
//   - otherwise, an all-day event with an end and no provider day to read:
//     the old end shifted by however far the start moved.
//   - otherwise: left alone.
// An event that really is exactly one hour long is indistinguishable from that
// default, so its end is not recorded; accepted, since nothing is lost: the
// next push fills in the same hour.

export function inboundEndsAt(current: any, update: any, providerEnd: Date | null, providerAllDayEnd?: Date | null) {
  const oldEnd = toInstant(current?.endsAt);
  const newStart = toInstant(update?.date);
  if (!newStart) return undefined;
  // An all-day item takes the provider's own last day, so a span lengthened in
  // the provider comes back, and so does a timed item made all-day there (whose
  // old end is an instant, not a day). One that covers a single day has no end.
  if (update.allDay && providerAllDayEnd !== undefined) {
    if (providerAllDayEnd && providerAllDayEnd.getTime() - newStart.getTime() > DAY_MS) return providerAllDayEnd;
    return oldEnd ? null : undefined;
  }
  const providerSpan = providerEnd && !update.allDay ? providerEnd.getTime() - newStart.getTime() : 0;
  if (!oldEnd) return providerSpan > 0 && providerSpan !== DEFAULT_TIMED_BLOCK_MS ? providerEnd : undefined;
  if (providerSpan > 0) return providerEnd;
  const oldStart = toInstant(current?.date);
  if (!oldStart) return undefined;
  return shiftedEnd(oldStart, oldEnd, newStart);
}

/**
 * The task form of `inboundEndsAt`. A task's calendar state carries its start
 * instant in `dueDate`, and its inbound update names the new start `dueDate`
 * too, so both are mapped onto the `date` the shared rule reads.
 */
function applyInboundTaskEnd(current: any, update: any, providerEnd: Date | null, providerAllDayEnd: Date | null) {
  if (update?.dueDate === undefined) return;
  const endsAt = inboundEndsAt(
    { date: current?.dueDate, endsAt: current?.endsAt },
    { date: update.dueDate, allDay: update.allDay },
    providerEnd,
    providerAllDayEnd,
  );
  if (endsAt !== undefined) update.endsAt = endsAt;
}

export async function applyMappedEventInboundUpdate(entityType: any, lawFirmId: string, entityData: any, updateData: any) {
  const matterEventsRepo = require('../../matters/matterEvents.repository');
  const clientEventsRepo = require('../../clients/clientEvents.repository');
  if (entityType === 'matterEvent') {
    await matterEventsRepo.applyInboundUpdate(lawFirmId, entityData.matterId, entityData.id, updateData);
  } else if (entityType === 'clientEvent') {
    await clientEventsRepo.applyInboundUpdate(lawFirmId, entityData.clientId, entityData.id, updateData);
  } else {
    // Any other mapping type silently no-ops here. Make the gap observable so a
    // missing matter surfaces as a log line instead of silent inbound data loss.
    console.warn(
      `providerSyncEngine: applyMappedEventInboundUpdate: unhandled mapping entityType '${entityType}' for entity ${entityData?.id} (no inbound update applied)`
    );
  }
}

/**
 * Build the engine bound to a single provider strategy. Returns the functions the
 * provider service delegates to (exact behavior of the old per-provider versions).
 */
export function createEngine(strategy: any) {
  const {
    provider,
    otherLastModifiedField,
    externalIdPrefix,
  } = strategy;

  // ── outbound-push stamp (watch channel / subscription) ────────────────────
  // Per-process cache of the user's channel/subscription id (was duplicated as
  // userIdToChannelIdCache / userIdToSubscriptionIdCache).
  const userIdToWatchEntityId = new Map();

  async function stampOutboundPush(userId: string) {
    if (!userId) return;
    try {
      let id = userIdToWatchEntityId.get(userId);
      if (!id) {
        const entity = await strategy.findWatchEntityForUser(userId);
        if (!entity) return;
        id = entity.id;
        userIdToWatchEntityId.set(userId, id);
      }
      await strategy.stampWatchEntity(id);
    } catch (err) {
      // Channel/subscription may have been deleted/recreated. Evict and retry next push.
      userIdToWatchEntityId.delete(userId);
    }
  }

  // Was this provider event created by Paralegix? Every copy a push creates
  // gets a calendar_mappings row before anything else is written.
  // An imported row can also carry the member's OWN copy of the same meeting on
  // the other calendar (linked by invitation UID below), which has none, and
  // which Paralegix must never rewrite or delete on the member's behalf.
  async function isOurCopy(eventId: string) {
    return Boolean(await calendarSyncRepo.getMappingByExternalId(eventId));
  }

  async function bothAreMembersOwn(row: any, siblingEventId: string) {
    const ownId = strategy.getProviderIdOnRow(row);
    return !(await isOurCopy(siblingEventId)) && !(ownId && await isOurCopy(ownId));
  }

  // ── cross-sync to the sibling provider ────────────────────────────────────
  async function crossSync(entity: any, entityType: any, userId: string) {
    try {
      const siblingSvc = strategy.getOtherServiceModule();
      const { getAdapter } = require('./calendarAdapters');

      const data = await entity.getState();
      if (!data) return;
      const adapter = getAdapter(entityType);
      if (['task', 'matterEvent', 'clientEvent'].includes(entityType)) {
        await require('../calendar.events').queueInboundFanout(entityType, data, userId);
        return;
      }

      const items = await adapter.toCalendarItems(data);
      const siblingId = strategy.getSiblingAdapterEventId(adapter, data, items, userId);
      // Both sides are the member's own copies of one meeting, linked by UID:
      // each calendar already has it, and pushing would overwrite their
      // invitation. (When either side is a copy Paralegix made, the change
      // carries across as usual.)
      if (siblingId && entityType === 'externalEvent' && await bothAreMembersOwn(data, siblingId)) return;
      if (entityType === 'externalEvent') {
        const queued = await calendarSyncRepo.recordOutboundWork({
          provider: strategy.otherProvider, userId, entityType, entityData: data,
          action: siblingId ? 'updateEventsFromEntity' : 'createEventsFromEntity',
        });
        try {
          await require('./calendarOutboundRetry').dispatchOutboundWork(queued.dedupeKey);
        } catch (error: any) {
          // The inbound change is safe to acknowledge once the sibling work
          // is durable, even when its provider is temporarily unavailable.
          console.error('Calendar sibling write queued for retry:', queued.dedupeKey, error.message);
        }
        return;
      }
      if (siblingId) {
        await siblingSvc.updateEventsFromEntity(adapter, data, userId);
      } else {
        await siblingSvc.createEventsFromEntity(adapter, data, userId);
      }
    } catch (err) {
      console.error(`${provider}.service: cross-sync to ${strategy.otherProvider} failed:`, err);
      throw err;
    }
  }

  async function deleteSiblingCopy(entityType: string, entityData: any, userId: string) {
    // Save the copy's addressing data before its source row or per-user links
    // are removed, so a refused provider delete remains replayable.
    const queued = await calendarSyncRepo.recordOutboundWork({
      provider: strategy.otherProvider, userId, entityType, entityData,
      action: 'deleteEventsFromEntity',
    });
    try {
      await require('./calendarOutboundRetry').dispatchOutboundWork(queued.dedupeKey);
    } catch (error: any) {
      console.error('Calendar sibling deletion queued for retry:', queued.dedupeKey, error.message);
    }
  }

  // ── mapped-entity (matterEvent/clientEvent) read-decide-write ──────────────
  // Runs under the CALENDAR_ENTITY lock in `upsertExternalEvent` below. Reads
  // the entity FRESH here, inside the lock, rather than reusing
  // `existingMapping.data` (resolved before the lock was acquired): that
  // snapshot can be stale by the time this call gets to run, if it waited on
  // a sibling caller that just committed its own update to the same entity.
  // Put the item's Paralegix state back on this member's copy, for an edit
  // the member was not allowed to make. Queued first, so a provider outage
  // leaves the restore to the retry sweep.
  async function restoreMemberCopy(entityType: string, entity: any, data: any, userId: string) {
    const queued = await calendarSyncRepo.recordOutboundWork({
      provider, userId, entityType,
      entityData: { ...data, id: entity.id, lawFirmId: entity.lawFirmId },
      action: 'updateEventsFromEntity',
    });
    try {
      await require('./calendarOutboundRetry').dispatchOutboundWork(queued.dedupeKey);
    } catch (error: any) {
      console.error('Calendar copy restore queued for retry:', queued.dedupeKey, error.message);
    }
  }

  async function applyMappedEntityUpdate(existingMapping: any, event: any, eventModified: any, userId: string) {
    const eventData = await existingMapping.entity.getState();
    if (!eventData) return 'skipped';

    if (mappedInboundIsStale(eventData, eventModified, otherLastModifiedField, existingMapping.pushedModifiedAt)) {
      // A previous inbound write may have committed before its outbound work
      // could be queued. Replay the saved state even when the delta is stale.
      if (['task', 'matterEvent', 'clientEvent'].includes(existingMapping.entityType)) {
        await crossSync(existingMapping.entity, existingMapping.entityType, userId);
      }
      return 'skipped';
    }

    // The item is the firm's, so a member's provider edit is held to the same
    // access a Paralegix edit is. One the member may not make is not written,
    // and their copy is put back, so it does not keep showing the edit.
    if (!(await mayWriteMappedItem(existingMapping.entityType, existingMapping.entity.lawFirmId, eventData, userId))) {
      await restoreMemberCopy(existingMapping.entityType, existingMapping.entity, eventData, userId);
      return 'skipped';
    }

    // Every task the real-time sync pushes is known only through this mapping
    // (its event id lives in the per-user map, not the scalar column the task
    // branch above looks up), so a task arrives here, and takes the task
    // field names rather than the matter/client event ones.
    if (existingMapping.entityType === 'task') {
      const taskUpdate = strategy.buildTaskUpdateData(event, eventData.title, 'task');
      applyInboundTaskZone(eventData, taskUpdate, event);
      applyInboundTaskEnd(eventData, taskUpdate, strategy.getEventEnd(event), strategy.getAllDayEnd(event));
      // The task's event id is per user; do not copy this user's id or change
      // key into the task's shared scalar columns.
      delete taskUpdate.googleEventId;
      delete taskUpdate.outlookId;
      delete taskUpdate.outlookChangeKey;
      await tasksRepo.applyInboundUpdate(existingMapping.entity.lawFirmId, existingMapping.entity.id, taskUpdate);
      await crossSync(existingMapping.entity, 'task', userId);
      return 'updated';
    }

    const updateData = strategy.buildMappedEventUpdateData(event, eventData.title, existingMapping.entityType);
    strategy.applyExternalLastModified(updateData, event);
    applyInboundLocation(existingMapping.entityType, eventData, updateData);
    const pushDefaults = eventData.timeZone ? [] : [await memberZone(userId)];
    const zone = inboundZone(eventData.timeZone, strategy.getEventZones(event), updateData.date ?? eventData.date, pushDefaults);
    if (zone !== undefined) updateData.timeZone = zone;
    // A matter or client event is shared by the whole firm, and each member's
    // copy of it has its own provider id (the per-user map). Writing this
    // member's id or change key into the shared scalar columns would hand it to
    // the event's creator, whose push would then address an event in someone
    // else's mailbox.
    delete updateData.googleEventId;
    delete updateData.outlookId;
    delete updateData.outlookChangeKey;
    const endsAt = inboundEndsAt(eventData, updateData, strategy.getEventEnd(event), strategy.getAllDayEnd(event));
    if (endsAt !== undefined) updateData.endsAt = endsAt;
    // Write back under the MAPPING's firm, not the webhook's. A user in multiple
    // firms shares one per-user provider calendar with a single watch channel
    // stamped with whichever firm enabled sync; the mapping (and the entity read
    // above) belongs to the firm that owns the event, which may differ. Using
    // the webhook firm here scoped the UPDATE to the wrong firm and matched 0
    // rows, silently dropping the inbound change. The resolved entity carries
    // the mapping's own lawFirmId, keeping the read and write consistent.
    await applyMappedEventInboundUpdate(existingMapping.entityType, existingMapping.entity.lawFirmId, eventData, updateData);
    if (existingMapping.entityType) await crossSync(existingMapping.entity, existingMapping.entityType, userId);
    return 'updated';
  }

  // A task's zone from an inbound edit. Always sent, because the repository
  // derives `due_date` as the start's day in the zone it is given. A task with
  // a zone keeps it by the rule `inboundZone` describes. One without takes the
  // copy's start zone, since that is the only zone naming a day for the new
  // start, and the repository stores the zone it derives the day in.
  function applyInboundTaskZone(current: any, update: any, event: any) {
    const zones = strategy.getEventZones(event);
    const own = current?.dueDateTimeZone;
    const zone = own ? inboundZone(own, zones, update.dueDate ?? current?.dueDate) : zones.find(isRealZone);
    update.dueDateTimeZone = zone ?? own ?? null;
  }

  // ── inbound upsert priority chain ─────────────────────────────────────────
  // task (by provider id) -> external event (calendar_events) -> mapping
  // (matterEvent / clientEvent / billing) -> new external event. The
  // last-writer-wins stale guard is applied per branch, then the change is
  // cross-synced to the sibling provider.
  async function upsertExternalEvent(event: any, lawFirmId: string, userId: string, mappingCache: any) {
    const eventId = strategy.getEventId(event);
    const eventModified = strategy.getEventModified(event);
    const mapping = mappingCache?.get(eventId) || await calendarSyncRepo.getMappingByExternalId(eventId);
    const version = provider === 'google' ? event.etag : event.changeKey;
    if (version && mapping?.pushedVersion === version) return 'skipped';

    // C4: consult the prefetched mapping cache up front (zero extra round-trips
    // when a delta-page cache is supplied). The calendar_mappings row is the
    // canonical reverse-index written for every outbound-synced entity, so when
    // it resolves to a matterEvent / clientEvent / invoiceBilling the per-event
    // task + external-event probes below CANNOT match (those entities never own a
    // tasks.<provider>EventId nor a calendar_events row). Skip straight to
    // the mapped-entity branch. This is purely an early-dispatch: the task /
    // externalEvent priority is preserved (those mapping types still fall through
    // to branches 1/2), and a cache miss runs the exact original chain. Only
    // relevant when a mappingCache is passed; the single-lookup paths are unchanged.
    const cachedMappingType =
      mappingCache && mappingCache.has(eventId) ? (mappingCache.get(eventId)?.entityType || null) : null;
    const skipTaskAndExternalProbes =
      cachedMappingType === 'matterEvent' ||
      cachedMappingType === 'clientEvent' ||
      cachedMappingType === 'invoiceBilling';

    // 1) existing task by provider id
    const existingTaskId = skipTaskAndExternalProbes
      ? null
      : await strategy.findTaskIdByEventId(lawFirmId, eventId);
    if (existingTaskId) {
      const taskEntity = resolver.resolveEntity('task', { lawFirmId, id: existingTaskId });
      const existingTask = (await taskEntity.getState()) || {};

      if (mappedInboundIsStale(existingTask, eventModified, otherLastModifiedField, mapping?.pushedModifiedAt)) return 'skipped';

      // A mapping says Paralegix pushed this copy, so its description carries
      // the task header even when the member deleted the marker. Without one
      // the task may be an import, whose text is entirely the member's.
      const updateData = strategy.buildTaskUpdateData(event, existingTask.title, mapping ? 'task' : null);
      applyInboundTaskZone(existingTask, updateData, event);
      applyInboundTaskEnd(existingTask, updateData, strategy.getEventEnd(event), strategy.getAllDayEnd(event));
      await tasksRepo.applyInboundUpdate(lawFirmId, existingTaskId, updateData);
      await crossSync(taskEntity, 'task', userId);
      return 'updated';
    }

    // 2) existing external event (calendar_events)
    const existing = skipTaskAndExternalProbes
      ? null
      : await strategy.findExternalByEventId(lawFirmId, eventId, userId);
    const externalId = existing?.id || `${externalIdPrefix}${userId}:${eventId}`;

    if (existing) {
      if (siblingOrParalegixIsNewer(existing, eventModified, otherLastModifiedField)) {
        // Replaying an inbound write that committed before its queue insert
        // must still persist the saved sibling state.
        if (!strategy.isRecurringInstance(event)) {
          await crossSync(resolver.resolveEntity('externalEvent', { lawFirmId, id: externalId }), 'externalEvent', userId);
        }
        return 'skipped';
      }

      const updateData = { ...strategy.buildExternalEventData(event, existing.title), createdBy: userId };
      strategy.applyExternalLastModified(updateData, event);
      await calendarEventsRepo.upsert(lawFirmId, externalId, updateData);
      if (!strategy.isRecurringInstance(event)) {
        await crossSync(resolver.resolveEntity('externalEvent', { lawFirmId, id: externalId }), 'externalEvent', userId);
      }
      return 'updated';
    }

    // 3) matterEvent / clientEvent / billing via calendar_mappings
    const existingMapping = await findExistingCalendarMappingRecord(eventId, mappingCache);
    if (existingMapping) {
      if (existingMapping.entityType === 'invoiceBilling') {
        return strategy.syncBillingEvent(event, existingMapping, lawFirmId, userId);
      }

      // Two DIFFERENT users' independent Google/Outlook connections can both
      // reach this branch for the SAME shared matterEvent/clientEvent at once
      // (a colleague's inbound webhook firing while this one is mid-flight).
      // Nothing upstream serializes them: CALENDAR_WEBHOOK's lock is keyed by
      // the calling user, and Outlook's inbound path carries no lock at all.
      // Without a lock keyed by the ENTITY alone, both would read the same
      // pre-update snapshot above, both would pass their own
      // `siblingOrParalegixIsNewer` check against it, and whichever write
      // lands second in Postgres would win the shared `title`/`notes` fields
      // regardless of which provider's edit is actually newer - a silent
      // lost update. The lock below closes that: only one caller runs the
      // read-decide-write sequence for this entity at a time, and
      // `applyMappedEntityUpdate` re-reads fresh state INSIDE the lock, so a
      // caller that had to wait sees whatever the first caller just
      // committed instead of the snapshot resolved before the lock was
      // acquired. The existing sibling-newer-timestamp guard is unchanged;
      // this only makes sure it sees real state.
      const entityLockKey = `${existingMapping.entityType}:${existingMapping.entity.id}`;
      try {
        return await advisoryLock.withLock(
          'CALENDAR_ENTITY',
          entityLockKey,
          () => applyMappedEntityUpdate(existingMapping, event, eventModified, userId),
          { lockTimeoutMs: 5000, maxHoldMs: 30_000 },
        );
      } catch (err) {
        if (err instanceof advisoryLock.AdvisoryLockTimeoutError) {
          console.warn(`${provider}.service: mapped-entity update for ${entityLockKey} retained for retry while the entity lock is held`);
        }
        throw err;
      }
    }

    // 4) Paralegix-originated marker with a missing mapping: skip to avoid a duplicate.
    if (isParalegixOriginated(strategy.getOriginatedBodyText(event))) {
      console.warn(`${provider}.service: skipping Paralegix-originated event with missing calendarMapping:`, eventId);
      return 'skipped';
    }

    // 5) the same meeting, already imported from the member's other calendar.
    // An invitation sent to both calendars carries one iCalendar UID. Link this
    // copy to that row instead of importing it a second time, and remove the
    // copy Paralegix itself pushed here earlier, which is now a duplicate.
    // The link is written BEFORE that copy is deleted: the copy's delete
    // notification must not find the row still pointing at it, or the delete
    // path would take the row, and the member's real meeting, with it.
    const icalUid = strategy.isRecurringInstance(event) ? null : strategy.getICalUid(event);
    if (icalUid) {
      const twin = await calendarEventsRepo.findImportByICalUid(lawFirmId, userId, strategy.otherProvider, icalUid);
      if (twin) {
        const earlierCopyId = strategy.getProviderIdOnRow(twin);
        await calendarEventsRepo.upsert(lawFirmId, twin.id, strategy.buildTwinLink(event));
        if (earlierCopyId && earlierCopyId !== eventId && (await isOurCopy(earlierCopyId))) {
          try {
            await strategy.deleteOwnEvent(userId, earlierCopyId);
            await calendarSyncRepo.deleteMapping(provider, earlierCopyId);
          } catch (err) {
            console.error(`${provider}.service: removing the duplicate copy ${earlierCopyId} failed:`, err);
          }
        }
        return 'linked';
      }
    }

    // 6) brand-new external calendar event
    const membersRepo = require('../../lawfirms/members/members.repository');
    const membership = await membersRepo.findByUserId(lawFirmId, userId);
    if (!membership) return 'skipped';

    const newData = strategy.buildNewExternalEventData(event, userId);
    if (newData === null) return 'skipped';

    await calendarEventsRepo.upsert(lawFirmId, externalId, newData);
    // An occurrence of a repeating event is not copied to the other calendar:
    // it would land there as dozens of unrelated one-off events rather than a
    // series, and the member usually has the series on both calendars already.
    if (!strategy.isRecurringInstance(event)) {
      await crossSync(resolver.resolveEntity('externalEvent', { lawFirmId, id: externalId }), 'externalEvent', userId);
    }
    return 'created';
  }

  // ── inbound cancellation / deletion reconciliation ────────────────────────
  // Shared by Google's delta `cancelled` branch and Outlook's `deleted`
  // notification. Resolves the same priority order (external event -> task ->
  // mapping) and cross-deletes the sibling provider before removing locally.
  // Returns true if something was deleted (caller increments its counter).
  // `mappingCache` (optional) is the same prefetched Map<externalEventId, mappingRow>
  // that processWatchNotification threads into the upsert path (C3): the mapping
  // branch consults it first and falls back to a single query on a cache miss.
  async function processInboundDelete(eventId: string, lawFirmId: string, userId: string, mappingCache: any) {
    const { getAdapter } = require('./calendarAdapters');

    const existingExternal = await strategy.findExternalByEventId(lawFirmId, eventId, userId);
    if (existingExternal) {
      const siblingId = strategy.getExternalProviderId(existingExternal);
      if (siblingId && await bothAreMembersOwn(existingExternal, siblingId)) {
        // The member removed their own copy of a meeting that is also, as their
        // own copy, on the other calendar. That one is still there, so the row
        // stays, now kept by that calendar alone. (A copy Paralegix made is
        // removed with its original, as before.)
        await calendarEventsRepo.upsert(lawFirmId, existingExternal.id, {
          ...strategy.buildUnlink(),
          provider: strategy.otherProvider,
        });
        return true;
      }
      if (siblingId) {
        await deleteSiblingCopy('externalEvent', { ...existingExternal, lawFirmId }, userId);
      }
      await calendarEventsRepo.delete(lawFirmId, existingExternal.id);
      return true;
    }

    const existingTaskId = await strategy.findTaskIdByEventId(lawFirmId, eventId);
    if (existingTaskId) {
      const taskData = (await tasksRepo.getCalendarState(lawFirmId, existingTaskId)) || {};
      const siblingId = strategy.getTaskProviderId(taskData);
      if (siblingId) {
        await deleteSiblingCopy('task', { ...taskData, id: existingTaskId, lawFirmId }, userId);
      }
      // Deleting the EXTERNAL calendar event must only UNLINK the task's calendar
      // sync, not destroy the Paralegix task. A task is a first-class firm-wide
      // entity; hard-deleting it here meant any one member removing the event from
      // their own calendar silently nuked the shared task for everyone. The
      // sibling event is already removed above, so clear both provider linkages.
      await tasksRepo.setSyncFields(lawFirmId, existingTaskId, { googleEventId: null, outlookId: null });
      return true;
    }

    // Use the *record* variant so the mapping's real `entity_type` is passed
    // explicitly. `findExistingCalendarMapping` returns { entity, data } with no
    // top-level entityType; relying on the resolved entity object's own
    // `entityType` was fragile (and undefined for some mapping types), so an
    // unhandled type silently dropped the cancel. The record variant exposes
    // `entityType` straight from the calendar_mappings row.
    const existingMapping = await findExistingCalendarMappingRecord(eventId, mappingCache);
    if (existingMapping && existingMapping.entityType !== 'externalEvent') {
      // Every Paralegix item a member's calendar holds (a task, a matter or
      // client event, a billing date) is SHARED: other members have their own
      // copies, and the item itself belongs to the firm. Removing the event from
      // one member's calendar therefore unlinks that member's copies (this
      // provider's per-user entry and mapping, plus their copy on the sibling
      // provider) and never cancels or deletes the item for everyone else.
      // Cancelling a hearing is done in Paralegix, where it reaches every
      // member's calendar through the normal outbound sync.
      //
      // The unlink is written under the MAPPING's firm (the resolved entity
      // carries it), not the webhook's: a multi-firm user's calendar can carry
      // an event owned by a firm other than the one that stamped the channel.
      const adapter = getAdapter(existingMapping.entityType);
      const data = { ...existingMapping.data, id: existingMapping.entity.id, lawFirmId: existingMapping.entity.lawFirmId };
      const mappedUserId = existingMapping.mappedUserId || userId;
      const itemKey = existingMapping.itemKey || (await adapter.toCalendarItems(data))[0]?.key;
      if (itemKey && strategy.getSiblingAdapterEventId(adapter, data, [{ key: itemKey }], mappedUserId)) {
        await deleteSiblingCopy(existingMapping.entityType, data, mappedUserId);
      }
      if (itemKey) {
        await existingMapping.entity.applyDescriptor(strategy.buildDeleteWriteback(adapter, itemKey, mappedUserId));
      }
      await calendarSyncRepo.deleteMapping(provider, eventId);
      return true;
    }
    return false;
  }

  // ── a repeating event's parent ────────────────────────────────────────────
  // Once a series is read as its occurrences, a parent imported earlier as a
  // single event is a duplicate of them and goes. Only that: when the series
  // id is a copy Paralegix pushed (the member made a Paralegix item repeat in
  // their calendar), the delete path would unlink the item and delete its copy
  // on the other calendar, and the next edit would push a duplicate.
  async function removeImportedSeriesParent(seriesId: string, lawFirmId: string, userId: string, mappingCache: any) {
    if (mappingCache?.get(seriesId) || await calendarSyncRepo.getMappingByExternalId(seriesId)) return false;
    if (!(await strategy.findExternalByEventId(lawFirmId, seriesId, userId))) return false;
    return processInboundDelete(seriesId, lawFirmId, userId, mappingCache);
  }

  // ── full-poll deletion reconciliation ─────────────────────────────────────
  // A full list is the only read that shows what is NOT on the calendar any
  // more. Every event this member imported from this provider that starts
  // inside the listed window and was not in the listing is gone (deleted, or
  // moved to another calendar) and goes through the same delete path a
  // notification would have used, so its copy on the sibling provider goes too.
  // The caller passes a window strictly inside the one it listed, and calls
  // this only after a complete listing: a truncated one would read as deletes.
  // A whole-calendar window (no series scope) also reconciles the copies of
  // Paralegix items, below.
  async function removeUnlisted(
    lawFirmId: string, userId: string, listedIds: Set<string>,
    scope: { from?: Date | null; to?: Date | null; idPrefix?: string | null; seriesEventId?: string | null },
  ) {
    const known = await calendarEventsRepo.listImportedProviderIds(lawFirmId, userId, provider, scope);
    let removed = 0;
    for (const id of known) {
      if (listedIds.has(id)) continue;
      try {
        if (await processInboundDelete(id, lawFirmId, userId, null)) removed++;
      } catch (err) {
        console.error(`${provider}.service: removing unlisted event ${id} failed:`, err);
      }
    }
    if (scope.from && scope.to && !scope.idPrefix && !scope.seriesEventId) {
      removed += await unlinkUnlistedCopies(lawFirmId, userId, listedIds, scope.from, scope.to);
    }
    return removed;
  }

  // The copies of Paralegix items on this member's calendar that the listing
  // did not have. A delete notification lost in a sync gap (a 410 on Google)
  // otherwise leaves the item linked to an event that no longer exists. A copy
  // counts only when its item starts inside the window, and is unlinked only
  // once the provider confirms it is gone: the listing covers one calendar,
  // and a copy may be on another (an earlier calendar target).
  const RECONCILED_TYPES = new Set(['task', 'matterEvent', 'clientEvent', 'invoiceBilling']);
  const MAPPING_PAGE = 100;

  async function itemStartsInside(mapping: any, from: Date, to: Date) {
    const entity = resolver.resolveFromMapping(mapping);
    const data = entity && await entity.getState();
    if (!data) return false;
    const { getAdapter } = require('./calendarAdapters');
    const items = await getAdapter(mapping.entityType).toCalendarItems({ ...data, lawFirmId: data.lawFirmId || mapping.lawFirmId });
    const item = items.find((candidate: any) => candidate.key === mapping.itemKey) || (mapping.itemKey ? null : items[0]);
    const start = toInstant(item?.dateTime);
    return Boolean(start && start >= from && start < to);
  }

  async function isGoneAtProvider(userId: string, mapping: any) {
    const { status, event } = await strategy.fetchEvent(userId, mapping.externalEventId, mapping.calendarId);
    if (status === 404 || status === 410) return true;
    return Boolean(event && strategy.isGoneForUser(event));
  }

  async function unlinkUnlistedCopies(lawFirmId: string, userId: string, listedIds: Set<string>, from: Date, to: Date) {
    let removed = 0;
    let afterId = '';
    for (;;) {
      const page = await calendarSyncRepo.listMappingsForUser(provider, userId, afterId);
      for (const mapping of page) {
        if (listedIds.has(mapping.externalEventId) || !RECONCILED_TYPES.has(mapping.entityType)) continue;
        try {
          if (!(await itemStartsInside(mapping, from, to))) continue;
          if (!(await isGoneAtProvider(userId, mapping))) continue;
          const cache = new Map([[mapping.externalEventId, mapping]]);
          if (await processInboundDelete(mapping.externalEventId, lawFirmId, userId, cache)) removed++;
        } catch (err) {
          console.error(`${provider}.service: reconciling unlisted copy ${mapping.externalEventId} failed:`, err);
        }
      }
      if (page.length < MAPPING_PAGE) break;
      afterId = page[page.length - 1].externalEventId;
    }
    return removed;
  }

  return {
    stampOutboundPush,
    crossSync,
    upsertExternalEvent,
    processInboundDelete,
    removeImportedSeriesParent,
    removeUnlisted,
    // exposed so the services can keep their old internal helpers callable if needed
    findExistingCalendarMapping,
    findExistingCalendarMappingRecord,
    applyMappedEventInboundUpdate,
  };
}
