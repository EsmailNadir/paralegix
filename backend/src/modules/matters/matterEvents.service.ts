const matterEventsRepo = require('./matterEvents.repository');
import { withTransactionEffects } from '../../shared/database/transactionEffects';
const { assertEndAfterStart, shiftedEnd, endWithoutCallerEnd, endsAtLocal, dateOnAllDayToggle } = require('../../shared/validation/eventRange');
const { addDays: addDaysToDay } = require('../../shared/utils/localTime');
const { rowIso } = require('../../shared/utils/dateConversion');
const mattersRepo = require('./matters.repository');
const eventBus = require('../../shared/events/eventBus');
const {
  MATTER_EVENT_CREATED,
  MATTER_EVENT_UPDATED,
  MATTER_EVENT_DELETED,
} = require('../../shared/events/eventTypes');
const { assertLawFirmMembership, assertMatterMembership, assertMatterMemberships, assertMatterReadAccess } = require('../../shared/utils/membership');
const { formatForClient, toTimestampOrNull, localInputToUtcDate, resolveEventDate, dayAnchor } = require('../../shared/utils/time');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

const nowIso = () => new Date().toISOString();
const isNonEmptyStr = (value: any) => typeof value === 'string' && value.trim().length > 0;

/**
 * Who may change a matter event: an owner who can read the matter, or a member
 * of it. Inbound calendar sync applies it too, to a member's provider edit.
 */
export async function assertEventWriteAccess(lawFirmId: string, matterId: string, userId: string) {
  const members = require('../lawfirms/members/members.repository');
  const member = await members.findByUserId(lawFirmId, userId);
  if (member?.isOwner) return assertMatterReadAccess(lawFirmId, matterId, userId);
  return assertMatterMembership(lawFirmId, matterId, userId);
}


function createDependencyValidationError(message: any) {
  const err = new ValidationError({ dependency: message });
  err.message = message;
  return err;
}

function normalizeDependsOn(dependsOn: any) {
  if (!Array.isArray(dependsOn)) return [];

  return Array.from(
    new Set(
      dependsOn
        .filter(isNonEmptyStr)
        .map((id) => id.trim())
    )
  );
}

// Event assignees receive reminder emails containing the matter and event
// details. A firm member outside the matter must not be selectable here: task
// assignments already enforce the same ethical-wall rule, and a JSON field on
// events must not become a side door around it.
async function resolveMatterEventAssignees(lawFirmId: string, matterId: string, assignedTo: any) {
  const ids = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : [];
  await assertMatterMemberships(lawFirmId, matterId, ids);
  return ids;
}

function createsDependencyCycle(eventId: string, normalizedDependsOn: any, eventMap: any) {
  if (!eventId) return false;

  const visiting = new Set();
  const visited = new Set();

  const getDependencies = (currentId: any) => {
    if (currentId === eventId) return normalizedDependsOn;
    return normalizeDependsOn(eventMap.get(currentId)?.dependsOn);
  };

  const visit = (currentId: any) => {
    if (visiting.has(currentId)) return true;
    if (visited.has(currentId)) return false;

    visiting.add(currentId);
    for (const dependencyId of getDependencies(currentId)) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(currentId);
    visited.add(currentId);
    return false;
  };

  return visit(eventId);
}

async function validateDependsOn({ lawFirmId, matterId, eventId, dependsOn, executor }: any) {
  const normalizedDependsOn = normalizeDependsOn(dependsOn);

  if (eventId && normalizedDependsOn.includes(eventId)) {
    throw createDependencyValidationError('An event cannot depend on itself');
  }

  if (normalizedDependsOn.length === 0) return normalizedDependsOn;

  const allEvents = await matterEventsRepo.findAll(lawFirmId, matterId, executor);
  const eventMap = new Map(allEvents.map((event: any) => [event.id, event]));

  const missingDependencyIds = normalizedDependsOn.filter((dependencyId) => !eventMap.has(dependencyId));
  if (missingDependencyIds.length > 0) {
    throw createDependencyValidationError('One or more selected dependencies no longer exist');
  }

  if (createsDependencyCycle(eventId, normalizedDependsOn, eventMap)) {
    throw createDependencyValidationError('This creates a circular dependency');
  }

  return normalizedDependsOn;
}

