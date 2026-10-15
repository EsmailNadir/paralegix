const crypto = require('crypto');
const calendarTokens = require('../shared/calendarTokens');
const calendarSyncRepo = require('../shared/calendarSync.repository');
const resolver = require('../shared/calendarEntityResolver');
const tasksRepo = require('../../tasks/tasks.repository');
const { resolveSyncableFirmIds, matterWallFor } = require('../shared/syncFirmGuard');
const { makeMicrosoftGraphCall, getUserDataAndSettings, refreshGrant, cleanHtmlContent, stripCalendarHeader } = require('../shared/calendarHelpers');
const { AppError, ValidationError } = require('../../../shared/errors/AppError');
const { normalizeTimeZone, zonedWallClock, toInstant } = require('../../../shared/utils/time');
const {
  normalizeIanaTimeZone, resolvePreferredIanaTimeZone, toGraphTimeZone, parseOutlookDateTime, parseOutlookDueDate,
} = require('./outlookTime');
const {
  isExistingItemEligible, timedEnd, allDaySpan, fullPollWindow, seriesWindow, MAX_SERIES_PAGES,
} = require('../shared/calendarTime');
const { AdvisoryLockTimeoutError } = require('../../../shared/database/advisoryLock');
const advisoryLock = require('../../../shared/database/advisoryLock');
import { withCalendarSyncLock } from '../shared/calendarSyncLock';
import { isCalendarRecipient } from '../shared/calendarRecipients';
import { connectionReport, connectionState } from '../shared/calendarGrant';

function resolveEventTimeZone(itemTimeZone: any, requestTimeZone: any, fallbackTimeZone: any) {
  const itemTz = resolvePreferredIanaTimeZone(itemTimeZone);
  const requestTz = resolvePreferredIanaTimeZone(requestTimeZone);
  const fallbackTz = resolvePreferredIanaTimeZone(fallbackTimeZone);
  return itemTz || requestTz || fallbackTz || 'UTC';
}

/**
 * Get the user's Outlook mailbox timezone (cached on the user doc after first fetch).
 * Falls back to 'UTC' if the API call fails.
 * Always returns an IANA timezone name (converts Windows names automatically).
 */
async function getOutlookTimeZone(userId: string, userData: any, { forceFetch = false }: any = {}) {
  // Return cached value if available
  if (!forceFetch && userData.outlookTimezone) return normalizeIanaTimeZone(userData.outlookTimezone);

  try {
    const response = await makeMicrosoftGraphCall(
      userId, userData,
      'https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone',
    );
    if (response.ok) {
      const data = await response.json();
      const rawTz = data.value || 'UTC';
      const ianaTz = normalizeIanaTimeZone(rawTz);
      // Cache the IANA version on the user's Microsoft token meta for future calls
      await calendarTokens.updateTokenMeta(userId, 'microsoft', { outlookTimezone: ianaTz });
      userData.outlookTimezone = ianaTz;
      return ianaTz;
    }
  } catch (err: any) {
    console.warn('Failed to fetch Outlook timezone, defaulting to UTC:', err.message);
  }
  return 'UTC';
}

async function getOutlookTimeZoneContext(userId: string, userData: any, requestedTimeZone: any) {
  const requestTimeZone = resolvePreferredIanaTimeZone(requestedTimeZone);
  // Use the cached mailbox tz when known (set on first fetch / after a PATCH) instead
  // of hitting Graph on every sync; only the error path below force-refetches.
  const mailboxTimeZone = await getOutlookTimeZone(userId, userData, { forceFetch: false });
  const mailboxMatchesRequest = !requestTimeZone || mailboxTimeZone === requestTimeZone;
  const mailboxAccessDenied = userData.outlookMailboxTimezoneWritable === false;


  return {
    requestTimeZone,
    mailboxTimeZone,
    mailboxMatchesRequest,
    mailboxAccessDenied,
  };
}

function resolveGraphEventZone(eventTimeZone: any, timeZoneContext: any) {
  const sourceTimeZone = resolvePreferredIanaTimeZone(eventTimeZone)
    || timeZoneContext.requestTimeZone
    || timeZoneContext.mailboxTimeZone
    || 'UTC';

  return { sourceTimeZone, graphTimeZone: toGraphTimeZone(sourceTimeZone), shouldPreserveWallClock: false, preserveReason: null };
}

// Graph all-day start/end body: midnight to midnight local time, with the end
// EXCLUSIVE (midnight of the day after the last day). `allDaySpan` works both
// days out.
function buildOutlookAllDayRange(startDate: any, endDate: any, graphTimeZone: any) {
  const { startDay, endDay } = allDaySpan(startDate, endDate);
  return {
    start: { dateTime: `${startDay}T00:00:00`, timeZone: graphTimeZone },
    end: { dateTime: `${endDay}T00:00:00`, timeZone: graphTimeZone },
    isAllDay: true,
  };
}

// Graph timed start/end body. The end is the item's own when it has one, else
// the default block. Start and end are the wall clock in `sourceTimeZone`
// labelled `graphTimeZone`: the same zone normally, so the exact instant is
// kept. When the mailbox zone could not be matched to the caller's they differ
// on purpose (`resolveGraphEventZone`), keeping the time the caller sees.
//
// Known limit: in the hour that repeats when clocks go back, this wall clock
// names two instants and Graph picks one. Google is sent an offset to settle
// it (`buildTimedEventRange` in google.service.ts), but Graph's dateTimeTimeZone
// has no offset: its `dateTime` is a bare wall clock read in `timeZone`. Labelling the time UTC
// instead would settle the instant but show the event in UTC to the member, so
// the zone label is kept and the repeated hour stays ambiguous on Outlook.
function buildOutlookTimedRange(startDate: any, endDate: any, sourceTimeZone: any, graphTimeZone: any) {
  const end = timedEnd(startDate, endDate);
  return {
    start: { dateTime: zonedWallClock(startDate, sourceTimeZone), timeZone: graphTimeZone },
    end: { dateTime: zonedWallClock(end, sourceTimeZone), timeZone: graphTimeZone },
    isAllDay: false,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Get or create the Paralegix calendar in Outlook.
 *
 * The calendar is identified by the id stored when it was created, never by its
 * name: the user may rename it, or own an unrelated calendar called
 * "Paralegix". A new one is created only when none is stored or Microsoft
 * reports the stored one gone. Any other failure to read it returns null, so a
 * calendar that still exists is never duplicated.
 */
async function getOrCreateParalegixCalendar(userId: string, userData: any) {
  const settings = await calendarTokens.getSettings(userId);
  const storedId = settings?.paralegixCalendarId;
  if (storedId) {
    const response = await makeMicrosoftGraphCall(
      userId, userData, `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(storedId)}`,
    );
    if (response.ok) return response.json();
    if (response.status !== 404 && response.status !== 410) {
      console.warn(`outlook.service: could not read the stored Paralegix calendar (status ${response.status})`);
      return null;
    }
  }

  // Create new Paralegix calendar
  const createResponse = await makeMicrosoftGraphCall(userId, userData, 'https://graph.microsoft.com/v1.0/me/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Paralegix', color: 'auto' }),
  });

  if (!createResponse.ok) return null;

  const newCalendar = await createResponse.json();

  await calendarTokens.saveSettings(userId, {
    outlookCalendarId: newCalendar.id,
    paralegixCalendarId: newCalendar.id,
  });

  return newCalendar;
}

/**
 * Resolve which Outlook calendar endpoint to use based on user settings.
 *
 * C8: when targeting the Paralegix calendar, use the id cached on the user's settings
 * (persisted by getOrCreateParalegixCalendar on first create) instead of listing
 * the user's ENTIRE calendar set on every create/update. Mirrors the Google
 * paralegixGoogleCalendarId fast path. Only discovers/creates (and thus persists)
 * when the id is unknown.
 */
