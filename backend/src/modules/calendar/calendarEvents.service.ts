const calendarEventsRepo = require('./calendarEvents.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { formatForClient, toInstant } = require('../../shared/utils/time');
const { AppError, ValidationError, ForbiddenError, ConflictError } = require('../../shared/errors/AppError');
const { assertEndAfterStart, endWithoutCallerEnd } = require('../../shared/validation/eventRange');

// `toInstant` validates the parse, so display formatting never gets a NaN date.
const ts = (val: any) => {
  const d = toInstant(val);
  return d ? d.toISOString() : null;
};

function formatExternalEvent(event: any, timezone: any) {
  const startVal = toInstant(event.start);
  const endVal = toInstant(event.end);
  // An all-day event is its days alone, with no time to show.
  const dateOnly = Boolean(event.allDay);
  const { display: startDisplay, input: startInput } = formatForClient(startVal, timezone, { dateOnly });
  const { display: endDisplay, input: endInput } = formatForClient(endVal, timezone, { dateOnly });

  return {
    id: event.id,
    title: event.title,
    description: event.description || null,
    notes: event.notes || null,
    location: event.location || null,
    start: startVal ? startVal.toISOString() : null,
    end: endVal ? endVal.toISOString() : null,
    startLocalDisplay: startDisplay,
    startLocalInput: dateOnly ? startVal?.toISOString().slice(0, 10) || null : startInput,
    endLocalDisplay: endDisplay,
    endLocalInput: dateOnly ? endVal?.toISOString().slice(0, 10) || null : endInput,
    allDay: Boolean(event.allDay),
    startTimeZone: event.startTimeZone || null,
    // provider_details defaults to '{}', so an empty object means no details.
    meeting: event.meeting && Object.keys(event.meeting).length ? {
      organizer: event.meeting.organizer || null, attendees: event.meeting.attendees || [],
      responseStatus: event.meeting.responseStatus || null, status: event.meeting.status || 'confirmed',
      isPrivate: event.meeting.isPrivate === true, isOrganizer: event.meeting.isOrganizer === true,
      joinUrl: event.meeting.joinUrl || null, providerUrl: event.meeting.providerUrl || null,
    } : null,
    provider: event.provider,
    externalEventId: event.externalEventId,
    googleEventId: event.googleEventId || null,
    outlookId: event.outlookId || null,
    outlookChangeKey: event.outlookChangeKey || null,
    calendarId: event.calendarId || null,
    source: 'external',
    createdAt: ts(event.createdAt),
    updatedAt: ts(event.updatedAt),
  };
}

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', outlook: 'Outlook' };

const hasMeetingDetails = (meeting: any) => Boolean(meeting && typeof meeting === 'object' && Object.keys(meeting).length);

/**
 * The row with its meeting details, read from the provider when it has none.
 *
 * The update and delete guards decide from `provider_details` whether the
 * member is only a guest at this meeting. An event imported before that
 * column was filled carries `{}`, which reads as "not a meeting", so a guest
 * could rewrite or delete the organizer's meeting. Such a row is read from
 * the provider with the connection of the member who imported it (the rows
 * are scoped to them), and the details are kept for the next edit. A provider
 * that answers that the event is gone leaves no meeting to protect. One that
 * cannot answer refuses the change rather than letting it through unchecked.
 */
async function withMeetingDetails(lawFirmId: string, row: any) {
  if (row.source !== 'external' || hasMeetingDetails(row.meeting)) return row;
  const strategy = row.provider === 'google' ? require('./google/googleStrategy')
    : row.provider === 'outlook' ? require('./outlook/outlookStrategy') : null;
  const providerEventId = row.provider === 'google' ? row.googleEventId : row.outlookId;
  if (!strategy || !providerEventId) return row;

  const fetched = await strategy.fetchEvent(row.createdBy, providerEventId, row.calendarId).catch(() => null);
  if (fetched?.status === 404 || fetched?.status === 410) return row;
  if (!fetched?.event) {
    throw new AppError(
      `We could not check this meeting with ${PROVIDER_NAMES[row.provider]}. Please try again shortly.`,
      503, 'CALENDAR_MEETING_UNVERIFIED',
    );
  }
  const { meeting } = strategy.buildExternalEventData(fetched.event, row.title);
  await calendarEventsRepo.upsert(lawFirmId, row.id, { meeting });
  return { ...row, meeting };
}

/**
 * External (Google/Outlook) events for a firm, optionally bounded to the calendar
 * window the viewer is drawing. Without a range every event comes back.
 */
export async function listExternalCalendarEvents({ lawFirmId, userId, timezone, range = null }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const events = await calendarEventsRepo.listAll(lawFirmId, userId, range);
  return {
    events: events.map((e: any) => formatExternalEvent(e, timezone)),
    totalEvents: events.length,
  };
}

/**
 * Fetch a single external calendar event by id (membership-asserted, formatted).
 * C9: lets the delete route locate one event via an indexed findById instead of
 * listing every external event for the firm. Returns null when not found.
 */
export async function getExternalCalendarEvent({ lawFirmId, userId, eventId, timezone }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const event = await calendarEventsRepo.findById(lawFirmId, eventId, userId);
  // The delete route reads the meeting guard off this before it removes any
  // provider copy, so the details have to be there already.
  return event ? formatExternalEvent(await withMeetingDetails(lawFirmId, event), timezone) : null;
}

export async function updateExternalCalendarEvent({ lawFirmId, userId, eventId, updates }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const found = await calendarEventsRepo.findById(lawFirmId, eventId, userId);
  if (!found) {
    const err: any = new Error('Event not found');
    err.status = 404;
    throw err;
  }
  const existing = await withMeetingDetails(lawFirmId, found);
  const updateData: any = {
    title: updates.title || existing.title,
    notes: updates.notes !== undefined ? updates.notes : (existing.notes ?? null),
    description: updates.notes !== undefined ? updates.notes : (existing.description ?? null),
    location: updates.location !== undefined ? updates.location : (existing.location ?? null),
    // Preserve the all-day flag so editing an all-day event doesn't flip it to a
    // timed event (which the next outbound sync would push to the provider).
    allDay: updates.allDay !== undefined ? updates.allDay : Boolean(existing.allDay),
  };
  if (existing.meeting?.attendees?.length) {
    if (!existing.meeting.isOrganizer) throw new ForbiddenError('Open this meeting in Google or Outlook to make changes.');
    if (updates.confirmNotifyAttendees !== true) throw new ConflictError('Confirm that attendees will be notified before saving this meeting.');
  }
  // An all-day edit sends bare days, which `toInstant` anchors at noon UTC like
  // every other all-day value (a bare `new Date()` made them midnight UTC, the
  // day before behind UTC). An unparseable value is a 400 here rather than the
  // opaque 500 Postgres gave it.
  if (updates.start) {
    const start = toInstant(updates.start);
    if (!start) throw new ValidationError('start must be a valid date');
    updateData.start = start;
  }
  if (updates.end) {
    const end = toInstant(updates.end);
    if (!end) throw new ValidationError('end must be a valid date');
    updateData.end = end;
  } else {
    // No end of its own: a moved start carries the end with it, and an
    // all-day toggle drops it, the rule matter events and tasks follow.
    const moved = endWithoutCallerEnd(
      { date: existing.start, endsAt: existing.end, allDay: existing.allDay },
      { date: updateData.start, allDay: updates.allDay },
    );
    if (moved !== undefined) updateData.end = moved;
  }
  assertEndAfterStart(
    updateData.start ?? existing.start,
    updateData.end !== undefined ? updateData.end : existing.end,
  );
  await calendarEventsRepo.upsert(lawFirmId, eventId, updateData);
  const fresh = await calendarEventsRepo.findById(lawFirmId, eventId, userId);
  return { event: formatExternalEvent(fresh, updates.timezone || null) };
}

export async function deleteExternalCalendarEvent({ lawFirmId, userId, eventId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const found = await calendarEventsRepo.findById(lawFirmId, eventId, userId);
  if (!found) {
    const err: any = new Error('Event not found');
    err.status = 404;
    throw err;
  }
  const existing = await withMeetingDetails(lawFirmId, found);
  if (existing.meeting?.attendees?.length && !existing.meeting.isOrganizer) {
    throw new ForbiddenError('Open this meeting in Google or Outlook to make changes.');
  }
  await calendarEventsRepo.delete(lawFirmId, eventId);
  return { message: 'Event deleted' };
}
