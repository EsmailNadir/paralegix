const crypto = require('crypto');
const calendarTokens = require('../shared/calendarTokens');
const calendarSyncRepo = require('../shared/calendarSync.repository');
const advisoryLock = require('../../../shared/database/advisoryLock');
const { AdvisoryLockTimeoutError } = advisoryLock;
const resolver = require('../shared/calendarEntityResolver');
const tasksRepo = require('../../tasks/tasks.repository');
const { resolveSyncableFirmIds, matterWallFor } = require('../shared/syncFirmGuard');
const { getUserDataAndSettings, makeGoogleApiCall, refreshGrant } = require('../shared/calendarHelpers');
const { AppError, ValidationError } = require('../../../shared/errors/AppError');
const { normalizeTimeZone, zonedWallClock, zonedWallClockWithOffset, toInstant } = require('../../../shared/utils/time');
const {
  isExistingItemEligible, timedEnd, allDaySpan, fullPollWindow, seriesWindow, MAX_SERIES_PAGES,
} = require('../shared/calendarTime');
import { withCalendarSyncLock } from '../shared/calendarSyncLock';
import { isCalendarRecipient } from '../shared/calendarRecipients';
import { connectionReport, connectionState } from '../shared/calendarGrant';

// ── Helpers ──────────────────────────────────────────────────

/**
 * Get or create the Paralegix calendar in Google.
 * Throws with a .status property on auth failure.
 */

function resolvePreferredTimeZone(timeZone: any) {
  const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!tz) return null;
  return normalizeTimeZone(tz);
}

function resolveEventTimeZone(itemTimeZone: any, requestTimeZone: any) {
  const itemTz = resolvePreferredTimeZone(itemTimeZone);
  const requestTz = resolvePreferredTimeZone(requestTimeZone);

  return itemTz || requestTz || 'UTC';
}

// Timed start/end body. The end is the item's own when it has one (a cross-
// provider sync of an external event keeps its true duration), else the
// default block. Each time carries its offset as well as the zone label: a bare
// wall clock in the hour that repeats when clocks go back names two instants,
// and Google resolves it to the first. The zone label is still sent, because it
// is what a recurring event's later occurrences follow.
function buildTimedEventRange(startDate: any, timeZone: any, endDate?: any) {
  const end = timedEnd(startDate, endDate);
  return {
    start: { dateTime: zonedWallClockWithOffset(startDate, timeZone), timeZone },
    end: { dateTime: zonedWallClockWithOffset(end, timeZone), timeZone },
  };
}

// All-day start/end body. Google's end.date is EXCLUSIVE (the day after the
// last day); `allDaySpan` works both days out.
function buildAllDayEventRange(startDate: any, endDate: any) {
  const { startDay, endDay } = allDaySpan(startDate, endDate);
  return {
    start: { date: startDay },
    end: { date: endDay },
  };
}

async function getOrCreateParalegixCalendar(userId: string, userData: any, timeZone: any) {
  const targetTimeZone = resolvePreferredTimeZone(timeZone);
  const settings = await calendarTokens.getSettings(userId);
  const storedId = settings?.paralegixGoogleCalendarId;
  if (storedId) {
    const response = await makeGoogleApiCall(userId, userData,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(storedId)}`, { method: 'GET' });
    if (response.ok) return response.json();
    if (response.status !== 404 && response.status !== 410) throw new AppError(`Google Calendar API error: ${response.status}`, response.status);
  }

  // Create new Paralegix calendar
  const createResponse = await makeGoogleApiCall(userId, userData, 'https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    body: JSON.stringify({
      summary: 'Paralegix',
      description: 'Paralegix tasks and events',
      timeZone: targetTimeZone || 'UTC',
    }),
  });

  if (!createResponse.ok) {
    throw new AppError(`Failed to create Paralegix calendar: ${createResponse.status}`, createResponse.status);
  }

  const newCalendar = await createResponse.json();

  await calendarTokens.saveSettings(userId, {
    googleCalendarId: newCalendar.id,
    paralegixGoogleCalendarId: newCalendar.id,
  });

  return newCalendar;
}

/**
 * Resolve which Google Calendar ID to use based on user settings.
 */
async function resolveCalendarId(userId: string, userData: any, settings: any, timeZone?: any) {
  const calendarTarget = settings?.googleCalendarTarget || 'default';
  if (calendarTarget === 'default') {
    return 'primary';
  }

  // Use the stored Paralegix calendar id when known. Avoids fetching the user's
  // entire calendar list on every sync. Falls back to discover/create when unset
  // (which persists the id, so subsequent syncs hit this fast path).
  if (settings?.paralegixGoogleCalendarId) {
    return settings.paralegixGoogleCalendarId;
  }

  const paralegixCalendar = await getOrCreateParalegixCalendar(userId, userData, timeZone);
  return paralegixCalendar.id;
}

// ── Generic Entity Sync (adapter-driven) ────────────────────
// Instants are read with `toInstant` from shared/utils/time.

function getStoredGoogleKeys(adapter: any, entityData: any, userId: string) {
  if (typeof adapter.listGoogleSyncKeys === 'function') {
    return adapter.listGoogleSyncKeys(entityData, userId) || [];
  }
  return [];
}

/**
 * The Google event this (user, entity, item) already has, if any.
 *
 * Two sources, in this order. The writeback field on the in-memory entity is the
 * fast path, and `calendar_mappings` is the authoritative one: `entityData` was
 * loaded before this sync began, so a concurrent save and an outbox replay both
 * see a stale snapshot there, while the mapping row is written the moment a
 * create succeeds. Consulting only the first is what let a replay POST a second
 * event for an entity that already had one.
 *
 * Correct against concurrency only under the calendar sync lock (see
 * calendar.events.ts); on its own it is a narrower check-then-act.
 */
async function resolveExistingGoogleEventId({ adapter, entityData, userId, itemKey, entityId }: any) {
  const fromEntity = adapter.getGoogleEventId(entityData, itemKey, userId);
  if (fromEntity) return fromEntity;
  const mapped = await calendarSyncRepo.findMappingForEntityItem({
    provider: 'google', userId, entityType: adapter.entityType,
    entityId: entityId ?? entityData?.id, itemKey,
  }).catch(() => null);
  return mapped?.externalEventId || null;
}

/**
 * Record a freshly created Google event: mapping row first, entity writeback
 * second.
 *
 * The order is the fix, not a preference. Written the other way round, a failure
 * between the two (or a unique-index refusal on the mapping) left `calendar_sync`
 * naming an event that `calendar_mappings` did not, and every later update and
 * delete follows the writeback, so the mapped event became unaddressable and
 * survived on the user's calendar forever. Writing the mapping first means a
 * failure leaves the durable record ahead of the entity, which the create-side
 * lookup above then reconciles on the next pass instead of duplicating.
 */
async function saveGoogleMappingThenWriteback({
  adapter, entity, entityData, userId, calendarId, mappingRef, itemKey, externalEventId, pushedVersion, pushedModifiedAt,
}: any) {
  await calendarSyncRepo.saveMapping({
    provider: 'google',
    externalEventId,
    calendarId,
    userId,
    lawFirmId: entityData.lawFirmId,
    entityType: adapter.entityType,
    entityId: mappingRef.entityId,
    scopeId: mappingRef.scopeId,
    itemKey,
    pushedVersion, pushedModifiedAt,
  });
  await entity.applyDescriptor(adapter.buildGoogleWriteback(itemKey, externalEventId, userId));
}

/**
 * POST a fresh Google event for one calendar item and record it (mapping then
 * writeback). Shared by the "no mapping yet" and "mapping pointed at a
 * provider-deleted event" paths in `updateEventsFromEntity`, and by
 * `createEventsFromEntity`, so every create path behaves identically.
 *
 * C03 (calendar replay matrix): the provider create can succeed while
 * recording it locally fails - a dropped connection, a statement timeout, a
 * unique-index refusal on the mapping. Neither `calendar_mappings` nor the
 * entity writeback would then name the new event, so the NEXT pass over this
 * same item (an outbox replay, or simply the next save) has no way to find it
 * and would POST a second one, leaving two live events for one Paralegix item.
 * Google's create endpoint offers no client-supplied idempotency key here (no
 * `id` field is sent on insert), so there is no "look it up and reconcile"
 * path available - the only recovery is a compensating delete: undo the
 * provider-side create so the next attempt starts clean. If that compensating
 * delete ALSO fails, an unmapped orphan can still survive on the user's real
 * calendar; that residual gap is logged loudly rather than hidden, since two
 * failures in the same request is already a degraded case with no atomic fix
 * across systems that do not share a transaction.
 */
async function createGoogleEventForItem({
  adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, eventData, settings, _retriedCalendar,
}: any) {
  const response = await makeGoogleApiCall(userId, userData, `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=none`, {
    method: 'POST',
    body: JSON.stringify(eventData),
  });

  if (!response.ok) {
    // A 404/410 here means the CALENDAR itself is gone, not one event within
    // it - a create has no existing event id that could be "not found" the way
    // the update/delete paths mean it. This can only happen to the cached
    // Paralegix calendar id: 'primary' is the Google account's own calendar and
    // cannot be deleted independently of the account. Without this, a deleted
    // Paralegix calendar left `paralegixGoogleCalendarId` pointing at a dead id
    // forever, so every future sync for this user repeated the same failing
    // POST with nothing to recover it - unlike a lost EVENT, which the
    // update-path 404 branch already self-heals.
    if (!_retriedCalendar && (response.status === 404 || response.status === 410)
        && settings?.googleCalendarTarget === 'paralegix'
        && settings?.paralegixGoogleCalendarId === calendarId) {
      console.warn(`calendar.events: Google calendar ${calendarId} is gone (status ${response.status}); recreating the Paralegix calendar`);
      await calendarTokens.saveSettings(userId, { paralegixGoogleCalendarId: null }).catch(() => {});
      try {
        const freshCalendar = await getOrCreateParalegixCalendar(userId, userData, null);
        return await createGoogleEventForItem({
          adapter, entity, entityData, userId, userData, mappingRef, item, eventData,
          calendarId: freshCalendar.id,
          settings: { ...settings, paralegixGoogleCalendarId: freshCalendar.id },
          _retriedCalendar: true,
        });
      } catch (recreateErr) {
        console.error(`calendar.events: failed to recreate the Paralegix calendar for ${adapter.entityType}/${item.key}`, recreateErr);
      }
    }
    throw new AppError('Calendar provider rejected the event create', 503);
  }

  const event = await response.json();
  try {
    await saveGoogleMappingThenWriteback({
      adapter, entity, entityData, userId, calendarId, mappingRef,
      itemKey: item.key, externalEventId: event.id,
      pushedVersion: event.etag, pushedModifiedAt: event.updated,
    });
  } catch (recordErr) {
    console.error(`calendar.events: Google event ${event.id} for ${adapter.entityType}/${item.key} was created but not recorded locally; attempting a compensating delete`, recordErr);
    const cleanedUp = await makeGoogleApiCall(
      userId, userData,
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${event.id}`,
      { method: 'DELETE' },
    ).then((r: any) => r.ok || r.status === 404 || r.status === 410).catch(() => false);
    if (!cleanedUp) {
      console.error(`calendar.events: compensating delete FAILED for orphaned Google event ${event.id} (${adapter.entityType}/${item.key}); it will remain on the user's calendar unmapped`);
    }
    throw recordErr;
  }
  return event;
}

