/**
 * Outlook (Microsoft Graph) provider strategy for the shared providerSyncEngine.
 *
 * Mirror of googleStrategy.js: supplies the Graph-specific field accessors,
 * writeback builders, cross-delete sibling ids, subscription stamp target and
 * billing sync. Graph date parsing and the Windows<->IANA zone names come from
 * outlookTime.ts; the mailbox zone, outbound event-body building, calendar
 * endpoint resolution and the subscription lifecycle stay in outlook.service.
 */

const calendarEventsRepo = require('../calendarEvents.repository');
const calendarSyncRepo = require('../shared/calendarSync.repository');
const tasksRepo = require('../../tasks/tasks.repository');
const membersRepo = require('../../lawfirms/members/members.repository');
const rolesService = require('../../lawfirms/roles/roles.service');
const { hasPermission } = require('../../lawfirms/roles/permissions');
const invoicesService = require('../../billing/invoices/invoices.service');
const { findBillingSyncItemKey } = require('../../billing/shared/billingCalendar');
const { stripCalendarHeader, cleanHtmlContent, normalizeICalUid, makeMicrosoftGraphCall, getUserDataAndSettings } = require('../shared/calendarHelpers');
const { dayAnchor } = require('../../../shared/utils/time');
const { startDayIn } = require('../shared/calendarTime');
const calendarTokens = require('../shared/calendarTokens');
const { parseOutlookDateTime, parseOutlookDueDate, normalizeIanaTimeZone } = require('./outlookTime');

function parseDueDate(event: any) {
  return parseOutlookDueDate(event);
}

// The end instant of a timed event, or null for an all-day one (whose end is a
// calendar day, not an instant) or an end that does not parse.
function getEventEnd(event: any) {
  if (event.isAllDay) return null;
  const end = parseOutlookDateTime(event.end?.dateTime, event.end?.timeZone);
  return end && !Number.isNaN(end.getTime()) ? end : null;
}