export function formatEvent(event: any, timezone: any, labels: any = {}) {
  const dateVal = event.date ? new Date(event.date) : null;
  const { display: dateDisplay, input: dateInput } = formatForClient(dateVal, timezone, { dateOnly: event.allDay === true });

  return {
    id: event.id,
    type: event.type,
    title: event.title,
    notes: event.notes || null,
    clientDescription: event.clientDescription || null,
    timeZone: event.timeZone || null,
    locationName: event.locationName || null,
    location: event.location || null,
    // The matter's court, joined at read. Read-only on a matter event: it
    // changes with the matter, never through the event.
    courtName: event.courtName ?? null,
    status: event.status || 'upcoming',
    allDay: event.allDay === true,
    matterId: event.matterId,
    matterName: labels.matterName ?? null,
    clientNames: labels.clientNames ?? [],
    lawFirmId: event.lawFirmId,
    createdBy: event.createdBy,
    date: dateVal ? dateVal.toISOString() : null,
    endsAt: rowIso(event.endsAt),
    ...endsAtLocal(event, timezone),
    dateLocalDisplay: dateDisplay,
    dateLocalInput: dateInput,
    createdAt: rowIso(event.createdAt),
    updatedAt: rowIso(event.updatedAt),
    googleEventId: event.googleEventId || null,
    outlookId: event.outlookId || null,
    assignedTo: event.assignedTo || [],
    assignedToName: event.assignedToName || [],
    // Non-member attendees. Only the reads that join them populate this, so an
    // event that came from a read which does not (calendar sync, reminders)
    // reports an empty list rather than a wrong one.
    contacts: event.contacts || [],
    clientVisible: event.clientVisible === true,
    cancellationReason: event.cancellationReason || null,
    cancelledBy: event.cancelledBy || null,
    cancelledAt: rowIso(event.cancelledAt),
    postponementCount: event.postponementCount || 0,
    postponementHistory: (event.postponementHistory || []).map((entry: any) => ({
      previousDate: rowIso(entry.previousDate),
      newDate: rowIso(entry.newDate),
      reason: entry.reason,
      postponedBy: entry.postponedBy,
      postponedAt: rowIso(entry.postponedAt),
    })),
    linkedFiles: (event.linkedFiles || []).map((f: any) => ({
      ...f,
      linkedAt: rowIso(f.linkedAt),
    })),
    dependsOn: event.dependsOn || [],
    recurrence: event.recurrence || null,
    recurrenceGroupId: event.recurrenceGroupId || null,
    recurrenceIndex: event.recurrenceIndex ?? null,
    isRecurrenceParent: event.isRecurrenceParent || false,
  };
}

/**
 * List all events across the matters a user can see, for the calendar.
 *
 * `range` (from `shared/utils/calendarRange`) narrows the read to the days the
 * calendar is drawing. Without it the whole history comes back, which is the
 * contract the unwindowed callers still hold.
 *
 * Events carry their matter name and that matter's client names so the calendar
 * can label them without loading every matter in the firm.
 */
export async function listAllMatterEvents({ lawFirmId, userId, timezone, range = null }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  // Membership-scoped for everyone, owners included: the calendar shows the
  // events of matters the viewer belongs to, not the whole firm's.
  const { matters } = await mattersRepo.listMattersPaged(lawFirmId, userId, { seeAll: false });
  if (!matters.length) {
    return { events: [], totalEvents: 0 };
  }

  const matterIds = matters.map((c: any) => c.id);
  // Single batched query across all the member's matters (globally date-ordered in SQL).
  const [events, matterNames, clientNames] = await Promise.all([
    matterEventsRepo.findAllForMatters(lawFirmId, matterIds, range),
    mattersRepo.getNamesByIds(lawFirmId, matterIds),
    mattersRepo.getClientNamesByIds(lawFirmId, matterIds),
  ]);

  return {
    events: events.map((e: any) => formatEvent(e, timezone, {
      matterName: matterNames[e.matterId] || null,
      clientNames: clientNames[e.matterId] || [],
    })),
    totalEvents: events.length,
  };
}