/**
 * Create the Google event for one calendar item unless this user already has
 * one, recording it the way every create does (mapping row, then per-user
 * writeback).
 *
 * A create is not necessarily the first one. `eventOutbox.dispatchRow`
 * re-invokes every listener with the SAME persisted payload, whose
 * `calendarSync` snapshot predates the first pass, and a "sync existing" press
 * can land on an item the real-time sync already pushed. The mapping row is what
 * tells those apart from a genuinely new item: it is keyed by (provider, user,
 * entity, item) and written the moment a create succeeds.
 *
 * Returns `{ created, eventId }`, or null when nothing was pushed (no usable
 * start, or Google refused the create). Throws when recording fails or the
 * account needs reconnecting, so the caller decides how to report it.
 */
async function createGoogleEventIfMissing({
  adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, requestTimeZone, settings,
}: any): Promise<{ created: boolean; eventId: string } | null> {
  const startDate = toInstant(item.dateTime);
  if (!startDate || Number.isNaN(startDate.getTime())) return null;

  const alreadyCreated = await resolveExistingGoogleEventId({
    adapter, entityData, userId, itemKey: item.key, entityId: mappingRef.entityId,
  });
  if (alreadyCreated) {
    // Repair the entity's fast path when only the mapping knew about the
    // event, so the two records agree and the next update PATCHes it.
    if (!adapter.getGoogleEventId(entityData, item.key, userId)) {
      await entity.applyDescriptor(adapter.buildGoogleWriteback(item.key, alreadyCreated, userId));
    }
    return { created: false, eventId: alreadyCreated };
  }

  const endDate = item.end ? toInstant(item.end) : null;
  const eventTimeZone = resolveEventTimeZone(item.timeZone, requestTimeZone);
  const eventData: any = {
    summary: item.summary,
    description: item.description,
    ...(item.allDay ? buildAllDayEventRange(startDate, endDate) : buildTimedEventRange(startDate, eventTimeZone, endDate)),
  };
  if (item.location) eventData.location = item.location;
  if (item.isPrivate && item.sourceProvider !== 'google') eventData.visibility = 'private';

  const event = await createGoogleEventForItem({
    adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, eventData, settings,
  });
  return event ? { created: true, eventId: event.id } : null;
}

/**
 * A PATCH body's `start`/`end` with the other form cleared.
 *
 * Google merges a PATCHed `start` into the stored one rather than replacing it,
 * so turning an all-day event into a timed one (or back) left both `date` and
 * `dateTime` set unless the old field is sent as an explicit null.
 */
function replacingEventRange(range: any) {
  const clear = (part: any) => (part.date
    ? { ...part, dateTime: null, timeZone: null }
    : { date: null, ...part });
  return { start: clear(range.start), end: clear(range.end) };
}

/**
 * Every Google copy this member has of an entity, by item key: the payload's
 * per-user map first, then `calendar_mappings`, which also says which calendar
 * holds each copy. The payload is a snapshot from before the sync that wrote
 * the map (a task payload carries no map at all), so a delete or a stale-key
 * pass that read only the map left the event on the member's calendar.
 */
async function storedGoogleCopies(adapter: any, entityData: any, userId: string) {
  const copies = new Map<string, { eventId: string; calendarId: string | null }>();
  for (const key of getStoredGoogleKeys(adapter, entityData, userId)) {
    const eventId = adapter.getGoogleEventId(entityData, key, userId);
    if (eventId) copies.set(key, { eventId, calendarId: null });
  }
  const { entityId } = resolver.mappingRefForEntity(adapter.entityType, entityData);
  const mapped = await calendarSyncRepo.listMappingsForEntityUser({
    provider: 'google', userId, entityType: adapter.entityType, entityId,
  });
  for (const mapping of mapped) {
    if (!mapping?.itemKey) continue;
    const known = copies.get(mapping.itemKey);
    if (!known) copies.set(mapping.itemKey, { eventId: mapping.externalEventId, calendarId: mapping.calendarId });
    else if (known.eventId === mapping.externalEventId) known.calendarId = mapping.calendarId;
  }
  return copies;
}

async function deleteGoogleEventByKey({ adapter, entityData, userId, userData, calendarId, entity, key, copy }: any) {
  const eventId = copy?.eventId || adapter.getGoogleEventId(entityData, key, userId);
  if (!eventId) return false;
  // A Google event id belongs to the calendar that holds it, which is the one
  // the mapping recorded, not necessarily the one the member targets now.
  const holder = copy?.calendarId || calendarId;

  const response = await makeGoogleApiCall(
    userId,
    userData,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(holder)}/events/${eventId}`,
    { method: 'DELETE' },
  );

  // A 404/410 on a delete means Google already does not have this event -
  // deleted directly on the user's real calendar, or by a delete replay
  // whose earlier pass already succeeded here. That is the same end state the
  // caller asked for, so treat it as a converged delete rather than a failure:
  // clear the writeback and drop the mapping the same as a real 2xx would.
  // Any OTHER failure (5xx, auth, rate limit) returns false and touches
  // nothing, since we do not actually know the provider's state then.
  const gone = response.status === 404 || response.status === 410;
  if (!response.ok && !gone) {
    throw new AppError('Calendar provider rejected the event delete', 503);
  }
  if (gone) {
    console.warn(`calendar.events: Google event ${eventId} for ${adapter.entityType}/${key} was already gone (status ${response.status}); converging local state`);
  }

  if (typeof adapter.buildGoogleDeleteWriteback === 'function') {
    await entity.applyDescriptor(adapter.buildGoogleDeleteWriteback(key, userId));
  }
  await calendarSyncRepo.deleteMapping('google', eventId).catch(() => {});
  return true;
}

// ── Shared sync engine (inbound upsert, cross-sync, outbound-push stamp) ─────
// The inbound priority chain, cross-sync to Outlook, loop guards, and the
// watch-channel outbound-push stamp live ONCE in shared/providerSyncEngine.js,
// parameterized by googleStrategy. These thin wrappers preserve the historical
// internal names used throughout this file.

const { createEngine } = require('../shared/providerSyncEngine');
const googleStrategy = require('./googleStrategy');
const engine = createEngine(googleStrategy);

const stampOutboundPushForGoogle = (userId: string) => engine.stampOutboundPush(userId);
const crossSyncToOutlook = (entity: any, entityType: any, userId: string) => engine.crossSync(entity, entityType, userId);

/**
 * Create Google Calendar events for any entity via its adapter.
 * A single entity can produce multiple calendar items (e.g. a matter with 4 dates).
 */
export async function createEventsFromEntity(adapter: any, entityData: any, userId: string, timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.googleAccessToken) return null;
    if (!settings?.allowParalegixToGoogleSync) return null;
    const requestTimeZone = resolvePreferredTimeZone(timeZone);

    const items = await adapter.toCalendarItems(entityData);
    if (items.length === 0) return null;

    const calendarTimeZone = requestTimeZone || resolvePreferredTimeZone(items[0]?.timeZone);
    const calendarId = await resolveCalendarId(userId, userData, settings, calendarTimeZone);
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const mappingRef = resolver.mappingRefForEntity(adapter.entityType, entityData);
    const results = [];

    for (const item of items) {
      try {
        const outcome = await createGoogleEventIfMissing({
          adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, requestTimeZone, settings,
        });
        if (outcome?.created) {
          results.push({ key: item.key, googleEventId: outcome.eventId });
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error creating Google event for ${adapter.entityType}/${item.key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForGoogle(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in createEventsFromEntity (${adapter.entityType}, Google):`, error);
    return null;
  }
}