async function resolveCalendarEndpoint(userId: string, userData: any, settings: any, isCreate: any) {
  const calendarTarget = settings.outlookCalendarTarget || 'default';
  if (calendarTarget === 'paralegix') {
    const cachedId = settings.paralegixCalendarId || settings.outlookCalendarId;
    if (cachedId) {
      return `https://graph.microsoft.com/v1.0/me/calendars/${cachedId}/events`;
    }
    const paralegixCal = await getOrCreateParalegixCalendar(userId, userData);
    if (!paralegixCal) return null;
    return `https://graph.microsoft.com/v1.0/me/calendars/${paralegixCal.id}/events`;
  }
  return 'https://graph.microsoft.com/v1.0/me/events';
}

// ── Generic Entity Sync (adapter-driven) ────────────────────

function getStoredOutlookKeys(adapter: any, entityData: any, userId: string) {
  if (typeof adapter.listOutlookSyncKeys === 'function') {
    return adapter.listOutlookSyncKeys(entityData, userId) || [];
  }
  return [];
}

/**
 * The Outlook event this (user, entity, item) already has, if any. Mirrors
 * `resolveExistingGoogleEventId`: the entity's writeback field is the stale fast
 * path (the payload was loaded before this sync began, and an outbox replay
 * carries that same pre-sync snapshot), and `calendar_mappings` is the durable
 * record written the moment a create succeeds.
 */
async function resolveExistingOutlookEventId({ adapter, entityData, userId, itemKey, entityId }: any) {
  const fromEntity = adapter.getOutlookEventId(entityData, itemKey, userId);
  if (fromEntity) return fromEntity;
  const mapped = await calendarSyncRepo.findMappingForEntityItem({
    provider: 'outlook', userId, entityType: adapter.entityType,
    entityId: entityId ?? entityData?.id, itemKey,
  }).catch(() => null);
  return mapped?.externalEventId || null;
}

/**
 * Record a freshly created Outlook event: mapping row first, entity writeback
 * second, so a failure between the two can never leave `calendar_sync` naming an
 * event `calendar_mappings` does not. See the Google twin for the full reasoning.
 */
async function saveOutlookMappingThenWriteback({
  adapter, entity, entityData, userId, mappingRef, itemKey, externalEventId, changeKey, pushedModifiedAt,
}: any) {
  await calendarSyncRepo.saveMapping({
    provider: 'outlook',
    externalEventId,
    userId,
    lawFirmId: entityData.lawFirmId,
    entityType: adapter.entityType,
    entityId: mappingRef.entityId,
    scopeId: mappingRef.scopeId,
    itemKey,
    pushedVersion: changeKey, pushedModifiedAt,
  });
  await entity.applyDescriptor(adapter.buildOutlookWriteback(itemKey, externalEventId, changeKey, userId));
}

/**
 * Record a freshly created Outlook event (mapping then writeback), or undo the
 * create if that recording fails.
 *
 * C03 (calendar replay matrix): the Graph create can succeed while recording
 * it locally does not - a dropped connection, a statement timeout, a
 * unique-index refusal on the mapping. Neither `calendar_mappings` nor the
 * entity writeback would then name the new event, so the NEXT pass over this
 * same item (an outbox replay, or simply the next save) has no way to find it
 * and would POST a second one, leaving two live events for one Paralegix
 * item. Graph's create endpoint offers no client-supplied idempotency key
 * here, so there is no "look it up and reconcile" path - the only recovery is
 * a compensating delete: undo the provider-side create so the next attempt
 * starts clean. If that compensating delete ALSO fails, an unmapped orphan
 * can still survive on the user's real mailbox; that residual gap is logged
 * loudly rather than hidden, since two failures in the same request is
 * already a degraded case with no atomic fix across systems that do not
 * share a transaction. Shared by every Outlook create path (`createEventsFromEntity`
 * and `createOutlookEventForItem`) so the recovery lives in exactly one place.
 */
async function saveOutlookMappingOrCompensate({
  adapter, entity, entityData, userId, userData, mappingRef, item, event,
}: any) {
  try {
    await saveOutlookMappingThenWriteback({
      adapter, entity, entityData, userId, mappingRef,
      itemKey: item.key, externalEventId: event.id, changeKey: event.changeKey,
      pushedModifiedAt: event.lastModifiedDateTime,
    });
  } catch (recordErr) {
    console.error(`calendar.events: Outlook event ${event.id} for ${adapter.entityType}/${item.key} was created but not recorded locally; attempting a compensating delete`, recordErr);
    const cleanedUp = await makeMicrosoftGraphCall(
      userId, userData,
      `https://graph.microsoft.com/v1.0/me/events/${event.id}`,
      { method: 'DELETE' },
    ).then((r: any) => r.ok || r.status === 404 || r.status === 410).catch(() => false);
    if (!cleanedUp) {
      console.error(`calendar.events: compensating delete FAILED for orphaned Outlook event ${event.id} (${adapter.entityType}/${item.key}); it will remain on the user's mailbox unmapped`);
    }
    throw recordErr;
  }
}

/**
 * POST a fresh Outlook event for one calendar item and record it. Shared by
 * the "no mapping yet" and "mapping pointed at a provider-deleted event"
 * paths in `updateEventsFromEntity`; see the Google twin
 * (`createGoogleEventForItem`) for the full reasoning.
 */
async function createOutlookEventForItem({
  adapter, entity, entityData, userId, userData, settings, mappingRef, item, eventData, _retriedCalendar,
}: any) {
  const calendarEndpoint = await resolveCalendarEndpoint(userId, userData, settings, true);
  if (!calendarEndpoint) return null;

  const response = await makeMicrosoftGraphCall(userId, userData, calendarEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventData),
  });

  if (!response.ok) {
    // Mirrors the Google twin (`createGoogleEventForItem`): a 404/410 here means
    // the CALENDAR itself is gone, not one event within it. Only the cached
    // Paralegix calendar id can be deleted out from under the user this way -
    // the default target posts to `/me/events` with no calendar id in the URL
    // at all, so it can never hit this branch. Without this, a deleted
    // Paralegix calendar left the cached id pointing at a dead calendar
    // forever: every future sync repeated the same failing POST with nothing to
    // recover it.
    const cachedCalendarId = settings.paralegixCalendarId || settings.outlookCalendarId;
    if (!_retriedCalendar && (response.status === 404 || response.status === 410)
        && settings.outlookCalendarTarget === 'paralegix' && cachedCalendarId) {
      console.warn(`calendar.events: Outlook calendar ${cachedCalendarId} is gone (status ${response.status}); recreating the Paralegix calendar`);
      await calendarTokens.saveSettings(userId, { paralegixCalendarId: null, outlookCalendarId: null }).catch(() => {});
      const freshCalendar = await getOrCreateParalegixCalendar(userId, userData).catch(() => null);
      if (freshCalendar?.id) {
        return createOutlookEventForItem({
          adapter, entity, entityData, userId, userData, mappingRef, item, eventData,
          settings: { ...settings, paralegixCalendarId: freshCalendar.id, outlookCalendarId: freshCalendar.id },
          _retriedCalendar: true,
        });
      }
    }
    throw new AppError('Calendar provider rejected the event create', 503);
  }

  const event = await response.json();
  await saveOutlookMappingOrCompensate({ adapter, entity, entityData, userId, userData, mappingRef, item, event });
  return event;
}

/**
 * Create the Outlook event for one calendar item unless this user already has
 * one. The Outlook twin of `createGoogleEventIfMissing` in google.service.ts,
 * which carries the reasoning: a replayed create or a "sync existing" press on
 * an item the real-time sync already pushed must find the mapping row, not POST
 * a second event.
 *
 * Returns `{ created, eventId }`, or null when nothing was pushed. Throws when
 * recording fails or the account needs reconnecting.
 */
