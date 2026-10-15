/**
 * Google provider strategy for the shared providerSyncEngine.
 *
 * Supplies the Google-specific seams (field accessors, writeback builders, the
 * cross-delete sibling ids, the watch-channel stamp target, billing sync) so the
 * inbound upsert / cross-sync / loop-guard logic can live once in
 * shared/providerSyncEngine.js. Outbound event-body building, calendar
 * resolution, timezone handling and the watch-channel lifecycle stay in
 * google.service.js (they diverge meaningfully from Outlook and are not shared).
 */

const calendarEventsRepo = require('../calendarEvents.repository');
const { dayAnchor } = require('../../../shared/utils/time');
const { startDayIn } = require('../shared/calendarTime');
const calendarTokens = require('../shared/calendarTokens');
const calendarSyncRepo = require('../shared/calendarSync.repository');
const tasksRepo = require('../../tasks/tasks.repository');
const membersRepo = require('../../lawfirms/members/members.repository');
const rolesService = require('../../lawfirms/roles/roles.service');
const { hasPermission } = require('../../lawfirms/roles/permissions');
const invoicesService = require('../../billing/invoices/invoices.service');
const { findBillingSyncItemKey } = require('../../billing/shared/billingCalendar');
const { stripCalendarHeader, cleanHtmlContent, normalizeICalUid, makeGoogleApiCall, getUserDataAndSettings } = require('../shared/calendarHelpers');

// ── inbound update-data builders ─────────────────────────────────────────────

/**
 * Whether this is the whole event rather than a deletion stub. Google leaves
 * an empty field out of the resource altogether, so a description or location
 * missing from a whole event was cleared, not left unreported.
 */
function isFullResource(event: any) {
  return Boolean(event.start) && event.status !== 'cancelled';
}

// The description as the item's own text, or undefined when the event says
// nothing about it. `entityType` names what the mapping says was pushed, for
// a description whose Paralegix marker the member deleted.
function inboundDescription(event: any, entityType: string | null) {
  if (event.description === undefined && !isFullResource(event)) return undefined;
  return stripCalendarHeader(cleanHtmlContent(event.description || ''), entityType);
}

function inboundLocation(event: any) {
  if (event.location === undefined && !isFullResource(event)) return undefined;
  return event.location || null;
}

function buildTaskUpdateData(event: any, existingTitle: any, entityType: string | null = null) {
  const updateData: any = {
    title: event.summary || existingTitle,
    // Google all-day events carry start.date (a date string) instead of
    // start.dateTime; capture that so the flag round-trips on the next push.
    allDay: Boolean(event.start?.date),
  };
  if (event.start?.dateTime || event.start?.date) {
    updateData.dueDate = getEventTimestamp(event.start);
  }
  const description = inboundDescription(event, entityType);
  if (description !== undefined) updateData.description = description;
  if (event.updated) {
    updateData.googleLastModified = new Date(event.updated);
  }
  return updateData;
}

function buildMappedEventUpdateData(event: any, existingTitle: any, entityType: string | null = null) {
  const updateData: any = {
    title: event.summary || existingTitle,
    // Google all-day events carry start.date instead of start.dateTime.
    allDay: Boolean(event.start?.date),
  };
  if (event.start?.dateTime || event.start?.date) {
    updateData.date = getEventTimestamp(event.start);
  }
  const notes = inboundDescription(event, entityType);
  if (notes !== undefined) updateData.notes = notes;
  // The provider's single location string. The engine decides which column
  // it belongs in, since that depends on what the push derived it from.
  const location = inboundLocation(event);
  if (location !== undefined) updateData.location = location;
  return updateData;
}

/**
 * The zones a timed event's start and end are labelled with, in that order.
 * An all-day event has none.
 */
function getEventZones(event: any) {
  if (!event.start?.dateTime) return [];
  return [event.start.timeZone || null, event.end?.timeZone || null];
}

/**
 * Read one event as the member's own calendar has it. `status` is the
 * provider's answer; `event` is set only when it answered with the event.
 */