/**
 * Update Google Calendar events for any entity via its adapter.
 * Creates new events for items that don't have a googleEventId yet,
 * updates existing ones, and deletes events for date fields that were cleared.
 */
export async function updateEventsFromEntity(adapter: any, entityData: any, userId: string, timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.googleAccessToken) return null;
    if (!settings?.allowParalegixToGoogleSync) return null;
    const requestTimeZone = resolvePreferredTimeZone(timeZone);

    const items = await adapter.toCalendarItems(entityData);
    const calendarTimeZone = requestTimeZone || resolvePreferredTimeZone(items[0]?.timeZone);
    const calendarId = await resolveCalendarId(userId, userData, settings, calendarTimeZone);
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const mappingRef = resolver.mappingRefForEntity(adapter.entityType, entityData);
    const results = [];
    const currentKeys = new Set(items.map((item: any) => item.key));

    const copies = await storedGoogleCopies(adapter, entityData, userId);
    for (const [storedKey, copy] of copies) {
      if (currentKeys.has(storedKey)) continue;
      try {
        const deleted = await deleteGoogleEventByKey({
          adapter,
          entityData,
          userId,
          userData,
          calendarId,
          entity,
          key: storedKey,
          copy,
        });
        if (deleted) {
          results.push({ key: storedKey, action: 'deleted' });
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error deleting stale Google event for ${adapter.entityType}/${storedKey}:`, itemErr);
      }
    }

    // Update or create events for current items
    for (const item of items) {
      try {
        const startDate = toInstant(item.dateTime);
        if (!startDate || Number.isNaN(startDate.getTime())) continue;
        const endDate = item.end ? toInstant(item.end) : null;
        const eventTimeZone = resolveEventTimeZone(item.timeZone, requestTimeZone);

        // Entity writeback first, mapping row second; see
        // `resolveExistingGoogleEventId` for why the stale writeback alone is not
        // enough to decide create-versus-PATCH.
        const existingEventId = await resolveExistingGoogleEventId({
          adapter, entityData, userId, itemKey: item.key, entityId: mappingRef.entityId,
        });
        const eventData: any = {
          summary: item.summary,
          description: item.description,
          ...(item.allDay ? buildAllDayEventRange(startDate, endDate) : buildTimedEventRange(startDate, eventTimeZone, endDate)),
        };
        // An item that keeps a provider-owned location (a task: see its
        // adapter) sends none on update rather than blanking it.
        if (item.location) eventData.location = item.location;
        else if (existingEventId && !item.keepProviderLocation) eventData.location = '';
        if (item.isPrivate && item.sourceProvider !== 'google') eventData.visibility = 'private';

        if (existingEventId) {
          // Update existing event
          const response = await makeGoogleApiCall(
            userId, userData,
            `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${existingEventId}?sendUpdates=${entityData.confirmNotifyAttendees === true ? 'all' : 'none'}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ ...eventData, ...replacingEventRange(eventData) }),
            }
          );

          if (response.ok) {
            const pushed = await response.json();
            // A source meeting stays the member's own event after an edit.
            // Only copies created by Paralegix carry ownership mappings.
            if (adapter.entityType !== 'externalEvent' || await calendarSyncRepo.getMappingByExternalId(existingEventId)) {
              await calendarSyncRepo.saveMapping({
                provider: 'google', externalEventId: existingEventId, calendarId, userId,
                lawFirmId: entityData.lawFirmId, entityType: adapter.entityType,
                entityId: mappingRef.entityId, scopeId: mappingRef.scopeId, itemKey: item.key,
                pushedVersion: pushed.etag, pushedModifiedAt: pushed.updated,
              });
            }
            await entity.applyDescriptor(adapter.buildGoogleUpdateWriteback(item.key, userId));
            results.push({ key: item.key, action: 'updated', googleEventId: existingEventId });
          } else if (response.status === 404 || response.status === 410) {
            // The mapping (or the stale writeback fallback) disagreed with the
            // provider: what this process still calls "existing" is gone at
            // Google, whether deleted directly on the user's calendar or left
            // behind by a delete whose deleteMapping write failed after the
            // provider side already succeeded. Repeating the PATCH can never
            // succeed against a gone id, so drop the stale mapping and create a
            // replacement instead of failing this item forever with no recovery.
            console.warn(`calendar.events: Google event ${existingEventId} for ${adapter.entityType}/${item.key} is gone (status ${response.status}); recreating`);
            await calendarSyncRepo.deleteMapping('google', existingEventId).catch(() => {});
            const event = await createGoogleEventForItem({
              adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, eventData, settings,
            });
            if (event) {
              results.push({ key: item.key, action: 'recreated', googleEventId: event.id });
            }
          } else {
            console.error(`Failed to update Google event for ${adapter.entityType}/${item.key}:`, response.status);
            throw new AppError('Calendar provider rejected the event update', 503);
          }
        } else {
          // Create new event (date field was just set)
          const event = await createGoogleEventForItem({
            adapter, entity, entityData, userId, userData, calendarId, mappingRef, item, eventData, settings,
          });
          if (event) {
            results.push({ key: item.key, action: 'created', googleEventId: event.id });
          }
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error updating Google event for ${adapter.entityType}/${item.key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForGoogle(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in updateEventsFromEntity (${adapter.entityType}, Google):`, error);
    return null;
  }
}

/**
 * Delete all Google Calendar events for an entity via its adapter.
 */
export async function deleteEventsFromEntity(adapter: any, entityData: any, userId: string, _timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.googleAccessToken) return null;

    const calendarId = await resolveCalendarId(userId, userData, settings);

    const items = await adapter.toCalendarItems(entityData);
    const keys = new Set(items.map((item: any) => item.key));
    const copies = await storedGoogleCopies(adapter, entityData, userId);
    copies.forEach((_copy, key) => keys.add(key));
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const results = [];

    for (const key of keys) {
      try {
        const deleted = await deleteGoogleEventByKey({
          adapter,
          entityData,
          userId,
          userData,
          calendarId,
          entity,
          key,
          copy: copies.get(key as string),
        });
        if (deleted) results.push({ key, action: 'deleted' });
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error deleting Google event for ${adapter.entityType}/${key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForGoogle(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in deleteEventsFromEntity (${adapter.entityType}, Google):`, error);
    return null;
  }
}

const { getAdapter } = require('../shared/calendarAdapters');

// ── Route-Level Operations (called by google.routes.js) ─────

/**
 * Ask Google which scopes an access token carries, in the documented form: a
 * POST to tokeninfo with the token in the form body, which keeps it out of the
 * URL and so out of request logs. Returns null when Google does not accept the
 * token or cannot be reached; the caller then falls back to a refresh.
 */
async function fetchTokenScope(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }),
    });
    if (!response.ok) return null;
    const info = await response.json().catch(() => null);
    return typeof info?.scope === 'string' && info.scope.trim() ? info.scope.trim() : null;
  } catch (err: any) {
    console.warn('google.service: tokeninfo request failed:', err?.cause?.code ?? err?.code ?? 'unknown');
    return null;
  }
}