async function createOutlookEventIfMissing({
  adapter, entity, entityData, userId, userData, settings, mappingRef, item, timeZoneContext,
}: any): Promise<{ created: boolean; eventId: string } | null> {
  const startDate = toInstant(item.dateTime);
  if (!startDate || Number.isNaN(startDate.getTime())) return null;

  const alreadyCreated = await resolveExistingOutlookEventId({
    adapter, entityData, userId, itemKey: item.key, entityId: mappingRef.entityId,
  });
  if (alreadyCreated) {
    if (!adapter.getOutlookEventId(entityData, item.key, userId)) {
      await entity.applyDescriptor(adapter.buildOutlookWriteback(item.key, alreadyCreated, null, userId));
    }
    return { created: false, eventId: alreadyCreated };
  }

  const endDate = item.end ? toInstant(item.end) : null;
  const fallbackTimeZone = timeZoneContext.requestTimeZone || timeZoneContext.mailboxTimeZone;
  const eventTz = resolveEventTimeZone(item.timeZone, timeZoneContext.requestTimeZone, fallbackTimeZone);
  const { sourceTimeZone: outlookTz, graphTimeZone: graphTz } = resolveGraphEventZone(eventTz, timeZoneContext);
  const eventData: any = {
    subject: item.summary,
    body: { contentType: 'text', content: item.description || '' },
    ...(item.allDay
      ? buildOutlookAllDayRange(startDate, endDate, graphTz)
      : buildOutlookTimedRange(startDate, endDate, outlookTz, graphTz)),
  };
  if (item.location) eventData.location = { displayName: item.location };
  if (item.isPrivate && item.sourceProvider !== 'outlook') eventData.sensitivity = 'private';

  const event = await createOutlookEventForItem({
    adapter, entity, entityData, userId, userData, settings, mappingRef, item, eventData,
  });
  return event ? { created: true, eventId: event.id } : null;
}

/**
 * Push one item for a "sync existing" request under the real-time sync's lock
 * and create path, built from the saved row alone and only for a recipient the
 * per-change sync would push to. The Outlook twin of `pushExistingItem` in
 * google.service.ts: returns the new event id, 'skipped', or null when Graph
 * refused the create.
 */
async function pushExistingItem({ adapter, state, userId, userData, settings, timeZoneContext }: any) {
  if (!isCalendarRecipient(adapter.entityType, state, userId)) return 'skipped';
  const [item] = await adapter.toCalendarItems(state);
  if (!isExistingItemEligible(state, item, userId, state.timeZone || settings?.timezone)) return 'skipped';
  const start = item ? toInstant(item.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return 'skipped';

  const entity = resolver.resolveEntity(adapter.entityType, state);
  const mappingRef = resolver.mappingRefForEntity(adapter.entityType, state);
  try {
    const outcome = await withCalendarSyncLock(adapter.entityType, mappingRef.entityId, userId, () => createOutlookEventIfMissing({
      adapter, entity, entityData: state, userId, userData, settings, mappingRef, item, timeZoneContext,
    }));
    if (!outcome) return null;
    return outcome.created ? outcome.eventId : 'skipped';
  } catch (err) {
    if (err instanceof AdvisoryLockTimeoutError) return 'skipped';
    throw err;
  }
}

/**
 * Every Outlook copy this member has of an entity, by item key: the payload's
 * per-user map first, then `calendar_mappings`. See `storedGoogleCopies` in
 * google.service.ts for why the map alone is not enough.
 */
async function storedOutlookCopies(adapter: any, entityData: any, userId: string) {
  const copies = new Map<string, { eventId: string }>();
  for (const key of getStoredOutlookKeys(adapter, entityData, userId)) {
    const eventId = adapter.getOutlookEventId(entityData, key, userId);
    if (eventId) copies.set(key, { eventId });
  }
  const { entityId } = resolver.mappingRefForEntity(adapter.entityType, entityData);
  const mapped = await calendarSyncRepo.listMappingsForEntityUser({
    provider: 'outlook', userId, entityType: adapter.entityType, entityId,
  });
  for (const mapping of mapped) {
    if (mapping?.itemKey && !copies.has(mapping.itemKey)) copies.set(mapping.itemKey, { eventId: mapping.externalEventId });
  }
  return copies;
}

async function deleteOutlookEventByKey({ adapter, entityData, userId, userData, entity, key, copy }: any) {
  const eventId = copy?.eventId || adapter.getOutlookEventId(entityData, key, userId);
  if (!eventId) return false;

  const response = await makeMicrosoftGraphCall(
    userId,
    userData,
    `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
    { method: 'DELETE' },
  );

  // Mirrors the Google twin (`deleteGoogleEventByKey`): a 404/410 on a delete
  // means Microsoft already does not have this event, which is the same end
  // state the caller wanted. Converge the mapping and writeback instead of
  // leaving them naming a dead id forever - the delete path never revisits a
  // key that has already dropped out of the current item set, so nothing else
  // would ever clean this up. Any other failure still returns false untouched.
  const gone = response.status === 404 || response.status === 410;
  if (!response.ok && !gone) {
    throw new AppError('Calendar provider rejected the event delete', 503);
  }
  if (gone) {
    console.warn(`calendar.events: Outlook event ${eventId} for ${adapter.entityType}/${key} was already gone (status ${response.status}); converging local state`);
  }

  if (typeof adapter.buildOutlookDeleteWriteback === 'function') {
    await entity.applyDescriptor(adapter.buildOutlookDeleteWriteback(key, userId));
  }
  await calendarSyncRepo.deleteMapping('outlook', eventId).catch(() => {});
  return true;
}

// ── Shared sync engine (inbound upsert, cross-sync, outbound-push stamp) ─────
// The inbound priority chain, cross-sync to Google, loop guards, and the
// subscription outbound-push stamp live ONCE in shared/providerSyncEngine.js,
// parameterized by outlookStrategy. These thin wrappers preserve the historical
// internal names used throughout this file.

const { createEngine } = require('../shared/providerSyncEngine');
const outlookStrategy = require('./outlookStrategy');
const engine = createEngine(outlookStrategy);

const stampOutboundPushForOutlook = (userId: string) => engine.stampOutboundPush(userId);
const crossSyncToGoogle = (entity: any, entityType: any, userId: string) => engine.crossSync(entity, entityType, userId);

/**
 * Create Outlook Calendar events for any entity via its adapter.
 */
export async function createEventsFromEntity(adapter: any, entityData: any, userId: string, timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.microsoftAccessToken) return null;
    if (!settings?.allowParalegixToOutlookSync) return null;

    const items = await adapter.toCalendarItems(entityData);
    if (items.length === 0) return null;

    const calendarEndpoint = await resolveCalendarEndpoint(userId, userData, settings, true);
    if (!calendarEndpoint) return null;

    const timeZoneContext = await getOutlookTimeZoneContext(userId, userData, timeZone);
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const mappingRef = resolver.mappingRefForEntity(adapter.entityType, entityData);
    const results = [];

    for (const item of items) {
      try {
        const outcome = await createOutlookEventIfMissing({
          adapter, entity, entityData, userId, userData, settings, mappingRef, item, timeZoneContext,
        });
        if (outcome?.created) {
          results.push({ key: item.key, outlookId: outcome.eventId });
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error creating Outlook event for ${adapter.entityType}/${item.key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForOutlook(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in createEventsFromEntity (${adapter.entityType}, Outlook):`, error);
    return null;
  }
}

/**
 * Update Outlook Calendar events for any entity via its adapter.
 * Creates new events for items without an outlookId, updates existing ones.
 */