// An all-day event's exclusive end day at its noon-UTC anchor, the shape an
// all-day end is stored in; null for a timed event. Graph sends an all-day end
// as midnight of the day after the last day.
function getAllDayEnd(event: any) {
  if (!event.isAllDay) return null;
  const day = String(event.end?.dateTime || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayAnchor(day) : null;
}

// ── inbound update-data builders ─────────────────────────────────────────────

function buildTaskUpdateData(event: any, existingTitle: any, entityType: string | null = null) {
  const parsedDueDate = parseDueDate(event);
  const updateData: any = {
    title: event.subject || existingTitle,
    // Outlook flags all-day events with isAllDay; capture it so the flag
    // round-trips on the next outbound push.
    allDay: Boolean(event.isAllDay),
  };
  if (parsedDueDate && !Number.isNaN(parsedDueDate.getTime())) {
    updateData.dueDate = parsedDueDate;
  }
  if (event.body?.content !== undefined) {
    updateData.description = stripCalendarHeader(cleanHtmlContent(event.body.content || ''), entityType);
  }
  if (event.changeKey) {
    updateData.outlookChangeKey = event.changeKey;
  }
  if (event.lastModifiedDateTime) {
    updateData.outlookLastModified = new Date(event.lastModifiedDateTime);
  }
  updateData.outlookId = event.id;
  return updateData;
}

function buildMappedEventUpdateData(event: any, existingTitle: any, entityType: string | null = null) {
  const parsedDueDate = parseDueDate(event);
  const updateData: any = {
    title: event.subject || existingTitle,
    // Outlook flags all-day events with isAllDay.
    allDay: Boolean(event.isAllDay),
  };
  if (parsedDueDate && !Number.isNaN(parsedDueDate.getTime())) {
    updateData.date = parsedDueDate;
  }
  if (event.body?.content !== undefined) {
    updateData.notes = stripCalendarHeader(cleanHtmlContent(event.body.content || ''), entityType);
  }
  if (event.changeKey) {
    updateData.outlookChangeKey = event.changeKey;
  }
  // The provider's single location string. The engine decides which column
  // it belongs in, since that depends on what the push derived it from.
  if (event.location !== undefined) updateData.location = event.location?.displayName || null;
  updateData.outlookId = event.id;
  return updateData;
}

/**
 * The zones a timed event's start and end are in, in that order, as IANA
 * names. Graph's `start.timeZone` / `end.timeZone` are the zone the response
 * was rendered in, so the event's own `originalStartTimeZone` /
 * `originalEndTimeZone` are read whenever Graph sent them. All-day has none.
 */
function getEventZones(event: any) {
  if (event.isAllDay) return [];
  const original = Boolean(event.originalStartTimeZone || event.originalEndTimeZone);
  const start = original ? event.originalStartTimeZone : event.start?.timeZone;
  const end = original ? event.originalEndTimeZone : event.end?.timeZone;
  return [start ? normalizeIanaTimeZone(start) : null, end ? normalizeIanaTimeZone(end) : null];
}

/**
 * Read one event from the member's own mailbox. `status` is Graph's answer;
 * `event` is set only when it answered with the event.
 */
async function fetchEvent(userId: string, eventId: string) {
  const { userData } = await getUserDataAndSettings(userId);
  if (!userData?.microsoftAccessToken) throw new Error('No Microsoft connection for this member');
  const response = await makeMicrosoftGraphCall(
    userId, userData, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, { method: 'GET' },
  );
  return { status: response.status, event: response.ok ? await response.json() : null };
}

function getEventDate(eventPart: any, isAllDay = false) {
  if (!eventPart) return null;
  // For an all-day event, anchor the calendar day to noon-UTC. Consistent with
  // parseOutlookDueDate's all-day start handling. The Graph all-day datetime is
  // an offset-less local string (e.g. "2026-06-14T00:00:00.0000000"); a plain
  // new Date() would interpret it in the SERVER timezone and shift the day.
  if (isAllDay) {
    const dateStr = String(eventPart.dateTime || eventPart.date || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dayAnchor(dateStr) : null;
  }
  // Graph sends an offset-less wall-clock string plus the zone it is in. A bare
  // new Date() reads it in the SERVER's zone, which is right only when both
  // happen to be UTC; the parser applies the event's own zone.
  if (eventPart.dateTime) return parseOutlookDateTime(eventPart.dateTime, eventPart.timeZone);
  if (eventPart.date) return dayAnchor(eventPart.date);
  return null;
}

function buildOutlookExternalEventData(event: any, existingTitle?: any, parsedStart?: any, parsedEnd?: any) {
  const start = parsedStart || getEventDate(event.start, event.isAllDay);
  const end = parsedEnd || getEventDate(event.end, event.isAllDay);
  return {
    title: event.subject || existingTitle || 'Untitled Event',
    description: stripCalendarHeader(cleanHtmlContent(event.body?.content || '')),
    notes: stripCalendarHeader(cleanHtmlContent(event.body?.content || '')),
    location: event.location?.displayName || null,
    start: start || null,
    end: end || null,
    allDay: Boolean(event.isAllDay),
    // Left undefined (not written) when absent, so an update never erases it.
    startTimeZone: event.originalStartTimeZone ? normalizeIanaTimeZone(event.originalStartTimeZone) : (event.start?.timeZone ? normalizeIanaTimeZone(event.start.timeZone) : undefined),
    meeting: {
      organizer: event.organizer?.emailAddress || null,
      attendees: (event.attendees || []).map((person: any) => ({
        email: person.emailAddress?.address, displayName: person.emailAddress?.name || null,
        responseStatus: person.status?.response || 'notResponded',
      })),
      responseStatus: event.responseStatus?.response || null,
      status: event.showAs === 'tentative' ? 'tentative' : 'confirmed',
      isPrivate: event.sensitivity === 'private' || event.sensitivity === 'confidential',
      isOrganizer: event.isOrganizer === true,
      joinUrl: event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || null,
      providerUrl: event.webLink || null, version: event.changeKey || null,
      originalBody: event.body || null,
    },
    icalUid: normalizeICalUid(event.iCalUId) ?? undefined,
    seriesEventId: event.seriesMasterId || undefined,
  };
}

// Engine calls buildExternalEventData(event, existingTitle); preserve the
// original Outlook call which fed parsedDueDate as `start` and the parsed end.
function buildExternalEventData(event: any, existingTitle: any) {
  const parsedDueDate = parseDueDate(event);
  return buildOutlookExternalEventData(event, existingTitle, parsedDueDate, getEventDate(event.end, event.isAllDay));
}

function applyExternalLastModified(updateData: any, event: any) {
  if (event.lastModifiedDateTime) {
    updateData.outlookLastModified = new Date(event.lastModifiedDateTime);
  }
}

function buildNewExternalEventData(event: any, userId: string) {
  // A new external event needs a start it can be placed at; without one it is
  // skipped (the engine treats null as 'skipped'). There is no fallback: one
  // to "now" made this never skip anything.
  const start = parseDueDate(event);
  if (!start || Number.isNaN(start.getTime())) return null;

  return {
    ...buildOutlookExternalEventData(event),
    provider: 'outlook',
    externalEventId: event.id,
    outlookId: event.id,
    calendarId: event.parentFolderId || 'primary',
    outlookChangeKey: event.changeKey || null,
    outlookLastModified: event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime) : null,
    createdBy: userId,
    source: 'external',
  };
}

// ── billing inbound (moved verbatim from outlook.service) ────────────────────

// The day an invoice date takes from its event: an all-day event's anchor day,
// else the local day of the timed start, in the event's zone or the member's.
async function getBillingScheduledDate(event: any, parsedDueDate: any, userId: string) {
  if (!parsedDueDate || Number.isNaN(parsedDueDate.getTime())) return null;
  if (event.isAllDay) return parsedDueDate.toISOString().split('T')[0];
  const memberZone = (await calendarTokens.getSettings(userId).catch(() => null))?.timezone;
  return startDayIn(parsedDueDate, [normalizeIanaTimeZone(event.start?.timeZone), memberZone]);
}

async function syncBillingEvent(event: any, mappingRecord: any, lawFirmId: string, userId: string) {
  const invoiceData = mappingRecord?.data;
  if (!invoiceData) return 'skipped';

  const member = await membersRepo.findByUserId(lawFirmId, userId);
  const memberData = member ? { userId, ...member } : { userId, isOwner: true };
  const permissions = await rolesService.resolvePermissions(lawFirmId, memberData).catch(() => []);
  if (!hasPermission({ isOwner: memberData.isOwner, resolvedPermissions: permissions }, 'billing.viewInvoices')) return 'skipped';

  const parsedDueDate = parseDueDate(event);
  const billingItemKey = mappingRecord.itemKey
    || findBillingSyncItemKey(invoiceData, 'outlook', userId, event.id);
  const scheduledDate = await getBillingScheduledDate(event, parsedDueDate, userId);

  if (!billingItemKey || !scheduledDate) return 'skipped';

  await invoicesService.applyBillingCalendarSyncUpdate({
    lawFirmId,
    invoice: invoiceData,
    billingItemKey,
    scheduledDate,
    actingUserId: userId,
    provider: 'outlook',
    modifiedAt: event.lastModifiedDateTime || null,
  });

  return 'updated';
}

const outlookStrategy = {
  provider: 'outlook',
  otherProvider: 'google',

  getServiceModule() { return require('./outlook.service'); },
  getOtherServiceModule() { return require('../google/google.service'); },

  // field accessors
  getEventId(event: any) { return event.id; },
  getEventModified(event: any) { return event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime) : null; },
  isRecurringSeries(event: any) { return event.type === 'seriesMaster'; },
  isRecurringInstance(event: any) { return event.type === 'occurrence' || event.type === 'exception' || Boolean(event.seriesMasterId); },
  getICalUid(event: any) { return normalizeICalUid(event.iCalUId); },
  // This provider's id on an imported row, and the fields that link a row
  // imported from Google to the same meeting's own copy on Outlook.
  getProviderIdOnRow(row: any) { return row.outlookId || null; },
  buildTwinLink(event: any) {
    return {
      outlookId: event.id,
      outlookChangeKey: event.changeKey || null,
      outlookLastModified: event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime) : null,
    };
  },
  buildUnlink() { return { outlookId: null, outlookChangeKey: null, outlookLastModified: null }; },
  deleteOwnEvent(userId: string, eventId: string) { return require('./outlook.service').deleteEvent({ userId, eventId }); },
  // Cancelled by its organizer, or declined but kept on the calendar (Outlook
  // normally removes a declined meeting, but a mailbox can keep it). Either
  // way it is not something the user is attending; inbound treats it as a delete.
  isGoneForUser(event: any) { return Boolean(event.isCancelled) || event.responseStatus?.response === 'declined'; },
  getEventEnd,
  getAllDayEnd,
  getOriginatedBodyText(event: any) { return cleanHtmlContent(event.body?.content || ''); },
  getEventZones,
  fetchEvent,

  lastSyncedField: 'lastSyncedToOutlook',
  lastModifiedField: 'outlookLastModified',
  otherLastModifiedField: 'googleLastModified',
  externalIdPrefix: 'outlook_',

  // resolution helpers
  findTaskIdByEventId(lawFirmId: string, eventId: string) { return tasksRepo.findIdByOutlookId(lawFirmId, eventId); },
  findExternalByEventId(lawFirmId: string, eventId: string, userId: string) { return calendarEventsRepo.findByOutlookId(lawFirmId, eventId, userId); },

  // sibling ids used for cross-delete (Google side)
  getExternalProviderId(externalRow: any) { return externalRow.googleEventId; },
  getTaskProviderId(taskData: any) { return taskData.googleEventId; },

  // for cross-sync: does the sibling (Google) already have this entity?
  getSiblingAdapterEventId(adapter: any, data: any, items: any, userId: string) {
    return items.length > 0 && adapter.getGoogleEventId(data, items[0].key, userId);
  },

  // the writeback that drops one member's event for one item of an entity
  buildDeleteWriteback(adapter: any, key: any, userId: string) { return adapter.buildOutlookDeleteWriteback(key, userId); },

  // inbound builders
  buildTaskUpdateData,
  buildMappedEventUpdateData,
  buildExternalEventData,
  applyExternalLastModified,
  buildNewExternalEventData,

  // billing
  syncBillingEvent,

  // outbound-push stamp target (calendar_subscriptions)
  findWatchEntityForUser(userId: string) { return calendarSyncRepo.findSubscriptionForUser(userId); },
  stampWatchEntity(id: any) { return calendarSyncRepo.stampSubscriptionOutboundPush(id); },
};

export = outlookStrategy;