/**
 * Report the caller's Google calendar connection from the stored grant.
 *
 * Reads only the row, except for a legacy row stored before scopes were
 * recorded: that one is resolved once through tokeninfo (or, when its access
 * token has expired, through a refresh, whose response carries the scope), and
 * the answer is stored so later reads need no provider call.
 */
export async function checkAuth(userId: string) {
  let row = await calendarTokens.getConnectionRow(userId, 'google');
  if (!row) return { error: 'No Google token available', status: 400 };

  if (connectionState('google', row) === 'unverified') {
    const scope = row.access_token ? await fetchTokenScope(row.access_token) : null;
    if (scope) {
      try {
        await calendarTokens.saveAccessToken(userId, 'google', row.access_token, scope);
      } catch (err: any) {
        // The row stays unverified and the next check retries. Only the code is
        // logged: a database error's message carries the access token.
        console.error('google.service: storing the tokeninfo scope failed:', err?.cause?.code ?? err?.code ?? 'unknown');
      }
    } else {
      await refreshGrant('google', userId, row.refresh_token);
    }
    row = await calendarTokens.getConnectionRow(userId, 'google');
  }

  return connectionReport(connectionState('google', row), row?.meta?.accountEmail ?? null);
}

/**
 * Initialize Paralegix calendar for Google.
 */
export async function initParalegixCalendar(userId: string, timeZone: any) {
  const userData = await calendarTokens.loadUserData(userId);
  if (!userData) return { error: 'User not found', status: 404 };
  if (!userData.googleAccessToken) return { error: 'No Google token available. Please reconnect Google.', status: 401 };

  const paralegixCalendar = await getOrCreateParalegixCalendar(userId, userData, timeZone);

  return {
    success: true,
    message: 'Paralegix calendar initialized successfully',
    calendar: {
      id: paralegixCalendar.id,
      name: paralegixCalendar.summary || paralegixCalendar.id,
      color: paralegixCalendar.backgroundColor || '#000000',
    },
  };
}

/**
 * Get user's Google Calendars.
 */
export async function getCalendars(userId: string) {
  const userData = await calendarTokens.loadUserData(userId);
  if (!userData) return { error: 'User not found', status: 404 };
  if (userData.googleGrantLost) {
    return { error: 'Token expired. Please reconnect your Google account.', status: 401, requiresReAuth: true };
  }
  if (!userData.googleAccessToken) return { error: 'No Google token available', status: 400 };

  let response;
  try {
    response = await makeGoogleApiCall(userId, userData, 'https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      method: 'GET',
    });
  } catch (err: any) {
    if (err.code === 'NO_REFRESH_TOKEN') {
      return { error: 'Token expired. Please reconnect your Google account.', status: 401, requiresReAuth: true };
    }
    throw err;
  }

  if (!response.ok) return { error: 'Failed to fetch calendars', status: 500 };

  const data = await response.json();
  const calendars = (data.items || []).map((cal: any) => ({
    id: cal.id,
    name: cal.summary || cal.id,
    isDefault: cal.primary || false,
    color: cal.backgroundColor || '#000000',
    canEdit: cal.accessRole === 'owner' || cal.accessRole === 'writer',
  }));

  return { calendars };
}

// ── Shared inbound-sync helpers (delegated to providerSyncEngine) ───────────
// The inbound upsert priority chain, the matterEvent/clientEvent mapping
// resolution, and the cancelled/deleted reconciliation now live in
// shared/providerSyncEngine.js (parameterized by googleStrategy). These thin
// wrappers keep the historical internal names + signatures used below.

/**
 * Inbound upsert for one Google event. `mappingCache` (optional) is a prefetched
 * Map<externalEventId, mappingRow> so a delta page resolves all mappings in one
 * query (C3); omit it for single-event callers.
 */
function upsertExternalEventFromGoogleEvent(event: any, lawFirmId: string, userId: string, mappingCache?: any) {
  return engine.upsertExternalEvent(event, lawFirmId, userId, mappingCache);
}

// Replay a single inbound delete for a specific provider event id. Used by the
// webhook retry sweep to reconcile a deletion whose delta processing failed
// transiently (syncFromGoogle can't recover it — see processWatchNotification).
// Idempotent: if the event is already gone locally, processInboundDelete resolves
// nothing and no-ops.
export function reprocessInboundDelete({ userId, lawFirmId, eventId }: any) {
  return engine.processInboundDelete(eventId, lawFirmId, userId);
}

/**
 * Sync events from Google Calendar into Paralegix tasks.
 */
export async function syncFromGoogle({ userId, lawFirmId }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) {
    throw new AppError('No Google token available. Please reconnect Google.', 401, 'UNAUTHORIZED');
  }
  if (!settings?.allowGoogleToParalegixSync) {
    throw new ValidationError('Google to Paralegix sync not enabled');
  }

  const calendarId = await resolveCalendarId(userId, userData, settings);

  const pollWindow = fullPollWindow();
  const oneYearAgo = pollWindow.from;
  const oneYearFromNow = pollWindow.to;

  // Page through the full window (maxResults caps each page at 100). Without this
  // a firm with >100 events in the window silently drops the overflow. Mirrors the
  // nextPageToken loop in processWatchNotification's delta read. The page cap is a
  // safety stop against an unbounded loop (100 pages * 100 = 10k events).
  const MAX_SYNC_PAGES = 100;
  const events = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const params = new URLSearchParams({
      timeMin: oneYearAgo.toISOString(),
      timeMax: oneYearFromNow.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await makeGoogleApiCall(
      userId, userData,
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new AppError('Google token expired or invalid', 401, 'UNAUTHORIZED');
      }
      throw new AppError('Failed to fetch Google events', 500);
    }

    const data = await response.json();
    if (data.items) events.push(...data.items);
    pageToken = data.nextPageToken || null;
    pageCount++;
  } while (pageToken && pageCount < MAX_SYNC_PAGES);

  if (pageToken) {
    throw new AppError('Google calendar recovery exceeded its page budget. Retry before advancing the cursor.', 503);
  }

  let createdCount = 0;
  let updatedCount = 0;
  const listedIds = new Set<string>();

  for (const event of events) {
    // Skipped, not deleted one by one: a working-location marker can appear
    // every day of the window. Anything imported earlier is absent from
    // `listedIds`, so the reconciliation below removes it in one pass.
    if (googleStrategy.isGoneForUser(event)) continue;
    listedIds.add(event.id);
    try {
      const result = await upsertExternalEventFromGoogleEvent(event, lawFirmId, userId);
      if (result === 'created') createdCount++;
      else if (result === 'updated') updatedCount++;
    } catch (error: any) {
      console.error('Error syncing external event from Google:', event.id, error);
      throw error;
    }
  }

  // Imported events come from the main calendar. With the Paralegix calendar
  // targeted, this listing is a different calendar, so its absences say
  // nothing about them.
  let removedCount = 0;
  if (!pageToken && (settings.googleCalendarTarget || 'default') === 'default') {
    removedCount = await engine.removeUnlisted(lawFirmId, userId, listedIds, pollWindow.removable);
  }

  const syncedCount = createdCount + updatedCount;
  return {
    success: true,
    message: `Synced ${syncedCount} events from Google Calendar (${createdCount} created, ${updatedCount} updated, ${removedCount} removed)`,
    syncedCount,
    createdCount,
    updatedCount,
    removedCount,
  };
}

/**
 * Delete one event from Google Calendar by its id. The sync engine calls this
 * (`deleteOwnEvent` in the strategy) to remove a duplicate copy once one
 * meeting is found on both of a member's calendars.
 */
export async function deleteEvent({ userId, eventId }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) {
    throw new ValidationError('No Google token available');
  }
  if (!settings?.allowParalegixToGoogleSync) {
    throw new ValidationError('Paralegix to Google sync not enabled');
  }

  const calendarId = await resolveCalendarId(userId, userData, settings);

  const response = await makeGoogleApiCall(
    userId, userData,
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
    {
      method: 'DELETE',
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new AppError('Google token expired or invalid', 401, 'UNAUTHORIZED');
    }
    throw new AppError('Failed to delete Google Calendar event', 500);
  }

  return { success: true, message: 'Event deleted successfully' };
}

/**
 * Push one item for a "sync existing" request, under the same lock and through
 * the same create path as the real-time sync, so the event it creates is the one
 * every later save of the item PATCHes rather than duplicates.
 *
 * `state` is the saved entity row, and the event is built from it alone, the
 * way the per-change sync builds it; the request only names which rows to push.
 * It goes only to someone the per-change sync would push it to
 * (`isCalendarRecipient`). Returns the new event id, 'skipped' when there is
 * nothing to push or this user already has the event (including a real-time
 * push for it running right now), or null when Google refused the create.
 */