export async function updateEventsFromEntity(adapter: any, entityData: any, userId: string, timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData, settings } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.microsoftAccessToken) return null;
    if (!settings?.allowParalegixToOutlookSync) return null;

    const items = await adapter.toCalendarItems(entityData);
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const mappingRef = resolver.mappingRefForEntity(adapter.entityType, entityData);
    const timeZoneContext = await getOutlookTimeZoneContext(userId, userData, timeZone);
    const results = [];
    const currentKeys = new Set(items.map((item: any) => item.key));

    const copies = await storedOutlookCopies(adapter, entityData, userId);
    for (const [storedKey, copy] of copies) {
      if (currentKeys.has(storedKey)) continue;
      try {
        const deleted = await deleteOutlookEventByKey({
          adapter,
          entityData,
          userId,
          userData,
          entity,
          key: storedKey,
          copy,
        });
        if (deleted) {
          results.push({ key: storedKey, action: 'deleted' });
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error deleting stale Outlook event for ${adapter.entityType}/${storedKey}:`, itemErr);
      }
    }

    for (const item of items) {
      try {
        const startDate = toInstant(item.dateTime);
        if (!startDate) continue;
        const endDate = item.end ? toInstant(item.end) : null;
        const fallbackTimeZone = timeZoneContext.requestTimeZone || timeZoneContext.mailboxTimeZone;
        const eventTz = resolveEventTimeZone(item.timeZone, timeZoneContext.requestTimeZone, fallbackTimeZone);
        const { sourceTimeZone: outlookTz, graphTimeZone: graphTz } =
          resolveGraphEventZone(eventTz, timeZoneContext);

        // See the matching comment in google.service.ts: the in-memory writeback
        // id is stale under concurrent saves and outbox replays; the mapping row
        // is not.
        const existingEventId = await resolveExistingOutlookEventId({
          adapter, entityData, userId, itemKey: item.key, entityId: mappingRef.entityId,
        });
        const eventData: any = {
          subject: item.summary,
          body: { contentType: 'text', content: item.description || '' },
          ...(item.allDay
            ? buildOutlookAllDayRange(startDate, endDate, graphTz)
            : buildOutlookTimedRange(startDate, endDate, outlookTz, graphTz)),
        };
        // See the matching comment in google.service.ts: a provider-owned
        // task location is left alone unless Paralegix cleared its own.
        if (item.location) eventData.location = { displayName: item.location };
        else if (existingEventId && !item.keepProviderLocation) eventData.location = { displayName: '' };
        if (item.isPrivate && item.sourceProvider !== 'outlook') eventData.sensitivity = 'private';

        if (existingEventId) {
          if (adapter.entityType === 'externalEvent' && entityData.meeting?.joinUrl) {
            const current = await makeMicrosoftGraphCall(userId, userData,
              `https://graph.microsoft.com/v1.0/me/events/${existingEventId}?$select=body,isOnlineMeeting`, { method: 'GET' });
            if (!current.ok) throw new AppError('Could not load the online meeting before updating it.', 503);
            const original = await current.json();
            const body = original.body || { contentType: 'text', content: '' };
            if (stripCalendarHeader(cleanHtmlContent(body.content)) === (entityData.notes || '')) {
              delete eventData.body;
            } else {
              const notes = String(entityData.notes || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
              const retained = String(body.content || '').replace(/<!-- paralegix-notes:start -->[\s\S]*?<!-- paralegix-notes:end -->/g, '');
              eventData.body = body.contentType.toLowerCase() === 'html'
                ? { contentType: 'html', content: `${retained}<!-- paralegix-notes:start --><p>${notes.replace(/\n/g, '<br>')}</p><!-- paralegix-notes:end -->` }
                : { contentType: 'text', content: `${retained}\n\n${entityData.notes || ''}` };
            }
          }
          const response = await makeMicrosoftGraphCall(
            userId, userData,
            `https://graph.microsoft.com/v1.0/me/events/${existingEventId}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(eventData),
            }
          );

          if (response.ok) {
            const pushed = await response.json();
            // A source meeting stays the member's own event after an edit.
            // Only copies created by Paralegix carry ownership mappings.
            if (adapter.entityType !== 'externalEvent' || await calendarSyncRepo.getMappingByExternalId(existingEventId)) {
              await calendarSyncRepo.saveMapping({
                provider: 'outlook', externalEventId: existingEventId, userId,
                lawFirmId: entityData.lawFirmId, entityType: adapter.entityType,
                entityId: mappingRef.entityId, scopeId: mappingRef.scopeId, itemKey: item.key,
                pushedVersion: pushed.changeKey, pushedModifiedAt: pushed.lastModifiedDateTime,
              });
            }
            await entity.applyDescriptor(adapter.buildOutlookUpdateWriteback(item.key, userId));
            results.push({ key: item.key, action: 'updated', outlookId: existingEventId });
          } else if (response.status === 404 || response.status === 410) {
            // See the matching branch in google.service.ts: the mapping (or the
            // stale writeback fallback) is naming an event Microsoft no longer
            // has, so a PATCH can never succeed. Drop the stale mapping and
            // create a replacement instead of failing this item forever.
            console.warn(`calendar.events: Outlook event ${existingEventId} for ${adapter.entityType}/${item.key} is gone (status ${response.status}); recreating`);
            await calendarSyncRepo.deleteMapping('outlook', existingEventId).catch(() => {});
            const event = await createOutlookEventForItem({
              adapter, entity, entityData, userId, userData, settings, mappingRef, item, eventData,
            });
            if (event) {
              results.push({ key: item.key, action: 'recreated', outlookId: event.id });
            }
          } else {
            console.error(`Failed to update Outlook event for ${adapter.entityType}/${item.key}:`, response.status);
            throw new AppError('Calendar provider rejected the event update', 503);
          }
        } else {
          // Create new event (date field was just set)
          const event = await createOutlookEventForItem({
            adapter, entity, entityData, userId, userData, settings, mappingRef, item, eventData,
          });
          if (event) {
            results.push({ key: item.key, action: 'created', outlookId: event.id });
          }
        }
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error updating Outlook event for ${adapter.entityType}/${item.key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForOutlook(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in updateEventsFromEntity (${adapter.entityType}, Outlook):`, error);
    return null;
  }
}

/**
 * Delete all Outlook Calendar events for an entity via its adapter.
 */
export async function deleteEventsFromEntity(adapter: any, entityData: any, userId: string, _timeZone?: any, preloaded?: any) {
  try {
    // Queued credentials can outlive a disconnect; read current tokens at dispatch.
    const { userData } = await calendarTokens.getUserDataAndSettings(userId);
    if (!userData?.microsoftAccessToken) return null;

    const items = await adapter.toCalendarItems(entityData);
    const entity = resolver.resolveEntity(adapter.entityType, entityData);
    const keys = new Set(items.map((item: any) => item.key));
    const copies = await storedOutlookCopies(adapter, entityData, userId);
    copies.forEach((_copy, key) => keys.add(key));
    const results = [];

    for (const key of keys) {
      try {
        const deleted = await deleteOutlookEventByKey({
          adapter,
          entityData,
          userId,
          userData,
          entity,
          key,
          copy: copies.get(key as string),
        });
        if (deleted) results.push({ key, action: 'deleted' });
      } catch (itemErr) {
        if (preloaded?.strictFailures) throw itemErr;
        console.error(`Error deleting Outlook event for ${adapter.entityType}/${key}:`, itemErr);
      }
    }

    if (results.length > 0) stampOutboundPushForOutlook(userId).catch(() => {});
    return results.length > 0 || preloaded?.strictFailures ? results : null;
  } catch (error: any) {
    if (preloaded?.strictFailures) throw error;
    console.error(`Error in deleteEventsFromEntity (${adapter.entityType}, Outlook):`, error);
    return null;
  }
}

const { getAdapter } = require('../shared/calendarAdapters');

// ── Route-Level Operations (called by outlook.routes.js) ────

/**
 * Report the caller's Outlook calendar connection from the stored grant.
 *
 * Reads only the row, except for a legacy row stored before scopes were
 * recorded: that one is resolved through one locked refresh, whose response
 * carries the granted scope, and the answer is stored for later reads.
 */
export async function checkAuth(userId: string) {
  let row = await calendarTokens.getConnectionRow(userId, 'microsoft');
  if (!row) return { error: 'No Microsoft token available', status: 400 };

  if (connectionState('microsoft', row) === 'unverified') {
    await refreshGrant('microsoft', userId, row.refresh_token);
    row = await calendarTokens.getConnectionRow(userId, 'microsoft');
  }

  return connectionReport(connectionState('microsoft', row), row?.meta?.accountEmail ?? null);
}

/**
 * Initialize Paralegix calendar for Outlook.
 */
export async function initParalegixCalendar(userId: string, timeZone: any) {
  const userData = await calendarTokens.loadUserData(userId);
  if (!userData) return { error: 'User not found', status: 404 };
  if (!userData.microsoftAccessToken) return { error: 'No Microsoft token available', status: 400 };

  const paralegixCalendar = await getOrCreateParalegixCalendar(userId, userData);
  if (!paralegixCalendar) return { error: 'Failed to get or create Paralegix calendar', status: 500 };

  return {
    success: true,
    message: 'Paralegix calendar initialized successfully',
    calendar: {
      id: paralegixCalendar.id,
      name: paralegixCalendar.name,
      color: paralegixCalendar.color,
    },
  };
}

/**
 * Get user's Outlook Calendars.
 */
export async function getCalendars(userId: string) {
  const userData = await calendarTokens.loadUserData(userId);
  if (!userData) return { error: 'User not found', status: 404 };
  if (userData.microsoftGrantLost) {
    return { error: 'Microsoft token expired. Please reconnect your Microsoft account.', status: 401 };
  }
  if (!userData.microsoftAccessToken) return { error: 'No Microsoft token available', status: 400 };

  const response = await makeMicrosoftGraphCall(userId, userData, 'https://graph.microsoft.com/v1.0/me/calendars');
  if (!response.ok) return { error: 'Failed to fetch calendars', status: 500 };

  const data = await response.json();
  const calendars = (data.value || []).map((cal: any) => ({
    id: cal.id,
    name: cal.name || cal.id,
    isDefault: cal.isDefaultCalendar || false,
    color: cal.color || '#000000',
    canEdit: cal.canEdit || false,
  }));

  return { calendars };
}

/**
 * Sync events from Outlook Calendar into Paralegix tasks.
 */
// ── Shared inbound-sync helpers ─────────────────────────────

// ── Shared inbound-sync helpers (delegated to providerSyncEngine) ───────────
// The inbound upsert priority chain, the matterEvent/clientEvent mapping
// resolution, and the cancelled/deleted reconciliation now live in
// shared/providerSyncEngine.js (parameterized by outlookStrategy). These thin
// wrappers keep the historical internal names + signatures used below.

/**
 * Inbound upsert for one Outlook event. `mappingCache` (optional) is a prefetched
 * Map<externalEventId, mappingRow> so a batch resolves all mappings in one query
 * (C3); omit it for single-event callers.
 */
function upsertExternalEventFromOutlookEvent(event: any, lawFirmId: string, userId: string, mappingCache?: any) {
  return engine.upsertExternalEvent(event, lawFirmId, userId, mappingCache);
}

/** The reconnect answer for a Microsoft grant that can no longer be used. */
function microsoftReAuthError() {
  const err: any = new AppError('No Microsoft refresh token available', 401, 'NO_REFRESH_TOKEN');
  err.requiresReAuth = true;
  return err;
}

export async function syncFromOutlook({ userId, lawFirmId }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (userData?.microsoftGrantLost) throw microsoftReAuthError();
  if (!userData?.microsoftAccessToken) {
    throw new ValidationError('No Microsoft token available');
  }

  if (!settings?.allowOutlookToParalegixSync) {
    throw new ValidationError('Outlook to Paralegix sync not enabled');
  }

  const pollWindow = fullPollWindow();
  const oneYearAgo = pollWindow.from;
  const oneYearFromNow = pollWindow.to;

  const calendarTarget = settings.outlookCalendarTarget || 'default';
  let eventsUrl;
  if (calendarTarget === 'paralegix') {
    const paralegixCal = await getOrCreateParalegixCalendar(userId, userData);
    if (!paralegixCal) {
      throw new AppError('Failed to get or create Paralegix calendar', 500);
    }
    eventsUrl = `https://graph.microsoft.com/v1.0/me/calendars/${paralegixCal.id}/calendarView?startDateTime=${oneYearAgo.toISOString()}&endDateTime=${oneYearFromNow.toISOString()}&$orderby=start/dateTime&$top=100`;
  } else {
    eventsUrl = `https://graph.microsoft.com/v1.0/me/calendar/calendarView?startDateTime=${oneYearAgo.toISOString()}&endDateTime=${oneYearFromNow.toISOString()}&$orderby=start/dateTime&$top=100`;
  }

  // Page through the full window via @odata.nextLink ($top caps each page at 100).
  // Without this a firm with >100 events in the window silently drops the overflow.
  // The page cap is a safety stop against an unbounded loop (100 pages * 100 = 10k).
  const MAX_SYNC_PAGES = 100;
  const events = [];
  let nextLink = eventsUrl;
  let pageCount = 0;

  while (nextLink && pageCount < MAX_SYNC_PAGES) {
    let response;
    try {
      response = await makeMicrosoftGraphCall(userId, userData, nextLink, { method: 'GET' });
    } catch (error: any) {
      if (error.code === 'NO_REFRESH_TOKEN' && error.requiresReAuth) throw microsoftReAuthError();
      throw error;
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new AppError('Microsoft token expired and refresh failed', 401, 'UNAUTHORIZED');
      }
      throw new AppError('Failed to fetch Outlook events', 500);
    }

    const data = await response.json();
    if (data.value) events.push(...data.value);
    nextLink = data['@odata.nextLink'] || null;
    pageCount++;
  }

  // An incomplete listing must fail, so a catch-up retry stays queued instead
  // of resolving with the events past the cap never read.
  if (nextLink) {
    throw new AppError('Outlook calendar recovery exceeded its page budget. Retry before treating it as complete.', 503);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let firstEventError: any = null;
  const listedIds = new Set<string>();

  for (const event of events) {
    // Left out of `listedIds`, so an earlier import of it is removed below.
    if (outlookStrategy.isGoneForUser(event)) continue;
    listedIds.add(event.id);
    try {
      const result = await upsertExternalEventFromOutlookEvent(event, lawFirmId, userId);
      if (result === 'created') createdCount++;
      else if (result === 'updated') updatedCount++;
    } catch (error: any) {
      console.error('Error syncing external event from Outlook:', event.id, error);
      if (!firstEventError) firstEventError = error;
    }
  }

  // The rest of the listing is imported, but the read fails so whatever ran it
  // (a catch-up retry, a manual sync) retries the event that did not land.
  if (firstEventError) throw firstEventError;

  // Imported events come from the main calendar. With the Paralegix calendar
  // targeted, this listing is a different calendar, so its absences say
  // nothing about them.
  let removedCount = 0;
  if (calendarTarget === 'default') {
    removedCount = await engine.removeUnlisted(lawFirmId, userId, listedIds, pollWindow.removable);
  }

  const syncedCount = createdCount + updatedCount;
  return {
    success: true,
    message: `Synced ${syncedCount} events from Outlook Calendar (${createdCount} created, ${updatedCount} updated, ${removedCount} removed)`,
    syncedCount,
    createdCount,
    updatedCount,
    removedCount,
  };
}

/**
 * Delete one event from Outlook Calendar by its id. The sync engine calls this
 * (`deleteOwnEvent` in the strategy) to remove a duplicate copy once one
 * meeting is found on both of a member's calendars.
 */
export async function deleteEvent({ userId, eventId }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.microsoftAccessToken) {
    throw new ValidationError('No Microsoft token available');
  }
  if (!settings?.allowParalegixToOutlookSync) {
    throw new ValidationError('Paralegix to Outlook sync not enabled');
  }

  const response = await makeMicrosoftGraphCall(
    userId, userData,
    `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
    { method: 'DELETE' }
  );

  if (!response.ok) {
    throw new AppError('Failed to delete Outlook Calendar event', 500);
  }

  return { success: true, message: 'Event deleted successfully' };
}

/**
 * Bulk sync tasks to Outlook Calendar.
 */
export async function syncTasksToOutlook({ userId, tasks, timeZone }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.microsoftAccessToken) {
    throw new ValidationError('No Microsoft token available');
  }
  if (!settings?.allowParalegixToOutlookSync) {
    throw new ValidationError('Paralegix to Outlook sync not enabled');
  }

  const calendarEndpoint = await resolveCalendarEndpoint(userId, userData, settings, true);
  if (!calendarEndpoint) {
    throw new AppError('Failed to get or create Paralegix calendar', 500);
  }

  const timeZoneContext = await getOutlookTimeZoneContext(userId, userData, timeZone);

  // Cross-tenant guard: only sync items for firms the user actually belongs to.
  const allowedFirmIds = await resolveSyncableFirmIds(userId, tasks.map((t: any) => t.lawFirmId));
  // Ethical wall: a task on a matter carries that matter's client roster into
  // the event description, so the caller must be able to read the matter.
  const mayReadMatter = matterWallFor(userId);

  let syncedCount = 0;
  const results = [];

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

      const outcome = await pushExistingItem({
        adapter: getAdapter('task'), state, userId, userData, settings, timeZoneContext,
      });
      if (outcome === 'skipped') continue;
      if (outcome) {
        syncedCount++;
        results.push({ taskId: task.taskId, success: true, eventId: outcome });
      } else {
        results.push({ taskId: task.taskId, success: false, error: 'Failed to create event' });
      }
    } catch (error: any) {
      console.error(`Error syncing task ${task.taskId} to Outlook Calendar:`, error);
      results.push({ taskId: task.taskId, success: false, error: 'Sync failed for this item' });
    }
  }

  if (syncedCount > 0) stampOutboundPushForOutlook(userId).catch(() => {});

  return {
    success: true,
    message: `Synced ${syncedCount} tasks to Outlook Calendar`,
    syncedCount,
    results,
  };
}

/**
 * Bulk sync matter and client events to Outlook Calendar.
 * events: [{ eventId, matterId | clientId, lawFirmId, title, notes, date, type }]
 */
export async function syncEventsToOutlook({ userId, events, timeZone }: any) {
  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.microsoftAccessToken) {
    throw new ValidationError('No Microsoft token available');
  }
  if (!settings?.allowParalegixToOutlookSync) {
    throw new ValidationError('Paralegix to Outlook sync not enabled');
  }

  const calendarEndpoint = await resolveCalendarEndpoint(userId, userData, settings, true);
  if (!calendarEndpoint) {
    throw new AppError('Failed to get or create Paralegix calendar', 500);
  }

  const timeZoneContext = await getOutlookTimeZoneContext(userId, userData, timeZone);

  // Cross-tenant guard: only sync items for firms the user actually belongs to.
  const allowedFirmIds = await resolveSyncableFirmIds(userId, events.map((e: any) => e.lawFirmId));
  // Ethical wall: a matter event belongs to exactly one matter, and its
  // description carries that matter's client roster.
  const mayReadMatter = matterWallFor(userId);

  let syncedCount = 0;
  const results = [];

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

      const outcome = await pushExistingItem({
        adapter: getAdapter(entityType), state, userId, userData, settings, timeZoneContext,
      });
      if (outcome === 'skipped') continue;
      if (outcome) {
        syncedCount++;
        results.push({ eventId: ev.eventId, success: true, outlookId: outcome });
      } else {
        results.push({ eventId: ev.eventId, success: false, error: 'Failed to create event' });
      }
    } catch (error: any) {
      console.error(`Error syncing event ${ev.eventId} to Outlook Calendar:`, error);
      results.push({ eventId: ev.eventId, success: false, error: 'Sync failed for this item' });
    }
  }

  if (syncedCount > 0) stampOutboundPushForOutlook(userId).catch(() => {});

  return {
    success: true,
    message: `Synced ${syncedCount} events to Outlook Calendar`,
    syncedCount,
    results,
  };
}

// ── Subscription Lifecycle (Silent Sync) ──────────────────────

const SUBSCRIPTION_MAX_MINUTES = 4230; // ~3 days, Microsoft maximum for calendar

/**
 * Resolve the Graph subscription `resource` path for the user's configured
 * sync scope, mirroring resolveCalendarEndpoint/syncFromOutlook's calendar
 * selection so silent (webhook-driven) sync watches the same calendar the
 * manual pull reads from. `/me/events` (the old constant value) spans every
 * calendar in the mailbox, not just the default one -- scoping it here stops
 * events from unrelated Outlook calendars leaking in when a user has narrowed
 * sync to their dedicated Paralegix calendar or the default calendar only.
 */
async function resolveSubscriptionResource(userId: string, userData: any, settings: any) {
  const calendarTarget = settings?.outlookCalendarTarget || 'default';
  if (calendarTarget === 'paralegix') {
    const cachedId = settings.paralegixCalendarId || settings.outlookCalendarId;
    if (cachedId) return `/me/calendars/${cachedId}/events`;
    const paralegixCal = await getOrCreateParalegixCalendar(userId, userData);
    return paralegixCal ? `/me/calendars/${paralegixCal.id}/events` : null;
  }
  return '/me/calendar/events';
}

/**
 * Create a Microsoft Graph subscription for a user's calendar events.
 * Microsoft will POST to our webhook whenever events change.
 */
export async function createSubscription({ userId, lawFirmId }: any) {
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  if (!webhookBaseUrl || !webhookBaseUrl.startsWith('https://')) {
    return null;
  }

  const { userData, settings } = await getUserDataAndSettings(userId);
  if (!userData?.microsoftAccessToken) return null;

  const resource = await resolveSubscriptionResource(userId, userData, settings);
  if (!resource) return null;

  const clientState = crypto.randomBytes(32).toString('hex');
  const expiration = new Date(Date.now() + SUBSCRIPTION_MAX_MINUTES * 60 * 1000);

  const response = await makeMicrosoftGraphCall(
    userId, userData,
    'https://graph.microsoft.com/v1.0/subscriptions',
    {
      method: 'POST',
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl: `${webhookBaseUrl}/api/webhooks/outlook-calendar`,
        // Where Graph reports reauthorizationRequired, subscriptionRemoved and
        // missed; see handleSubscriptionLifecycleEvent.
        lifecycleNotificationUrl: lifecycleNotificationUrlFor(webhookBaseUrl),
        resource,
        expirationDateTime: expiration.toISOString(),
        clientState,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('outlook.service: failed to create subscription:', response.status, errText);
    return null;
  }

  const subData = await response.json();

  await calendarSyncRepo.saveSubscription({
    subscriptionId: subData.id,
    userId,
    lawFirmId,
    resource,
    clientState,
    expiration: new Date(subData.expirationDateTime),
  });

  return { subscriptionId: subData.id, expirationDateTime: subData.expirationDateTime };
}

/**
 * Renewing and replacing one user's subscription (the renewal cron, a
 * lifecycle event, a re-point) run under one per-user lock. A replacement
 * creates the new subscription before stopping the old one, so two that
 * overlap would each leave one live. The hold covers a PATCH plus a full
 * recreate.
 */
const SUBSCRIPTION_LOCK_OPTIONS = { lockTimeoutMs: 10_000, maxHoldMs: 120_000 };
const subscriptionLockKey = (userId: string) => `outlook:${userId}`;

/** Where Graph sends a subscription's lifecycle notifications. */
const lifecycleNotificationUrlFor = (webhookBaseUrl: string) => `${webhookBaseUrl}/api/webhooks/outlook-calendar/lifecycle`;

/**
 * Point live import at the calendar the user's target setting now names.
 *
 * A Graph subscription's resource names one calendar, fixed when it is created,
 * so switching the target left notifications coming from the old calendar and
 * none from the new one. Recreated only when the user had a subscription, so
 * switching the target does not turn live import on by itself.
 */
export async function rearmSubscription(userId: string) {
  // Waits out a renewal or lifecycle replacement already in progress, then
  // reads the subscriptions as that replacement left them.
  return advisoryLock.withLock('CALENDAR_WATCH', subscriptionLockKey(userId), async () => {
    const existing = await calendarSyncRepo.findSubscriptionForUser(userId);
    if (!existing) return null;
    const oldSubscriptions = await calendarSyncRepo.listSubscriptionsForUser(userId);
    const replacement = await createSubscription({ userId, lawFirmId: existing.lawFirmId });
    if (!replacement) throw new AppError('Could not replace the calendar subscription. Retry enabling sync.', 503);
    for (const subscription of oldSubscriptions) await stopSubscription(subscription.id);
    return replacement;
  }, SUBSCRIPTION_LOCK_OPTIONS);
}

const normalizeResource = (resource: string) => resource.replace(/^\//, '').toLowerCase();

/**
 * Whether a stored subscription watches a calendar other than the one the
 * user's target setting now names. False when either side is unknown.
 */
async function subscriptionIsStale(subData: any, userData: any, settings: any) {
  if (!subData?.resource || !userData?.microsoftAccessToken) return false;
  const expected = await resolveSubscriptionResource(subData.userId, userData, settings);
  if (!expected) return false;
  return normalizeResource(expected) !== normalizeResource(subData.resource);
}

/**
 * Move a subscription left on the old calendar to the current target.
 *
 * One created before the target changed (or before a target change re-pointed
 * it) still watches the old calendar, and renewal extends it in place, so it
 * would stay there: importing events from a calendar the user no longer syncs,
 * and never hearing about the one they do. Re-points it and catches up on the
 * target calendar with a full read. Returns true when it did, so the caller
 * drops the notification, which came from the old calendar.
 */
export async function repointStaleSubscription(subData: any, preloaded?: any) {
  const { userData, settings } = preloaded || await getUserDataAndSettings(subData.userId);
  if (!(await subscriptionIsStale(subData, userData, settings))) return false;
  await rearmSubscription(subData.userId);
  if (settings?.allowOutlookToParalegixSync) {
    await syncFromOutlook({ userId: subData.userId, lawFirmId: subData.lawFirmId });
  }
  return true;
}

/**
 * Stop (delete) a Microsoft Graph subscription.
 *
 * Teardown tries whatever token the row holds, usable for sync or not. A
 * disconnect that has already replaced the row passes the old connection's
 * credentials, captured before the write.
 */
export async function stopSubscription(subscriptionId: any, { credentials }: { credentials?: any } = {}) {
  const subData = await calendarSyncRepo.getSubscription(subscriptionId);
  if (!subData) return;

  const userData = credentials
    || await calendarTokens.loadUserData(subData.userId, { includeUnusableGrants: true });

  if (userData?.microsoftAccessToken) {
    try {
      await makeMicrosoftGraphCall(
        subData.userId, userData,
        `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
        { method: 'DELETE' }
      );
    } catch (err: any) {
      // Subscription may have already expired
      console.warn('outlook.service: error stopping subscription:', err.message);
    }
  }

  await calendarSyncRepo.deleteSubscription(subscriptionId);
}