/**
 * List all events for a matter.
 */
/**
 * The matter's events. Paging is opt-in: with no `limit` the complete list comes
 * back, which is what the calendar and the matter overview read.
 */
export async function listMatterEvents({ lawFirmId, matterId, userId, timezone, status, page, limit, offset }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);

  if (!limit) {
    const events = await matterEventsRepo.findAll(lawFirmId, matterId);
    return {
      events: events.map((e: any) => formatEvent(e, timezone)),
      totalEvents: events.length,
    };
  }

  const resolvedOffset = offset ?? (page ? (page - 1) * limit : 0);
  const { rows, totalItems } = await matterEventsRepo.findPaged(lawFirmId, matterId, {
    status: status || null,
    limit,
    offset: resolvedOffset,
  });

  return {
    events: rows.map((e: any) => formatEvent(e, timezone)),
    totalEvents: totalItems,
  };
}

/**
 * The matter's dependency graph: every event, id/title/status/date/dependsOn only.
 *
 * Separate from `listMatterEvents` because the two answer different questions. The
 * list is what a reader is looking at, and can be a page. The graph is what
 * decides whether an event is blocked, and cannot — resolving a dependency against
 * a page would report "not blocked" for a blocker that simply was not loaded.
 */
export async function listMatterEventGraph({ lawFirmId, matterId, userId, timezone }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  const rows = await matterEventsRepo.findGraph(lawFirmId, matterId);
  const events = rows.map((row: any) => {
    const dateVal = row.date ? new Date(row.date) : null;
    const { display } = formatForClient(dateVal, timezone);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status || 'upcoming',
      date: dateVal ? dateVal.toISOString() : null,
      dateLocalDisplay: display,
      dependsOn: row.dependsOn,
    };
  });
  return { events, totalEvents: events.length };
}

/**
 * Generate occurrence dates for a recurring event, DST-safe: advances the LOCAL
 * wall-clock (in `timezone`) so e.g. a 9:00 AM event stays 9:00 AM across a DST
 * boundary, then maps each occurrence back to a UTC instant. Monthly clamps to the
 * last valid day (Jan 31 -> Feb 28/29). The first occurrence (the parent) is skipped.
 */