async function pushExistingItem({ adapter, state, userId, userData, settings, calendarId, requestTimeZone }: any) {
  if (!isCalendarRecipient(adapter.entityType, state, userId)) return 'skipped';
  const [item] = await adapter.toCalendarItems(state);
  if (!isExistingItemEligible(state, item, userId, state.timeZone || settings?.timezone)) return 'skipped';
  const start = item ? toInstant(item.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return 'skipped';

  const entity = resolver.resolveEntity(adapter.entityType, state);
  const mappingRef = resolver.mappingRefForEntity(adapter.entityType, state);
  try {
    const outcome = await withCalendarSyncLock(adapter.entityType, mappingRef.entityId, userId, () => createGoogleEventIfMissing({
      adapter, entity, entityData: state, userId, userData, calendarId, mappingRef, item, requestTimeZone, settings,
    }));
    if (!outcome) return null;
    return outcome.created ? outcome.eventId : 'skipped';
  } catch (err) {
    if (err instanceof AdvisoryLockTimeoutError) return 'skipped';
    throw err;
  }
}

/**
 * Bulk sync tasks to Google Calendar.
 */
export async function syncTasksToGoogle({ userId, tasks, timeZone }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) {
    throw new ValidationError('No Google token available');
  }
  if (!settings?.allowParalegixToGoogleSync) {
    throw new ValidationError('Paralegix to Google sync not enabled');
  }

  const requestTimeZone = resolvePreferredTimeZone(timeZone);
  const calendarId = await resolveCalendarId(userId, userData, settings, requestTimeZone);

  // Cross-tenant guard: only sync items for firms the user actually belongs to.
  const allowedFirmIds = await resolveSyncableFirmIds(userId, tasks.map((t: any) => t.lawFirmId));
  // Ethical wall: a task on a matter carries that matter's client roster into
  // the event description, so the caller must be able to read the matter.
  const mayReadMatter = matterWallFor(userId);

  let syncedCount = 0;
  const results = [];
  let tokenExpired = false;

  for (const task of tasks) {
    try {
      if (!task.dueDate) continue;
      if (!allowedFirmIds.has(task.lawFirmId)) {
        results.push({ taskId: task.taskId, success: false, error: 'Not a member of this firm' });
        continue;
      }
      // The matter the request names, then the row's own: the settings screen
      // sends none for a task, and the row is what the event is built from.
      const walled = { taskId: task.taskId, success: false, error: 'Not a member of this matter' };
      if (task.matterId && !(await mayReadMatter({ lawFirmId: task.lawFirmId, matterId: task.matterId }))) {
        results.push(walled);
        continue;
      }
      const state = await tasksRepo.getCalendarState(task.lawFirmId, task.taskId);
      if (!state) continue;
      if (!(await mayReadMatter(state))) {
        results.push(walled);
        continue;
      }

      // If we already detected an expired token, skip remaining tasks
      if (tokenExpired) {
        results.push({ taskId: task.taskId, success: false, error: 'Google token expired' });
        continue;
      }

      const outcome = await pushExistingItem({
        adapter: getAdapter('task'), state, userId, userData, settings, calendarId, requestTimeZone,
      });
      if (outcome === 'skipped') continue;
      if (outcome) {
        syncedCount++;
        results.push({ taskId: task.taskId, success: true, eventId: outcome });
      } else {
        results.push({ taskId: task.taskId, success: false, error: 'Failed to create event' });
      }
    } catch (error: any) {
      if (error.requiresReAuth) {
        tokenExpired = true;
        results.push({ taskId: task.taskId, success: false, error: 'Google token expired' });
      } else {
        console.error(`Error syncing task ${task.taskId} to Google Calendar:`, error);
        results.push({ taskId: task.taskId, success: false, error: 'Sync failed for this item' });
      }
    }
  }

  if (syncedCount > 0) stampOutboundPushForGoogle(userId).catch(() => {});

  // If refresh token is revoked, throw 401 so frontend can trigger re-auth
  if (tokenExpired && syncedCount === 0) {
    throw new AppError('Google access token expired. Please reconnect Google Calendar.', 401, 'UNAUTHORIZED');
  }

  return {
    success: true,
    message: `Synced ${syncedCount} tasks to Google Calendar`,
    syncedCount,
    results,
  };
}

/**
 * Bulk sync matter and client events to Google Calendar.
 * events: [{ eventId, matterId | clientId, lawFirmId, title, notes, date, type }]
 */
export async function syncEventsToGoogle({ userId, events, timeZone }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) {
    throw new ValidationError('No Google token available');
  }
  if (!settings?.allowParalegixToGoogleSync) {
    throw new ValidationError('Paralegix to Google sync not enabled');
  }

  const requestTimeZone = resolvePreferredTimeZone(timeZone);
  const calendarId = await resolveCalendarId(userId, userData, settings, requestTimeZone);

  // Cross-tenant guard: only sync items for firms the user actually belongs to.
  const allowedFirmIds = await resolveSyncableFirmIds(userId, events.map((e: any) => e.lawFirmId));
  // Ethical wall: a matter event belongs to exactly one matter, and its
  // description carries that matter's client roster.
  const mayReadMatter = matterWallFor(userId);

  let syncedCount = 0;
  const results = [];
  let tokenExpired = false;

  for (const ev of events) {
    try {
      if (!ev.date) continue;
      if (!allowedFirmIds.has(ev.lawFirmId)) {
        results.push({ eventId: ev.eventId, success: false, error: 'Not a member of this firm' });
        continue;
      }
      // The matter the request names first, so a matter id that resolves to
      // nothing is refused rather than skipped, then the row's own.
      const walled = { eventId: ev.eventId, success: false, error: 'Not a member of this matter' };
      if (ev.matterId && !(await mayReadMatter({ lawFirmId: ev.lawFirmId, matterId: ev.matterId }))) {
        results.push(walled);
        continue;
      }
      const loaded = await resolver.loadBatchEvent(ev);
      if (!loaded) continue;
      const { entityType, state } = loaded;
      if (!(await mayReadMatter(state))) {
        results.push(walled);
        continue;
      }

      // If we already detected an expired token, skip remaining events
      if (tokenExpired) {
        results.push({ eventId: ev.eventId, success: false, error: 'Google token expired' });
        continue;
      }

      const outcome = await pushExistingItem({
        adapter: getAdapter(entityType), state, userId, userData, settings, calendarId, requestTimeZone,
      });
      if (outcome === 'skipped') continue;
      if (outcome) {
        syncedCount++;
        results.push({ eventId: ev.eventId, success: true, googleEventId: outcome });
      } else {
        results.push({ eventId: ev.eventId, success: false, error: 'Failed to create event' });
      }
    } catch (error: any) {
      if (error.requiresReAuth) {
        tokenExpired = true;
        results.push({ eventId: ev.eventId, success: false, error: 'Google token expired' });
      } else {
        console.error(`Error syncing event ${ev.eventId} to Google Calendar:`, error);
        results.push({ eventId: ev.eventId, success: false, error: 'Sync failed for this item' });
      }
    }
  }

  if (syncedCount > 0) stampOutboundPushForGoogle(userId).catch(() => {});

  // If refresh token is revoked, throw 401 so frontend can trigger re-auth
  if (tokenExpired && syncedCount === 0) {
    throw new AppError('Google access token expired. Please reconnect Google Calendar.', 401, 'UNAUTHORIZED');
  }

  return {
    success: true,
    message: `Synced ${syncedCount} events to Google Calendar`,
    syncedCount,
    results,
  };
}

// ── Watch Channel Lifecycle (Silent Sync) ─────────────────────

/**
 * Create a Google Calendar watch channel for a user.
 * Google will POST to our webhook whenever events change.
 */
export async function createWatchChannel({ userId, lawFirmId }: any) {
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  if (!webhookBaseUrl || !webhookBaseUrl.startsWith('https://')) {
    return null;
  }

  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) return null;

  const calendarId = await resolveCalendarId(userId, userData, settings || {});
  const channelId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');

  const response = await makeGoogleApiCall(
    userId, userData,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: 'POST',
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: `${webhookBaseUrl}/api/webhooks/google-calendar`,
        token,
        params: { ttl: '604800' }, // 7 days in seconds
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('google.service: failed to create watch channel:', response.status, errText);
    return null;
  }

  const watchData = await response.json();

  // Store channel info for lookup when notifications arrive
  await calendarSyncRepo.saveWatchChannel({
    channelId,
    userId,
    lawFirmId,
    calendarId,
    resourceId: watchData.resourceId,
    token,
    expiration: new Date(parseInt(watchData.expiration, 10)),
  });

  // Renewal must retain the previous cursor, including changes not read yet.
  if (!userData.googleSyncToken) await initSyncToken({ userId, calendarId });

  return { channelId, resourceId: watchData.resourceId, expiration: watchData.expiration };
}