/**
 * Stop all subscriptions for a user (used when disconnecting Microsoft).
 */
export async function stopAllSubscriptions(userId: string, { credentials }: { credentials?: any } = {}) {
  const subs = await calendarSyncRepo.listSubscriptionsForUser(userId);
  for (const sub of subs) {
    await stopSubscription(sub.id, { credentials });
  }
}

/**
 * Stop every Graph subscription a firm owns (used when the firm is deleted).
 *
 * Must run BEFORE the law_firms row is deleted: the subscription rows cascade
 * with the firm, and the Graph DELETE needs the subscription id they hold.
 * Otherwise Microsoft keeps posting change notifications for a firm that no
 * longer exists until the subscription lapses.
 *
 * Failures are logged per subscription so one bad row doesn't strand the others.
 */
export async function stopSubscriptionsForLawFirm(lawFirmId: string) {
  const subs = await calendarSyncRepo.listSubscriptionsForLawFirm(lawFirmId);
  for (const sub of subs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await stopSubscription(sub.id);
    } catch (err: any) {
      console.error('outlook.service: failed to stop subscription', sub.id, err.message);
    }
  }
  return subs.length;
}

/**
 * Create a subscription to take over from `data`, then stop `data`. The old
 * one is stopped only once the replacement is stored: when the create fails,
 * the old subscription stays recorded and keeps delivering until it lapses,
 * and the next renewal pass tries again. Returns whether it was replaced.
 */