function generateOccurrenceDates(startDate: any, recurrence: any, timezone: any, allDay = false) {
  const tz = timezone || 'UTC';
  const dates: any[] = [];
  const startUtc = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(startUtc.getTime())) return dates;
  const { pattern, interval = 1, endType, endCount, endDate, daysOfWeek } = recurrence;
  const maxOccurrences = endType === 'count' ? endCount - 1 : 1000;
  // The repeat's last day is a day in the event's zone, so the cut-off is the
  // start of the day after it there. 23:59:59 UTC dropped an evening occurrence
  // on the last day in the Americas and added a morning one after it in Asia.
  const endUtc = endDate ? (allDay ? dayAnchor(addDaysToDay(String(endDate).slice(0, 10), 1)) : localInputToUtcDate(`${addDaysToDay(String(endDate).slice(0, 10), 1)}T00:00`, tz)) : null;

  // Local wall-clock of the start ("YYYY-MM-DDTHH:mm"); we advance it as a pseudo-UTC
  // date (UTC has no DST), then convert the local string back to a real UTC instant.
  const { input } = allDay ? { input: `${startUtc.toISOString().slice(0, 10)}T12:00` } : formatForClient(startUtc, tz);
  if (!input) return dates;
  const [d0, t0] = input.split('T');
  const [Y, M, D] = d0.split('-').map(Number);
  const [h, mi] = t0.split(':').map(Number);
  let cur = new Date(Date.UTC(Y, M - 1, D, h, mi));

  const pad = (n: any) => String(n).padStart(2, '0');
  const addDays = (dt: any, n: any) => new Date(dt.getTime() + n * 86400000);
  const addMonths = (dt: any, n: any) => {
    const day = dt.getUTCDate();
    const base = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1, dt.getUTCHours(), dt.getUTCMinutes()));
    const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, lastDay));
    return base;
  };

  for (let i = 0; i < maxOccurrences; i++) {
    switch (pattern) {
      case 'daily': cur = addDays(cur, interval); break;
      case 'weekly': cur = addDays(cur, 7 * interval); break;
      case 'biweekly': cur = addDays(cur, 14); break;
      case 'monthly': cur = addMonths(cur, interval); break;
      case 'custom':
        if (daysOfWeek && daysOfWeek.length > 0) {
          let found = false;
          for (let d = 0; d < 365; d++) {
            cur = addDays(cur, 1);
            if (daysOfWeek.includes(cur.getUTCDay())) { found = true; break; }
          }
          if (!found) return dates;
        } else {
          cur = addDays(cur, interval);
        }
        break;
      default: return dates;
    }

    const localStr = `${cur.getUTCFullYear()}-${pad(cur.getUTCMonth() + 1)}-${pad(cur.getUTCDate())}T${pad(cur.getUTCHours())}:${pad(cur.getUTCMinutes())}`;
    const occUtc = allDay ? dayAnchor(localStr.slice(0, 10)) : localInputToUtcDate(localStr, tz);
    if (endType === 'date' && endUtc && occUtc >= endUtc) break;
    dates.push(occUtc);
  }

  if (endType === 'date' && dates.length >= 1000) throw new ValidationError('This recurrence contains more than 1,000 occurrences. Choose an earlier end date.');

  return dates;
}

/**
 * Transaction-body core of a single, non-recurring matter event create:
 * asserts matter membership, resolves the date and writes the row through
 * `matterEventsRepo.create`. `executor` defaults to the root connection
 * (an ordinary, independently-committed create), but a caller creating
 * SEVERAL events as one unit (deadlineSets.applyDeadlineSet) passes the
 * executor from an open `withDrizzleTransaction` so every insert lands in
 * ONE outer transaction instead of one committed insert per event — without
 * that, a failure on the Nth item left the first N-1 items committed as a
 * partially-applied template with no record of what's missing.
 *
 * Deliberately narrower than `createMatterEvent`: no recurrence, no
 * `dependsOn`/`linkedFiles`/non-member attendees, since deadline-set items
 * never carry any of those. Does not emit `MATTER_EVENT_CREATED` — a caller
 * wrapping several of these in one transaction must emit only after that
 * transaction has committed, so a listener never observes an event id a
 * rollback later made disappear.
 */
export async function _createMatterEventTx({ executor, lawFirmId, matterId, userId, timezone, type, title, date, notes, clientVisible, clientDescription, allDay = false }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);

  const dateTs = resolveEventDate(date, timezone, allDay === true);
  const baseData = {
    type,
    title: title.trim(),
    notes: notes?.trim() || null,
    locationName: null,
    location: null,
    status: 'upcoming',
    createdBy: userId,
    assignedTo: [],
    assignedToName: [],
    linkedFiles: [],
    dependsOn: [],
    clientVisible: clientVisible === true,
      clientDescription: clientDescription?.trim() || null,
      timeZone: timezone,
    allDay: allDay === true,
  };

  return matterEventsRepo.create(lawFirmId, matterId, { ...baseData, date: dateTs }, executor);
}

/**
 * Create a new matter event (or batch of recurring events).
 */