/**
 * Every replacement of a user's channel (renewal, re-point) runs under one
 * per-user lock. Each creates the new channel before stopping the old one, so
 * two that overlap would each leave a live channel behind. The hold covers a
 * create, the initial token listing and the stops; a re-point waits out a
 * renewal already in progress rather than failing.
 */
const WATCH_LOCK_OPTIONS = { lockTimeoutMs: 10_000, maxHoldMs: 120_000 };
const watchLockKey = (userId: string) => `google:${userId}`;

/**
 * Point live import at the calendar the user's target setting now names.
 *
 * A watch channel is bound to one calendar when it is created, and the stored
 * sync token belongs to that calendar too. Switching between "Your Main
 * Calendar" and "Separate Paralegix Calendar" otherwise left the channel on the
 * old calendar (so changes on the new one never notified) and replayed the old
 * calendar's token against the new one. The token is always cleared; the
 * channel is recreated only when the user had one, so switching the target does
 * not turn live import on for someone who never enabled it.
 */
export async function rearmWatchChannel(userId: string) {
  return advisoryLock.withLock('CALENDAR_WATCH', watchLockKey(userId), async () => {
    const existing = await calendarSyncRepo.findWatchChannelForUser(userId);
    await calendarTokens.setGoogleSyncToken(userId, null);
    if (!existing) return null;
    const oldChannels = await calendarSyncRepo.listWatchChannelsForUser(userId);
    const replacement = await createWatchChannel({ userId, lawFirmId: existing.lawFirmId });
    if (!replacement) throw new AppError('Could not replace the calendar watch. Retry enabling sync.', 503);
    for (const channel of oldChannels) await stopWatchChannel(channel.id);
    return replacement;
  }, WATCH_LOCK_OPTIONS);
}

/**
 * Ask Google to stop pushing notifications for a channel.
 *
 * `stopped` is true when Google no longer has the channel — either it accepted
 * the stop, or it answered 404 because the channel had already expired or been
 * stopped, which is the same end state. It is false when the channel is still
 * live: `makeGoogleApiCall` returns error responses rather than throwing, so a
 * non-2xx has to be inspected explicitly or a failed stop looks like a success.
 * Throws only if the call itself could not be made.
 */
async function requestChannelStop({ userId, userData, channelId, resourceId }: any) {
  const response = await makeGoogleApiCall(
    userId, userData,
    'https://www.googleapis.com/calendar/v3/channels/stop',
    { method: 'POST', body: JSON.stringify({ id: channelId, resourceId }) }
  );
  const stopped = response.ok || response.status === 404;
  if (!stopped) {
    console.warn(`google.service: channels/stop returned ${response.status} for channel ${channelId}`);
  }
  return { stopped, status: response.status };
}

/**
 * Stop a Google Calendar watch channel and forget it locally.
 *
 * The local row goes away either way — a renewal is replacing it, a disconnect
 * or firm deletion no longer wants it — and that row holds the only copy of the
 * channel id and resource id `channels/stop` needs. So a stop that fails is
 * unrecoverable unless the channel is written down first: Google would keep
 * pushing to a channel nothing could address, and a user's live channel count
 * would grow by one on every failed renewal. Anything that leaves the channel
 * live is recorded for the calendar-watch sweep to retry.
 */
export async function stopWatchChannel(channelId: any, { credentials }: { credentials?: any } = {}) {
  const channelData = await calendarSyncRepo.getWatchChannel(channelId);
  if (!channelData) return;

  const recordUnstopped = (reason: any) => calendarSyncRepo.recordWatchChannelStopFailure({
    channelId: channelData.channelId,
    resourceId: channelData.resourceId,
    userId: channelData.userId,
    lawFirmId: channelData.lawFirmId,
    expiration: channelData.expiration,
    error: reason,
  }).catch((err: any) => {
    console.error('google.service: could not record unstopped watch channel', channelId, err.message);
  });

  // Teardown tries whatever token the row holds, usable for sync or not. A
  // disconnect that has already replaced the row passes the old connection's
  // credentials, captured before the write.
  const userData = credentials
    || await calendarTokens.loadUserData(channelData.userId, { includeUnusableGrants: true });
  if (!userData?.googleAccessToken) {
    // No token to call Google with. Still worth recording: the user may
    // reconnect inside the channel's 7-day ttl, and the sweep can stop it then.
    await recordUnstopped('no Google access token available to stop the channel');
    await calendarSyncRepo.deleteWatchChannel(channelId);
    return;
  }

  try {
    const { stopped, status } = await requestChannelStop({
      userId: channelData.userId,
      userData,
      channelId: channelData.channelId,
      resourceId: channelData.resourceId,
    });
    if (!stopped) await recordUnstopped(`channels/stop returned ${status}`);
  } catch (err: any) {
    console.warn('google.service: error stopping watch channel:', err.message);
    await recordUnstopped(err);
  }

  await calendarSyncRepo.deleteWatchChannel(channelId);
}

/**
 * Stop all watch channels for a user (used when disconnecting Google).
 * `credentials` overrides the stored tokens; see `stopWatchChannel`.
 */
export async function stopAllWatchChannels(userId: string, { credentials }: { credentials?: any } = {}) {
  const channels = await calendarSyncRepo.listWatchChannelsForUser(userId);
  for (const channel of channels) {
    await stopWatchChannel(channel.id, { credentials });
  }
}

/**
 * Stop every watch channel a firm owns (used when the firm is deleted).
 *
 * This has to run BEFORE the law_firms row goes: the channel rows cascade with
 * the firm, and stopping a channel at Google needs the `resourceId` those rows
 * hold. Delete the firm first and the watch is unstoppable — Google keeps
 * pushing notifications until the channel expires on its own.
 *
 * One channel failing must not strand the rest, so each is attempted
 * independently and errors are logged rather than thrown.
 */
export async function stopWatchChannelsForLawFirm(lawFirmId: string) {
  const channels = await calendarSyncRepo.listWatchChannelsForLawFirm(lawFirmId);
  for (const channel of channels) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await stopWatchChannel(channel.id);
    } catch (err: any) {
      console.error('google.service: failed to stop watch channel', channel.id, err.message);
    }
  }
  return channels.length;
}

/**
 * Renew watch channels that expire within the next 24 hours.
 *
 * Every channel costs two serial round trips to Google (stop, then create) plus
 * an initial sync, so a platform with enough connected users takes longer than
 * one cron request has. `deadline` (epoch ms, shared across the request) stops
 * the walk cleanly and reports `truncated` instead of letting the run be cut off
 * mid-channel. Nothing is lost by stopping early: a channel that was not reached
 * is still inside the 24-hour window on the next run, so it is simply picked up
 * then — the window is wide enough to absorb several truncated passes.
 */
export async function renewExpiringChannels({ deadline = null }: any = {}) {
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
  const channels = await calendarSyncRepo.listExpiringWatchChannels(cutoff);

  let renewed = 0;
  let failed = 0;
  let processed = 0;

  for (const data of channels) {
    if (deadline && Date.now() >= deadline) break;
    try {
      // Another pass or a re-point already replacing this user's channel is
      // left to finish; a channel it does not replace is still due next run.
      const outcome = await advisoryLock.tryLock('CALENDAR_WATCH', watchLockKey(data.userId), async () => {
        // The listing above may predate a replacement that finished before this
        // pass took the lock. That replacement deleted this row.
        if (!(await calendarSyncRepo.getWatchChannel(data.id))) return 'gone';
        // Keep the old watch alive until its replacement is stored.
        const result = await createWatchChannel({ userId: data.userId, lawFirmId: data.lawFirmId });
        if (!result) return 'failed';
        await stopWatchChannel(data.id);
        return 'renewed';
      }, { maxHoldMs: WATCH_LOCK_OPTIONS.maxHoldMs });
      if (outcome.acquired && outcome.result === 'renewed') renewed++;
      else if (outcome.acquired && outcome.result === 'failed') failed++;
    } catch (err: any) {
      console.error(`google.service: failed to renew channel for user ${data.userId}:`, err.message);
      failed++;
    }
    processed++;
  }

  const truncated = processed < channels.length;
  if (truncated) {
    console.warn(
      `google.service: renewal budget exhausted after ${processed}/${channels.length} channels; ` +
      'the rest stay due and are retried on the next run'
    );
  }
  return { renewed, failed, truncated };
}