async function replaceSubscription(data: any) {
  const replacement = await createSubscription({ userId: data.userId, lawFirmId: data.lawFirmId });
  if (!replacement) return false;
  await stopSubscription(data.id);
  return true;
}

/**
 * Extend one subscription's expiry at Graph, which also reauthorizes it, or
 * replace it when Graph refuses. Call under the subscription lock.
 */
async function renewSubscription(data: any): Promise<'renewed' | 'failed'> {
  const { userData, settings } = await getUserDataAndSettings(data.userId);
  if (!userData?.microsoftAccessToken) return 'failed';

  // A PATCH keeps the resource, so a subscription on a calendar the user no
  // longer targets is recreated on the right one instead of extended.
  if (await subscriptionIsStale(data, userData, settings)) {
    return (await replaceSubscription(data)) ? 'renewed' : 'failed';
  }

  const newExpiration = new Date(Date.now() + SUBSCRIPTION_MAX_MINUTES * 60 * 1000);
  const response = await makeMicrosoftGraphCall(
    data.userId, userData,
    `https://graph.microsoft.com/v1.0/subscriptions/${data.subscriptionId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        expirationDateTime: newExpiration.toISOString(),
      }),
    }
  );

  if (response.ok) {
    await calendarSyncRepo.updateSubscriptionExpiration(data.id, newExpiration);
    // Graph cannot add a lifecycle url with a PATCH, and its reply is the whole
    // subscription. One created without the url (before the lifecycle route
    // existed, or under another webhook base) is recreated so it gets one.
    // The PATCH has already extended it, so a refused recreate still leaves it
    // live and renewed, and the next renewal tries again.
    const renewedSub = await response.json().catch(() => null);
    const expected = lifecycleNotificationUrlFor(process.env.WEBHOOK_BASE_URL || '');
    if (renewedSub?.lifecycleNotificationUrl !== expected) {
      console.warn('outlook.service: subscription has no lifecycle url, recreating it for user', data.userId);
      await replaceSubscription(data);
    }
    return 'renewed';
  }
  // The subscription may already be gone at Microsoft (expired, or the
  // resource it watched was deleted), but a PATCH also fails for reasons
  // that leave it very much alive there (a transient 5xx, a permission
  // hiccup). The replacement makes a best-effort Graph DELETE of the old
  // one, so a still-live subscription is told to stop instead of being
  // abandoned to push at an id nothing can resolve.
  console.warn('outlook.service: PATCH renewal failed, recreating subscription for user', data.userId);
  return (await replaceSubscription(data)) ? 'renewed' : 'failed';
}

/**
 * Queue a full read of the user's calendar for the calendar-watch cron. It
 * coalesces with any other catch-up already queued for the user.
 */
async function queueCatchUp(subData: any) {
  await calendarSyncRepo.recordWebhookFailure({
    provider: 'outlook', userId: subData.userId, lawFirmId: subData.lawFirmId,
    changeType: 'catch_up', eventId: 'reconnect', pending: true,
  });
}

/**
 * Act on a Graph lifecycle notification for a verified subscription.
 *
 *   reauthorizationRequired  Graph stops delivering unless the subscription is
 *                            renewed, possibly well before its expiry. A renewal
 *                            reauthorizes it.
 *   subscriptionRemoved      Graph has deleted it. A new one is created, and the
 *                            calendar is read in full for what changed meanwhile.
 *   missed                   Graph dropped change notifications. Only a full
 *                            read recovers them; the subscription is fine.
 *
 * Returns what was done. Anything else is ignored.
 */
export async function handleSubscriptionLifecycleEvent(subData: any, lifecycleEvent: string) {
  if (lifecycleEvent === 'missed') {
    await queueCatchUp(subData);
    return 'queued';
  }
  if (lifecycleEvent !== 'reauthorizationRequired' && lifecycleEvent !== 'subscriptionRemoved') {
    return 'ignored';
  }
  // Queued before the recreate, so a recreate that fails or is cut off still
  // leaves the gap to be read.
  if (lifecycleEvent === 'subscriptionRemoved') await queueCatchUp(subData);
  return advisoryLock.withLock('CALENDAR_WATCH', subscriptionLockKey(subData.userId), async () => {
    // A renewal or an earlier delivery of this event may have replaced it.
    if (!(await calendarSyncRepo.getSubscription(subData.id))) return 'gone';
    if (lifecycleEvent === 'reauthorizationRequired') return renewSubscription(subData);
    return (await replaceSubscription(subData)) ? 'recreated' : 'failed';
  }, SUBSCRIPTION_LOCK_OPTIONS);
}

/**
 * Renew subscriptions that expire within the next 24 hours.
 * Microsoft supports PATCH to extend expiration (no stop+create needed).
 *
 * `deadline` (epoch ms, shared across the cron request) bounds the walk by wall
 * clock: each subscription costs at least one serial Graph round trip, and a
 * recreate costs several. A subscription not reached is still inside the
 * 24-hour window next run, so stopping early defers work rather than losing it.
 */
export async function renewExpiringSubscriptions({ deadline = null }: any = {}) {
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const subs = await calendarSyncRepo.listExpiringSubscriptions(cutoff);

  let renewed = 0;
  let failed = 0;
  let processed = 0;

  for (const data of subs) {
    if (deadline && Date.now() >= deadline) break;
    // Counted on reaching it, whatever the outcome, so `truncated` means only
    // that the deadline left due subscriptions unreached.
    processed++;
    try {
      // A lifecycle event already replacing or renewing this user's
      // subscription is left to finish; anything it leaves due is renewed on
      // the next run.
      const outcome = await advisoryLock.tryLock('CALENDAR_WATCH', subscriptionLockKey(data.userId), async () => {
        // The listing above may predate a replacement that finished before this
        // pass took the lock. That replacement deleted this row.
        if (!(await calendarSyncRepo.getSubscription(data.id))) return 'gone';
        return renewSubscription(data);
      }, { maxHoldMs: SUBSCRIPTION_LOCK_OPTIONS.maxHoldMs });
      if (outcome.acquired && outcome.result === 'renewed') renewed++;
      else if (outcome.acquired && outcome.result === 'failed') failed++;
    } catch (err: any) {
      console.error(`outlook.service: failed to renew subscription for user ${data.userId}:`, err.message);
      failed++;
    }
  }

  const truncated = processed < subs.length;
  if (truncated) {
    console.warn(
      `outlook.service: renewal budget exhausted after ${processed}/${subs.length} subscriptions; ` +
      'the rest stay due and are retried on the next run'
    );
  }
  return { renewed, failed, truncated };
}

// ── Notification Processing ───────────────────────────────────

/**
 * Process a subscription notification: fetch the changed event and sync to Paralegix.
 */

/**
 * Bring one repeating Outlook event in as its occurrences.
 *
 * Graph notifies about a repeating event through its series master, which
 * carries only the first date. Imported as-is it became one event on the first
 * date, which the full poll (a calendarView, listing occurrences) then
 * duplicated. This lists the occurrences instead, imports each, removes a master
 * imported the old way, and removes occurrences of this series (by their
 * series_event_id) that no longer exist in the range read. A master that is a
 * copy Paralegix pushed stays linked to its item.
 */
async function syncOutlookSeries({ userId, userData, lawFirmId, seriesId }: any) {
  const now = Date.now();
  const { from, to } = seriesWindow(now);
  const range = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '100' });
  let nextLink: string | null = `https://graph.microsoft.com/v1.0/me/events/${seriesId}/instances?${range}`;
  let pages = 0;
  const instances: any[] = [];
  while (nextLink && pages < MAX_SERIES_PAGES) {
    const response: any = await makeMicrosoftGraphCall(userId, userData, nextLink, { method: 'GET' });
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) return;
      const err: any = new AppError(`Outlook series read failed: ${response.status}`, response.status);
      err.retryable = response.status === 429 || response.status >= 500;
      throw err;
    }
    const data: any = await response.json();
    instances.push(...(data.value || []));
    nextLink = data['@odata.nextLink'] || null;
    pages++;
  }

  const listed = new Set<string>();
  for (const instance of instances) {
    if (outlookStrategy.isGoneForUser(instance)) continue;
    listed.add(instance.id);
    await upsertExternalEventFromOutlookEvent(instance, lawFirmId, userId);
  }
  await engine.removeImportedSeriesParent(seriesId, lawFirmId, userId, null);
  // Occurrences of this series that no longer exist in the range read. Only
  // after a complete read: a truncated one would read as deletions.
  if (!nextLink) {
    await engine.removeUnlisted(lawFirmId, userId, listed, { from, to, seriesEventId: seriesId });
  }
}