export async function createMatterEvent({ lawFirmId, matterId, userId, timezone, type, title, date, endsAt, allDay, notes, locationName, location, status, assignedTo, assignedToName, contactIds, linkedFiles, dependsOn, recurrence, clientVisible, clientDescription }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');

    const dateTs = resolveEventDate(date, timezone, allDay === true);
    // Same resolution as the start, so a span keeps its exact instants.
    const endsAtTs = endsAt === undefined ? null : resolveEventDate(endsAt, timezone, allDay === true);
    // The CHECK on `events` refuses this too, but a constraint violation reaches
    // the caller as a 500 blaming the system for what is a user mistake. The
    // pre-check gives the message; the constraint keeps the guarantee.
    assertEndAfterStart(dateTs, endsAtTs);
    const validatedDependsOn = await validateDependsOn({ lawFirmId, matterId, dependsOn, executor });
    const validatedAssignees = await resolveMatterEventAssignees(lawFirmId, matterId, assignedTo);

    // Enrich linked files with who linked them
    const enrichedFiles = (linkedFiles || []).map((f: any) => ({
      ...f,
      linkedBy: userId,
      linkedAt: nowIso(),
    }));

    const baseData = {
      type,
      title: title.trim(),
      notes: notes?.trim() || null,
      locationName: locationName?.trim() || null,
      location: location?.trim() || null,
      status: status || 'upcoming',
      createdBy: userId,
      // assignedTo is NOT part of the row: it is written as event_assignees rows
      // below, once the event exists (migration 0218).
      linkedFiles: enrichedFiles,
      dependsOn: validatedDependsOn,
      clientVisible: clientVisible === true,
      clientDescription: clientDescription?.trim() || null,
      timeZone: timezone,
      allDay: allDay === true,
    };

    // Handle recurring events
    if (recurrence) {
      const occurrenceDates = generateOccurrenceDates(dateTs, recurrence, timezone, allDay === true);
      const groupId = `recurrence_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const eventsToCreate = [
        { ...baseData, date: dateTs, endsAt: endsAtTs, recurrence, recurrenceGroupId: groupId, recurrenceIndex: 0, isRecurrenceParent: true },
        ...occurrenceDates.map((d, i) => ({
          ...baseData,
          date: d,
          // Every occurrence is as long as the first; without an end of its own
          // it went to Google and Outlook as the one-hour default.
          endsAt: shiftedEnd(dateTs, endsAtTs, d),
          recurrenceGroupId: groupId,
          recurrenceIndex: i + 1,
          isRecurrenceParent: false,
        })),
      ];

      // Single batched insert for the whole series (ordered by recurrenceIndex).
      const createdEvents = await matterEventsRepo.batchCreate(lawFirmId, matterId, eventsToCreate, executor);
      for (const created of createdEvents) {
        await matterEventsRepo.syncAssignees(lawFirmId, created.id, validatedAssignees, executor);
        if (contactIds !== undefined) {
          await matterEventsRepo.syncContacts(lawFirmId, created.id, contactIds, executor);
        }
        const fresh = await matterEventsRepo.findById(lawFirmId, matterId, created.id, executor);
        created.assignedTo = validatedAssignees;
        created.contacts = fresh?.contacts || [];
        created.assignedToName = fresh?.assignedToName || [];
      }
      const parent = createdEvents[0];

      // Fire calendar sync for each occurrence in the background (non-blocking).
      // Each emission runs independently so one failure doesn't prevent others.
      for (const created of createdEvents) {
        defer(() => {
          eventBus.emit(MATTER_EVENT_CREATED, {
            lawFirmId, matterId, eventId: created.id, eventData: created, userId, timeZone: timezone,
          });
        });
      }

      return {
        message: `Created ${createdEvents.length} recurring events`,
        eventId: parent.id,
        event: formatEvent(parent, timezone),
      };
    }

    // Single event. create() returns the full row (RETURNING *), so no re-read needed.
    const created = await matterEventsRepo.create(lawFirmId, matterId, {
      ...baseData,
      date: dateTs,
      endsAt: endsAtTs,
    }, executor);

    // Firm members who own the event, and non-member attendees (opposing counsel,
    // a court reporter, an expert), both live in junctions, so they are written
    // after the row exists. `validatedAssignees` was already checked against the
    // matter's membership above.
    await matterEventsRepo.syncAssignees(lawFirmId, created.id, validatedAssignees, executor);
    created.assignedTo = validatedAssignees;
    if (contactIds !== undefined) {
      await matterEventsRepo.syncContacts(lawFirmId, created.id, contactIds, executor);
    }
    const createdFresh = await matterEventsRepo.findById(lawFirmId, matterId, created.id, executor);
    created.contacts = createdFresh?.contacts || [];
    created.assignedToName = createdFresh?.assignedToName || [];

    // Calendar sync is best-effort and runs in calendar.events listeners. Fire-and-forget
    // so the HTTP response doesn't block on Google/Outlook round-trips.
    defer(() => {
      eventBus.emit(MATTER_EVENT_CREATED, {
        lawFirmId,
        matterId,
        eventId: created.id,
        eventData: created,
        userId,
        timeZone: timezone,
      });
    });

    return {
      message: 'Matter event created successfully',
      eventId: created.id,
      event: formatEvent(created, timezone),
    };
  });
}

/**
 * Update a matter event.
 */
export async function updateMatterEvent({ lawFirmId, matterId, eventId, userId, timezone, type, title, date, endsAt, allDay, notes, locationName, location, status, assignedTo, assignedToName, contactIds, linkedFiles, dependsOn, clientVisible, clientDescription }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');

    const existing = await matterEventsRepo.findById(lawFirmId, matterId, eventId, executor);
    if (!existing) throw new NotFoundError('Matter event');

    // `date` must resolve against the EFFECTIVE allDay flag - the one this
    // update leaves in place, not just one the caller happens to also be
    // changing in the same request - since a date-only edit that omits
    // `allDay` must still anchor against the event's existing all-day state.
    const effectiveAllDay = allDay !== undefined ? allDay === true : existing.allDay === true;

    const updates: Record<string, any> = {};
    if (type !== undefined) updates.type = type;
    if (title !== undefined) updates.title = title.trim();
    if (date !== undefined) updates.date = resolveEventDate(date, timezone, effectiveAllDay);
    else {
      const toggledDate = dateOnAllDayToggle(existing, allDay, timezone);
      if (toggledDate !== undefined) updates.date = toggledDate;
    }
    if (endsAt !== undefined) {
      updates.endsAt = endsAt === null ? null : resolveEventDate(endsAt, timezone, effectiveAllDay);
    } else {
      const implicitEnd = endWithoutCallerEnd(existing, {
        date: updates.date,
        allDay: allDay === undefined ? undefined : allDay === true,
      });
      if (implicitEnd !== undefined) updates.endsAt = implicitEnd;
    }
    // Compare against whichever start this write ends up with: the new one if the
    // caller is moving the event, otherwise the stored one.
    assertEndAfterStart(
      updates.date !== undefined ? updates.date : existing.date,
      updates.endsAt !== undefined ? updates.endsAt : existing.endsAt,
    );
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    if (locationName !== undefined) updates.locationName = locationName?.trim() || null;
    if (location !== undefined) updates.location = location?.trim() || null;
    if (status !== undefined) updates.status = status;
    if (assignedTo !== undefined) {
      updates.assignedTo = await resolveMatterEventAssignees(lawFirmId, matterId, assignedTo);
    }
    if (assignedToName !== undefined) updates.assignedToName = assignedToName;
    if (clientVisible !== undefined) updates.clientVisible = clientVisible === true;
    if (clientDescription !== undefined) updates.clientDescription = clientDescription?.trim() || null;
    // Forms submit the full schedule even for a title or status edit. Preserve
    // the original zone unless the start or its all-day meaning actually changes.
    if ((date !== undefined && updates.date?.getTime() !== (existing.date ? new Date(existing.date).getTime() : undefined))
      || effectiveAllDay !== (existing.allDay === true)) updates.timeZone = timezone;
    if (allDay !== undefined) updates.allDay = allDay === true;
    if (linkedFiles !== undefined) {
      updates.linkedFiles = linkedFiles.map((f: any) => ({
        ...f,
        linkedBy: f.linkedBy || userId,
        linkedAt: f.linkedAt || nowIso(),
      }));
    }
    if (dependsOn !== undefined) {
      updates.dependsOn = await validateDependsOn({ lawFirmId, matterId, eventId, dependsOn, executor });
    }

    const updated = await matterEventsRepo.update(lawFirmId, matterId, eventId, updates, executor);

    // Assignees are rows, so they are replaced separately from the row update.
    // `updates.assignedTo` was validated against the matter's membership above.
    if (updates.assignedTo !== undefined) {
      await matterEventsRepo.syncAssignees(lawFirmId, eventId, updates.assignedTo, executor);
    }
    if (contactIds !== undefined) {
      await matterEventsRepo.syncContacts(lawFirmId, eventId, contactIds, executor);
    }
    const updatedFresh = (contactIds !== undefined || updates.assignedTo !== undefined)
      ? await matterEventsRepo.findById(lawFirmId, matterId, eventId, executor)
      : null;
    updated.contacts = contactIds !== undefined
      ? (updatedFresh?.contacts || [])
      : (existing.contacts || []);
    updated.assignedTo = updatedFresh?.assignedTo ?? existing.assignedTo ?? [];
    updated.assignedToName = updatedFresh?.assignedToName ?? existing.assignedToName ?? [];

    // If status changed to cancelled, treat as deletion for calendar cleanup
    if (status === 'cancelled' && existing.status !== 'cancelled') {
      defer(() => {
        eventBus.emit(MATTER_EVENT_DELETED, {
          lawFirmId,
          matterId,
          eventId,
          eventData: updated,
          userId,
        });
      });
    } else {
      defer(() => {
        eventBus.emit(MATTER_EVENT_UPDATED, {
          lawFirmId,
          matterId,
          eventId,
          eventData: updated,
          userId,
          timeZone: timezone,
        });
      });
    }

    return {
      message: 'Matter event updated successfully',
      event: formatEvent(updated, timezone),
    };
  });
}

/**
 * Delete a matter event. Also cleans up dependency references.
 */
export async function deleteMatterEvent({ lawFirmId, matterId, eventId, userId }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');

    const existing = await matterEventsRepo.findById(lawFirmId, matterId, eventId, executor);
    if (!existing) throw new NotFoundError('Matter event');

    await matterEventsRepo.removeDependencyReferences(lawFirmId, matterId, eventId, executor);
    await matterEventsRepo.delete(lawFirmId, matterId, eventId, executor);

    defer(() => {
      eventBus.emit(MATTER_EVENT_DELETED, {
        lawFirmId,
        matterId,
        eventId,
        eventData: existing,
        userId,
      });
    });

    return { message: 'Matter event deleted successfully', eventId };
  });
}

/**
 * Cancel a matter event with a reason.
 */
export async function cancelMatterEvent({ lawFirmId, matterId, eventId, userId, timezone, reason }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);

  if (!await matterEventsRepo.findById(lawFirmId, matterId, eventId)) throw new NotFoundError('Matter event');
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');
    const existing = await matterEventsRepo.findById(lawFirmId, matterId, eventId, executor);
    if (!existing) throw new NotFoundError('Matter event');
    if (existing.status === 'cancelled') throw new ValidationError('Event is already cancelled');

    const updated = await matterEventsRepo.update(lawFirmId, matterId, eventId, {
      status: 'cancelled',
      cancellationReason: reason.trim(),
      cancelledBy: userId,
      cancelledAt: nowIso(),
    }, executor);

    defer(() => { eventBus.emit(MATTER_EVENT_DELETED, {
      lawFirmId,
      matterId,
      eventId,
      eventData: updated,
      userId,
    }); });

    return {
      message: 'Matter event cancelled successfully',
      event: formatEvent(updated, timezone),
    };
  });
}

/**
 * Postpone a matter event to a new date with a reason.
 */
export async function postponeMatterEvent({ lawFirmId, matterId, eventId, userId, timezone, newDate, reason }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);

  if (!await matterEventsRepo.findById(lawFirmId, matterId, eventId)) throw new NotFoundError('Matter event');
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');
    const existing = await matterEventsRepo.findById(lawFirmId, matterId, eventId, executor);
    if (!existing) throw new NotFoundError('Matter event');
    if (existing.status === 'cancelled') throw new ValidationError('Cannot postpone a cancelled event');

    const newDateTs = resolveEventDate(newDate, timezone, existing.allDay === true);

    const postponementEntry = {
      previousDate: rowIso(existing.date),
      newDate: newDateTs ? newDateTs.toISOString() : null,
      reason: reason?.trim() || null,
      postponedBy: userId,
      postponedAt: nowIso(),
    };

    const oldStart = existing.date ? new Date(existing.date) : null;
    const oldEnd = existing.endsAt ? new Date(existing.endsAt) : null;
    const updated = await matterEventsRepo.update(lawFirmId, matterId, eventId, {
      date: newDateTs,
      timeZone: timezone,
      ...(oldEnd ? { endsAt: shiftedEnd(oldStart, oldEnd, newDateTs) } : {}),
      postponementCount: (existing.postponementCount || 0) + 1,
      postponementHistory: [...(existing.postponementHistory || []), postponementEntry],
    }, executor);

    defer(() => { eventBus.emit(MATTER_EVENT_UPDATED, {
      lawFirmId,
      matterId,
      eventId,
      eventData: updated,
      userId,
      timeZone: timezone,
    }); });

    return {
      message: 'Matter event postponed successfully',
      event: formatEvent(updated, timezone),
    };
  });
}

/**
 * Delete all events in a recurrence group.
 */
export async function deleteRecurrenceGroup({ lawFirmId, matterId, groupId, userId }: any) {
  await assertEventWriteAccess(lawFirmId, matterId, userId);
  return withTransactionEffects(async ({ executor, defer }) => {
    const mattersRepo = require('./matters.repository');
    if (!await mattersRepo.lockMatterRow(lawFirmId, matterId, executor)) throw new NotFoundError('Matter');
    const groupEvents = await matterEventsRepo.findByRecurrenceGroup(lawFirmId, matterId, groupId, executor);
    if (groupEvents.length === 0) throw new NotFoundError('Recurrence group');
    for (const event of groupEvents) {
      await matterEventsRepo.removeDependencyReferences(lawFirmId, matterId, event.id, executor);
    }
    await matterEventsRepo.deleteByRecurrenceGroup(lawFirmId, matterId, groupId, executor);
    defer(() => {
      for (const event of groupEvents) {
        eventBus.emit(MATTER_EVENT_DELETED, {
          lawFirmId, matterId, eventId: event.id, eventData: event, userId,
        });
      }
    });
    return { message: `Deleted ${groupEvents.length} recurring events`, deleted: groupEvents.length };
  });
}

/**
 * Before a matter document is removed: remove linked Google/Outlook matter calendar events,
 * then delete all matterEvents documents (billing.events no longer leaves this subcollection orphaned).
 */
export async function emitCalendarDeletesForAllMatterEvents({ lawFirmId, matterId, actingUserId }: any) {
  if (!lawFirmId || !matterId || !actingUserId) return;

  const events = await matterEventsRepo.findAll(lawFirmId, matterId);
  for (const ev of events) {
    eventBus.emit(MATTER_EVENT_DELETED, {
      lawFirmId,
      matterId,
      eventId: ev.id,
      eventData: { ...ev, matterId, lawFirmId },
      userId: actingUserId,
    });
  }
}