/**
 * Retry the `channels/stop` calls that failed, so a channel Google is still
 * pushing to eventually gets shut off instead of accumulating.
 *
 * Rows land here from `stopWatchChannel`; see the table's comment in
 * `calendarSync.repository.js` for why they cannot simply stay in
 * `calendar_subscriptions`. Bounded by row count and by wall clock, since an
 * unresponsive Google would otherwise let this pass run as long as it likes.
 */
export async function retryUnstoppedWatchChannels({ limit = 50, deadline = null }: any = {}) {
  // Channels Google has already expired need no stopping; drop them first so
  // they neither occupy the row budget nor count as dead-lettered.
  let expired = 0;
  try {
    expired = await calendarSyncRepo.purgeExpiredWatchChannelStopFailures();
  } catch (err: any) {
    console.error('google.service: failed to purge expired watch-channel stop rows:', err.message);
  }

  let due = [];
  try {
    due = await calendarSyncRepo.listDueWatchChannelStopFailures(limit);
  } catch (err: any) {
    console.error('google.service: failed to list unstopped watch channels:', err.message);
    return { attempted: 0, stopped: 0, failed: 0, expired, truncated: false };
  }

  let stopped = 0;
  let failed = 0;
  let attempted = 0;
  for (const row of due) {
    if (deadline && Date.now() >= deadline) break;
    attempted++;
    try {
      const { userData } = await getUserDataAndSettings(row.userId);
      if (!userData?.googleAccessToken) throw new Error('no Google access token available');
      const result = await requestChannelStop({
        userId: row.userId,
        userData,
        channelId: row.channelId,
        resourceId: row.resourceId,
      });
      if (!result.stopped) throw new Error(`channels/stop returned ${result.status}`);
      await calendarSyncRepo.resolveWatchChannelStopFailure(row.channelId);
      stopped++;
    } catch (err: any) {
      await calendarSyncRepo.rescheduleWatchChannelStopFailure(row.channelId, err).catch(() => {});
      failed++;
    }
  }

  // Channels that exhausted their retry budget while still inside their ttl are
  // still being pushed to by Google, and nothing will remove them before they
  // expire. Surface the count so that is visible rather than inferred.
  let deadLettered = 0;
  try {
    deadLettered = await calendarSyncRepo.countDeadLetteredWatchChannelStopFailures();
    if (deadLettered > 0) {
      console.warn(
        `google.service: ${deadLettered} watch channel(s) could not be stopped after ` +
        `${calendarSyncRepo.CHANNEL_STOP_RETRY_MAX_ATTEMPTS} attempts and are still live at Google`
      );
    }
  } catch (err: any) {
    console.error('google.service: failed to count unstoppable watch channels:', err.message);
  }

  return { attempted, stopped, failed, expired, deadLettered, truncated: attempted < due.length };
}

/**
 * Stop a channel that is still notifying after its stop failed.
 *
 * Its `calendar_subscriptions` row is gone, so the webhook knows it only as an
 * unknown channel id, and the stop-retry row is the one record of who owns it.
 * A notification is proof it is live, which matters most once that row has
 * spent its retry budget and the sweep no longer tries it. The notification's
 * resource id must match the one recorded, so a forged delivery that guesses a
 * channel id cannot drive requests to Google. Returns whether it is stopped; a
 * refused stop leaves the row for the sweep.
 */
export async function stopLingeringChannel({ channelId, resourceId }: { channelId: string; resourceId: string }) {
  const row = await calendarSyncRepo.getWatchChannelStopFailure(channelId);
  if (!row?.resourceId || row.resourceId !== resourceId || !row.userId) return false;
  const userData = await calendarTokens.loadUserData(row.userId, { includeUnusableGrants: true });
  if (!userData?.googleAccessToken) return false;
  const { stopped } = await requestChannelStop({
    userId: row.userId, userData, channelId: row.channelId, resourceId: row.resourceId,
  });
  if (stopped) await calendarSyncRepo.resolveWatchChannelStopFailure(row.channelId);
  return stopped;
}

// ── Incremental Sync (syncToken-based) ────────────────────────

const MAX_INIT_TOKEN_PAGES = 20;

/**
 * List a calendar to obtain a syncToken, without processing events.
 * Called after creating a watch channel, and when a notification finds none.
 *
 * Google puts `nextSyncToken` only on the LAST page of a listing; every earlier
 * page carries `nextPageToken` instead. So the whole listing has to be read,
 * at the largest page size Google allows. A single one-event page ends early on
 * any calendar holding more than one event, stores nothing, and leaves every
 * later notification on a full one-year re-read.
 */