export async function processSubscriptionNotification({ userId, lawFirmId, changeType, resource, resourceData, preloaded, mappingCache }: any) {
  try {
    // C3: tokens/settings may be loaded once per notification batch and threaded
    // in, so multiple notifications for the same user don't each reload them.
    const { userData, settings } = preloaded || await getUserDataAndSettings(userId);
    if (!userData?.microsoftAccessToken) return;
    if (!settings?.allowOutlookToParalegixSync) return;

    // Extract event ID from resource path (e.g. "me/events/AAMk...")
    // or from resourceData.id
    const eventId = resourceData?.id || resource?.split('/')?.pop();
    if (!eventId) return;

    if (changeType === 'deleted') {
      // Shared external-event -> task -> mapping reconciliation (cross-deletes
      // the sibling provider before removing locally). The same prefetched
      // mappingCache the caller may thread (e.g. retry path) is forwarded for
      // consistency with Google's delta loop; Graph normally delivers one event
      // per notification, so it is usually empty and the engine falls back to a
      // single getMappingByExternalId lookup.
      await engine.processInboundDelete(eventId, lawFirmId, userId, mappingCache);
      // When the deleted event is a series master, its imported occurrences
      // name it in series_event_id. For anything else this matches nothing.
      await engine.removeUnlisted(lawFirmId, userId, new Set(), { seriesEventId: eventId });
      return;
    }

    // For created/updated: fetch the full event details
    const response = await makeMicrosoftGraphCall(
      userId, userData,
      `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      // Classify like the Google side so the retry sweep only retries what a retry
      // can actually fix:
      //  - 404/410: the event is gone (deleted between the notification and our
      //    fetch). Legitimate skip: nothing to upsert.
      //  - 401/403: TERMINAL auth failure (token refresh failed / permission
      //    revoked). Retrying can't help until the user re-authenticates, so do
      //    NOT record a retryable failure. That would burn the whole retry budget
      //    (~8 attempts over ~2h) on a dead token and coalesce all of this user's
      //    webhook processing onto the stalled row.
      //  - 429/5xx: TRANSIENT. Throw retryable so the webhook route persists a
      //    durable retry (the retry re-fetches the event by id, idempotently).
      //  - other 4xx: terminal. Skip.
      if (response.status === 404 || response.status === 410) {
        console.warn(`outlook.service: event ${eventId} gone on fetch (${response.status}); skipping upsert.`);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        console.warn(`outlook.service: event ${eventId} fetch auth failure (${response.status}); terminal: not retrying until re-auth.`);
        return;
      }
      if (response.status === 429 || response.status >= 500) {
        const err: any = new AppError(`Outlook event fetch failed: ${response.status}`, response.status);
        err.retryable = true;
        throw err;
      }
      console.warn(`outlook.service: event ${eventId} fetch failed (${response.status}); terminal: skipping.`);
      return;
    }

    const event = await response.json();
    // A meeting its organizer cancelled stays in an attendee's calendar with
    // isCancelled set and arrives as `updated`, not `deleted` (and a declined
    // one can stay too). Treat it as the delete it is rather than importing or
    // keeping it as a live event.
    if (outlookStrategy.isGoneForUser(event)) {
      await engine.processInboundDelete(eventId, lawFirmId, userId, mappingCache);
      if (outlookStrategy.isRecurringSeries(event)) {
        await engine.removeUnlisted(lawFirmId, userId, new Set(), { seriesEventId: eventId });
      }
      return;
    }
    if (outlookStrategy.isRecurringSeries(event)) {
      await syncOutlookSeries({ userId, userData, lawFirmId, seriesId: eventId });
      return;
    }
    await upsertExternalEventFromOutlookEvent(event, lawFirmId, userId);
  } catch (error: any) {
    // Terminal auth errors (no refresh token / re-auth required) thrown by
    // makeMicrosoftGraphCall can't be fixed by retrying. Log and swallow so the
    // retry sweep doesn't cycle on a dead token until the user re-authenticates.
    if (error && (error.requiresReAuth === true || error.code === 'NO_REFRESH_TOKEN')) {
      console.warn('outlook.service: processSubscriptionNotification needs re-auth; terminal: not retrying:', error.message);
      return;
    }
    console.error('outlook.service: processSubscriptionNotification failed:', error);
    // Re-throw transient errors so the webhook route can persist a durable retry
    // instead of dropping the change (the retry re-fetches the event idempotently).
    throw error;
  }
}

export const _buildOutlookAllDayRange = buildOutlookAllDayRange;
export const _buildOutlookTimedRange = buildOutlookTimedRange;
export const _formatDateForTz = zonedWallClock;