async function fetchEvent(userId: string, eventId: string, calendarId?: string | null) {
  const { userData } = await getUserDataAndSettings(userId);
  if (!userData?.googleAccessToken) throw new Error('No Google connection for this member');
  const response = await makeGoogleApiCall(
    userId, userData,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || 'primary')}/events/${encodeURIComponent(eventId)}`,
    { method: 'GET' },
  );
  return { status: response.status, event: response.ok ? await response.json() : null };
}

// A Google start or end as an instant: `dateTime` carries its own offset, and
// an all-day `date` takes the day anchor.
function getEventTimestamp(eventPart: any) {
  if (!eventPart) return null;
  if (eventPart.dateTime) return new Date(eventPart.dateTime);
  if (eventPart.date) return dayAnchor(eventPart.date);
  return null;
}

function buildExternalEventData(event: any, existingTitle?: any) {
  const start = getEventTimestamp(event.start);
  const end = getEventTimestamp(event.end);
  return {
    title: event.summary || existingTitle || 'Untitled Event',
    description: stripCalendarHeader(cleanHtmlContent(event.description)),
    notes: stripCalendarHeader(cleanHtmlContent(event.description)),
    location: event.location || null,
    start: start || null,
    end: end || null,
    allDay: Boolean(event.start?.date),
    // Left undefined (not written) when absent, so an update never erases it.
    startTimeZone: event.start?.timeZone || undefined,
    meeting: {
      organizer: event.organizer || null,
      attendees: (event.attendees || []).map((person: any) => ({
        email: person.email, displayName: person.displayName || null,
        responseStatus: person.responseStatus || 'needsAction', isSelf: person.self === true,
      })),
      responseStatus: event.attendees?.find((person: any) => person.self)?.responseStatus || null,
      status: event.status || 'confirmed', isPrivate: event.visibility === 'private',
      isOrganizer: event.organizer?.self === true,
      joinUrl: event.hangoutLink || event.conferenceData?.entryPoints?.find((point: any) => point.entryPointType === 'video')?.uri || null,
      providerUrl: event.htmlLink || null, version: event.etag || null,
    },
    icalUid: normalizeICalUid(event.iCalUID) ?? undefined,
    seriesEventId: event.recurringEventId || undefined,
  };
}

function applyExternalLastModified(updateData: any, event: any) {
  if (event.updated) {
    updateData.googleLastModified = new Date(event.updated);
  }
}

function buildNewExternalEventData(event: any, userId: string) {
  // A new external event needs a start it can be placed at; without one it is
  // skipped (the engine treats null as 'skipped').
  const start = getEventTimestamp(event.start);
  if (!start || Number.isNaN(start.getTime())) return null;
  return {
    ...buildExternalEventData(event),
    provider: 'google',
    externalEventId: event.id,
    googleEventId: event.id,
    // No source-calendar id is available on the raw event in this scope, so
    // default to 'primary'. (The organizer email is NOT a calendar id. Only
    // coincidentally equal for an organizer's own primary calendar.)
    calendarId: 'primary',
    googleLastModified: event.updated ? new Date(event.updated) : null,
    createdBy: userId,
    source: 'external',
  };
}

// ── what does not belong on the Paralegix calendar ───────────────────────────
// Google lists every entry type unless asked not to. A working-location marker
// ("Home" / "Office", often one per day) and a contact's birthday are not
// appointments; out-of-office blocks, focus time and the events Gmail adds
// (flights, reservations) are, and stay.
const NON_APPOINTMENT_TYPES = new Set(['workingLocation', 'birthday']);

/**
 * True when this event is not, or is no longer, something on the user's
 * calendar: cancelled, an invitation the user declined (Google keeps those,
 * marked on the user's own attendee entry), or a non-appointment entry type.
 * Every inbound path treats it as a delete, so an earlier import is removed.
 */
function isGoneForUser(event: any) {
  if (event.status === 'cancelled') return true;
  if (NON_APPOINTMENT_TYPES.has(event.eventType)) return true;
  const self = Array.isArray(event.attendees) ? event.attendees.find((a: any) => a?.self) : null;
  return self?.responseStatus === 'declined';
}

// ── billing inbound (moved verbatim from google.service) ─────────────────────

// The day an invoice date takes from its event: an all-day event's own day,
// else the local day of the timed start, in the event's zone or the member's.
async function getBillingScheduledDate(event: any, userId: string) {
  if (event.start?.date) return event.start.date;
  if (event.start?.dateTime) {
    const parsed = new Date(event.start.dateTime);
    if (Number.isNaN(parsed.getTime())) return null;
    const memberZone = (await calendarTokens.getSettings(userId).catch(() => null))?.timezone;
    return startDayIn(parsed, [event.start.timeZone, memberZone]);
  }
  return null;
}

async function syncBillingEvent(event: any, mappingRecord: any, lawFirmId: string, userId: string) {
  const invoiceData = mappingRecord?.data;
  if (!invoiceData) return 'skipped';

  const member = await membersRepo.findByUserId(lawFirmId, userId);
  const memberData = member ? { userId, ...member } : { userId, isOwner: true };
  const permissions = await rolesService.resolvePermissions(lawFirmId, memberData).catch(() => []);
  if (!hasPermission({ isOwner: memberData.isOwner, resolvedPermissions: permissions }, 'billing.viewInvoices')) return 'skipped';

  const billingItemKey = mappingRecord.itemKey
    || findBillingSyncItemKey(invoiceData, 'google', userId, event.id);
  const scheduledDate = await getBillingScheduledDate(event, userId);

  if (!billingItemKey || !scheduledDate) return 'skipped';

  await invoicesService.applyBillingCalendarSyncUpdate({
    lawFirmId,
    invoice: invoiceData,
    billingItemKey,
    scheduledDate,
    actingUserId: userId,
    provider: 'google',
    modifiedAt: event.updated || null,
  });

  return 'updated';
}

const googleStrategy = {
  provider: 'google',
  otherProvider: 'outlook',

  getServiceModule() { return require('./google.service'); },
  getOtherServiceModule() { return require('../outlook/outlook.service'); },

  // field accessors
  getEventId(event: any) { return event.id; },
  getEventModified(event: any) { return event.updated ? new Date(event.updated) : null; },
  isGoneForUser,
  // A series parent carries the repeat rule; its occurrences carry the
  // parent's id in `recurringEventId`.
  isRecurringSeries(event: any) { return Array.isArray(event.recurrence) && event.recurrence.length > 0; },
  isRecurringInstance(event: any) { return Boolean(event.recurringEventId); },
  getICalUid(event: any) { return normalizeICalUid(event.iCalUID); },
  // This provider's id on an imported row, and the fields that link a row
  // imported from Outlook to the same meeting's own copy on Google.
  getProviderIdOnRow(row: any) { return row.googleEventId || null; },
  buildTwinLink(event: any) {
    return { googleEventId: event.id, googleLastModified: event.updated ? new Date(event.updated) : null };
  },
  buildUnlink() { return { googleEventId: null, googleLastModified: null }; },
  deleteOwnEvent(userId: string, eventId: string) { return require('./google.service').deleteEvent({ userId, eventId }); },
  // The end instant of a timed event, or null for an all-day one (whose end is
  // a calendar day, not an instant).
  getEventEnd(event: any) {
    if (!event.end?.dateTime) return null;
    const end = new Date(event.end.dateTime);
    return Number.isNaN(end.getTime()) ? null : end;
  },
  // An all-day event's exclusive end day (Google's `end.date`) at its noon-UTC
  // anchor, the shape an all-day end is stored in; null for a timed event.
  getAllDayEnd(event: any) {
    return event.end?.date ? dayAnchor(event.end.date) : null;
  },
  getOriginatedBodyText(event: any) { return event.description; },
  getEventZones,
  fetchEvent,

  lastSyncedField: 'lastSyncedToGoogle',
  lastModifiedField: 'googleLastModified',
  otherLastModifiedField: 'outlookLastModified',
  externalIdPrefix: 'google_',

  // resolution helpers
  findTaskIdByEventId(lawFirmId: string, eventId: string) { return tasksRepo.findIdByGoogleEventId(lawFirmId, eventId); },
  findExternalByEventId(lawFirmId: string, eventId: string, userId: string) { return calendarEventsRepo.findByGoogleEventId(lawFirmId, eventId, userId); },

  // sibling ids used for cross-delete (Outlook side)
  getExternalProviderId(externalRow: any) { return externalRow.outlookId; },
  getTaskProviderId(taskData: any) { return taskData.outlookId; },

  // for cross-sync: does the sibling (Outlook) already have this entity?
  getSiblingAdapterEventId(adapter: any, data: any, items: any, userId: string) {
    return items.length > 0 && adapter.getOutlookEventId(data, items[0].key, userId);
  },

  // the writeback that drops one member's event for one item of an entity
  buildDeleteWriteback(adapter: any, key: any, userId: string) { return adapter.buildGoogleDeleteWriteback(key, userId); },

  // inbound builders
  buildTaskUpdateData,
  buildMappedEventUpdateData,
  buildExternalEventData,
  applyExternalLastModified,
  buildNewExternalEventData,

  // billing
  syncBillingEvent,

  // outbound-push stamp target (calendar_subscriptions)
  findWatchEntityForUser(userId: string) { return calendarSyncRepo.findWatchChannelForUser(userId); },
  stampWatchEntity(id: any) { return calendarSyncRepo.stampWatchChannelOutboundPush(id); },
};

export = googleStrategy;