async function initSyncToken({ userId, calendarId, persist = true }: any) {
  const { userData } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) return null;

  let pageToken = null;
  for (let page = 0; page < MAX_INIT_TOKEN_PAGES; page++) {
    const params = new URLSearchParams({ maxResults: '2500', showDeleted: 'true' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await makeGoogleApiCall(
      userId, userData,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      console.error('google.service: failed to init syncToken:', response.status);
      return null;
    }

    const data = await response.json();
    if (data.nextSyncToken) {
      if (persist) await calendarTokens.setGoogleSyncToken(userId, data.nextSyncToken);
      return data.nextSyncToken;
    }
    pageToken = data.nextPageToken || null;
    if (!pageToken) return null;
  }

  console.warn(`google.service: initSyncToken hit MAX_INIT_TOKEN_PAGES (${MAX_INIT_TOKEN_PAGES}) for user ${userId}; no token stored`);
  return null;
}


/**
 * Bring one repeating Google event in as its occurrences.
 *
 * The delta reports a repeating event as its parent only, carrying the first
 * date and the repeat rule. Imported as-is it became one event on the first
 * date, which the full poll (which lists occurrences) then duplicated. This
 * lists the occurrences instead, imports each, removes a parent imported the old
 * way, and removes occurrences of this series that no longer exist in the range
 * read (an edit to "all events" gives them new ids). A parent that is a copy
 * Paralegix pushed stays linked to its item.
 */
async function syncGoogleSeries({ userId, userData, calendarId, lawFirmId, seriesId }: any) {
  const now = Date.now();
  const { from, to } = seriesWindow(now);
  const instances: any[] = [];
  let pageToken = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await makeGoogleApiCall(
      userId, userData,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesId)}/instances?${params}`,
      { method: 'GET' },
    );
    if (!response.ok) {
      // Gone between the delta and this read: nothing to import.
      if (response.status === 404 || response.status === 410) return { created: 0, updated: 0, removed: 0 };
      const err: any = new AppError(`Google series read failed: ${response.status}`, response.status);
      err.retryable = response.status === 429 || response.status >= 500;
      throw err;
    }
    const data = await response.json();
    instances.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < MAX_SERIES_PAGES);

  const mappingCache = await calendarSyncRepo
    .getMappingsByExternalIds(instances.map((e) => e.id))
    .catch(() => new Map());
  const listed = new Set<string>();
  let created = 0;
  let updated = 0;
  for (const instance of instances) {
    if (googleStrategy.isGoneForUser(instance)) continue;
    listed.add(instance.id);
    const result = await upsertExternalEventFromGoogleEvent(instance, lawFirmId, userId, mappingCache);
    if (result === 'created') created++;
    else if (result === 'updated') updated++;
  }

  let removed = (await engine.removeImportedSeriesParent(seriesId, lawFirmId, userId, mappingCache)) ? 1 : 0;
  // Only after a complete read: a truncated one would read as deletions.
  if (!pageToken) {
    removed += await engine.removeUnlisted(lawFirmId, userId, listed, { from, to, idPrefix: `${seriesId}_` });
  }
  return { created, updated, removed };
}

/**
 * Process a watch notification: run incremental sync for the user.
 *
 * Serialized per user across instances. Google's incremental sync is driven by a
 * single stored `googleSyncToken`: two notifications processed at once both read
 * the same token, both request the same delta, and both create the same local
 * events — then both write back a new token, so one delta is lost entirely. This
 * is already racy at one instance, because Node handles concurrent webhook
 * requests happily; more instances only widen it.
 *
 * A push that cannot get the lock is DROPPED rather than queued, deliberately:
 * the worker holding it is about to consume the same delta, so the change is not
 * lost. Google also re-notifies, and the calendar-watch cron re-runs the
 * idempotent sync behind that.
 */
export async function processWatchNotification({ userId, lawFirmId, forceFull = false }: any) {
  if (!userId) return;
  try {
    return await advisoryLock.withLock('CALENDAR_WEBHOOK', userId, () =>
      processWatchNotificationUnlocked({ userId, lawFirmId, forceFull }),
    { lockTimeoutMs: 5000, maxHoldMs: 120_000 });
  } catch (err: any) {
    if (err instanceof AdvisoryLockTimeoutError) {
      console.warn(`google.service: watch notification for user ${userId} retained for retry while another sync holds the lock`);
    }
    throw err;
  }
}

async function processWatchNotificationUnlocked({ userId, lawFirmId, forceFull = false }: any) {
  try {
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.googleAccessToken) return;
    if (!settings?.allowGoogleToParalegixSync) return;

    const syncToken = forceFull ? null : userData.googleSyncToken;
    const calendarId = await resolveCalendarId(userId, userData, settings, null);

    // A channel created before the calendar target changed still watches the
    // old calendar, and the stored token belongs to that calendar too. Reads go
    // to the target calendar, so changes there never notify and the old token
    // is replayed against the wrong calendar. Re-point the channel (which also
    // reads a fresh token from the target calendar), then catch up in full.
    const channel = await calendarSyncRepo.findWatchChannelForUser(userId);
    if (channel?.calendarId && channel.calendarId !== calendarId) {
      await rearmWatchChannel(userId);
      await syncFromGoogle({ userId, lawFirmId });
      return;
    }

    if (!syncToken) {
      // No syncToken yet. Take one before the full sync, so a change made while
      // it runs is in the next delta rather than lost between the two reads.
      const baseline = await initSyncToken({ userId, calendarId, persist: false });
      await syncFromGoogle({ userId, lawFirmId });
      if (baseline) await calendarTokens.setGoogleSyncToken(userId, baseline);
      return;
    }

    // Fetch only changed events using syncToken.
    // Page through the delta (maxResults caps each page at 100). The page cap is a
    // safety stop against an unbounded loop. A very large delta (e.g. the first
    // notification after a long gap) could otherwise hold the webhook handler open
    // until timeout. Mirrors the MAX_SYNC_PAGES guard in syncFromGoogle.
    const MAX_DELTA_PAGES = 50;
    let allChangedEvents: any[] = [];
    let pageToken = userData.googleDeltaPageToken || null;
    let newSyncToken = null;
    let pageCount = 0;

    do {
      const params = new URLSearchParams({ syncToken, showDeleted: 'true', maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await makeGoogleApiCall(
        userId, userData,
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        { method: 'GET' }
      );

      if (response.status === 410) {
        // syncToken expired. Google says do a full sync
        await calendarTokens.setGoogleSyncToken(userId, null);
        const baseline = await initSyncToken({ userId, calendarId, persist: false });
        await syncFromGoogle({ userId, lawFirmId });
        if (baseline) await calendarTokens.setGoogleSyncToken(userId, baseline);
        return;
      }

      if (!response.ok) {
        // 410 (syncToken expired) is handled terminally above. For the remaining
        // non-OK statuses, distinguish a TRANSIENT failure (429 rate-limit, 5xx
        // server error, or a Google error reason of rateLimitExceeded /
        // userRateLimitExceeded / backendError / internalError) from a TERMINAL
        // auth failure (401 invalid_token, 403 non-rate-limit). Transient failures
        // MUST throw so the webhook route (and the retry sweep) persist/keep a
        // durable retry instead of silently dropping the change. Previously this
        // returned for all non-OK statuses, defeating the durability layer for
        // exactly the retryable matter it exists to cover. Terminal failures still
        // return so a permanently bad token is not retried forever. Mirrors the
        // Outlook processSubscriptionNotification fix.
        let reason = null;
        try {
          const errBody = JSON.parse(await response.text());
          reason = errBody?.error?.errors?.[0]?.reason || errBody?.error?.status || null;
        } catch (_) {
          // Non-JSON or empty body. Fall back to status-code classification only.
        }

        const RETRYABLE_REASONS = new Set([
          'rateLimitExceeded',
          'userRateLimitExceeded',
          'backendError',
          'internalError',
        ]);
        const isRetryable =
          response.status === 429 ||
          response.status >= 500 ||
          (reason && RETRYABLE_REASONS.has(reason));

        if (isRetryable) {
          const err: any = new AppError(`Google incremental sync failed: ${response.status}${reason ? ` (${reason})` : ''}`, response.status);
          err.retryable = true;
          throw err;
        }

        // Terminal (e.g. 401 invalid_token, 403 non-rate-limit auth): drop the
        // change rather than retry a permanently bad token forever.
        console.error('google.service: incremental sync failed (terminal):', response.status, reason || '');
        return;
      }

      const data = await response.json();
      allChangedEvents = allChangedEvents.concat(data.items || []);
      pageToken = data.nextPageToken || null;
      if (data.nextSyncToken) newSyncToken = data.nextSyncToken;
      pageCount++;
    } while (pageToken && pageCount < MAX_DELTA_PAGES);

    if (pageToken) {
      console.warn(`google.service: processWatchNotification hit MAX_DELTA_PAGES (${MAX_DELTA_PAGES}) for user ${userId}; remaining delta not processed this run`);
    }

    // C3: dedupe changed-event ids across pages. The same event id can appear
    // multiple times in a paged delta (e.g. edited then edited again before the
    // read); keep only the LAST occurrence so we process each event once with
    // its newest state instead of re-running 3-4 lookups + cross-sync per copy.
    const latestById = new Map();
    for (const event of allChangedEvents) {
      if (event?.id) latestById.set(event.id, event);
    }
    const dedupedEvents = Array.from(latestById.values());

    // C3: prefetch every changed event's calendar_mappings row in one query so
    // the per-event upsert resolves its matterEvent/clientEvent/billing branch
    // without a separate round-trip each. Same task -> external -> mapping order.
    const mappingCache = await calendarSyncRepo
      .getMappingsByExternalIds(dedupedEvents.map((e) => e.id))
      .catch(() => new Map());

    // Process changed events
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let firstEventError: any = null;
    let firstFailedDeleteEventId = null;

    for (const event of dedupedEvents) {
      try {
        if (googleStrategy.isGoneForUser(event)) {
          const didDelete = await engine.processInboundDelete(event.id, lawFirmId, userId, mappingCache);
          if (didDelete) deleted++;
          // When the gone event is a series parent, every occurrence of it
          // (ids `<parent>_<start>`) is gone too. For anything else this
          // prefix matches nothing.
          deleted += await engine.removeUnlisted(lawFirmId, userId, new Set(), { idPrefix: `${event.id}_` });
          continue;
        }

        if (googleStrategy.isRecurringSeries(event)) {
          const series = await syncGoogleSeries({ userId, userData, calendarId, lawFirmId, seriesId: event.id });
          created += series.created;
          updated += series.updated;
          deleted += series.removed;
          continue;
        }

        const result = await upsertExternalEventFromGoogleEvent(event, lawFirmId, userId, mappingCache);
        if (result === 'created') created++;
        else if (result === 'updated') updated++;
      } catch (eventErr) {
        console.error('google.service: error processing changed event:', event.id, eventErr);
        if (!firstEventError) firstEventError = eventErr;
        // A failed DELETE can't be recovered by the retry's full re-sync:
        // syncFromGoogle lists without showDeleted and skips cancelled events, and
        // the syncToken has already advanced past this one, so the deletion is never
        // seen again and the local event orphans. Remember the id so the retry can
        // replay the specific (idempotent) processInboundDelete.
        if (googleStrategy.isGoneForUser(event) && !firstFailedDeleteEventId) firstFailedDeleteEventId = event.id;
      }
    }

    // Surface a per-event failure to the caller so the webhook route can persist a
    // durable retry. Creates/updates are recovered by the retry's FULL re-sync
    // (syncFromGoogle, idempotent via the upsert chain's dedup + last-writer-wins);
    // a failed DELETE is carried on the error so the retry can replay it directly.
    if (firstEventError) {
      if (firstFailedDeleteEventId) firstEventError.failedDeleteEventId = firstFailedDeleteEventId;
      throw firstEventError;
    }
    // Advance only after every event landed. A failed write must leave the
    // same delta available to the next delivery or durable retry.
    if (newSyncToken && !pageToken) {
      await calendarTokens.setGoogleSyncToken(userId, newSyncToken);
      await calendarTokens.updateTokenMeta(userId, 'google', { googleDeltaPageToken: null, googleDeltaCursor: null });
    } else if (pageToken) {
      await calendarTokens.updateTokenMeta(userId, 'google', { googleDeltaPageToken: pageToken, googleDeltaCursor: syncToken });
      await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId, lawFirmId, pending: true });
    }
  } catch (error: any) {
    console.error('google.service: processWatchNotification failed:', error);
    throw error;
  }
}

export const _buildAllDayEventRange = buildAllDayEventRange;
export const _buildTimedEventRange = buildTimedEventRange;
export const _formatDateForTz = zonedWallClock;
