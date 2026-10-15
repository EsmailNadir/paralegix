import { withTransactionEffects } from '../../shared/database/transactionEffects';
const clientEventsRepo = require('./clientEvents.repository');
const { assertEndAfterStart, endWithoutCallerEnd, endsAtLocal, dateOnAllDayToggle } = require('../../shared/validation/eventRange');
const { rowIso } = require('../../shared/utils/dateConversion');
const clientsRepo = require('./clients.repository');
const mattersRepo = require('../matters/matters.repository');
const matterEventsRepo = require('../matters/matterEvents.repository');
const matterEventsService = require('../matters/matterEvents.service');
const eventBus = require('../../shared/events/eventBus');
const { resolveEffectiveClientIds } = require('./clientCompanyLinks.util');
const {
  CLIENT_EVENT_CREATED,
  CLIENT_EVENT_UPDATED,
  CLIENT_EVENT_DELETED,
} = require('../../shared/events/eventTypes');
const { assertLawFirmMembership, assertLawFirmMemberships, getAccessibleMatterIds, isFirmOwnerOrAdmin } = require('../../shared/utils/membership');
const { assertClientInFirm } = require('../../shared/utils/clientScope');
const { assertFirmPermission } = require('../lawfirms/roles/requirePermission');
const { formatForClient, resolveEventDate } = require('../../shared/utils/time');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { resolvePage } = require('../../shared/database/pagination');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');



const nowIso = () => new Date().toISOString();

function formatClientEvent(event: any, timezone: any, { source, matterName, clientName }: any = {}) {
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
    courtId: event.courtId || null,
    courtName: event.courtName || null,
    status: event.status || 'upcoming',
    cancellationReason: event.cancellationReason || null,
    cancelledBy: event.cancelledBy || null,
    cancelledAt: rowIso(event.cancelledAt),
    allDay: event.allDay === true,
    source: source || 'client',
    clientId: event.clientId || null,
    clientName: clientName || null,
    matterId: event.matterId || null,
    matterName: matterName || null,
    lawFirmId: event.lawFirmId,
    createdBy: event.createdBy,
    date: dateVal ? dateVal.toISOString() : null,
    endsAt: rowIso(event.endsAt),
    ...endsAtLocal(event, timezone),
    dateLocalDisplay: dateDisplay,
    dateLocalInput: dateInput,
    createdAt: rowIso(event.createdAt),
    updatedAt: rowIso(event.updatedAt),
    assignedTo: event.assignedTo || [],
    assignedToName: event.assignedToName || [],
    // Non-member attendees. Only the reads that join them populate this, so an
    // event that came from a read which does not report an empty list rather
    // than a wrong one.
    contacts: event.contacts || [],
    clientVisible: event.clientVisible === true,
    linkedFiles: (event.linkedFiles || []).map((f: any) => ({
      ...f,
      linkedAt: rowIso(f.linkedAt),
    })),
  };
}

async function resolveCourt(lawFirmId: string, courtId: any) {
  if (courtId === undefined) return undefined;
  if (courtId === null || String(courtId).trim() === '') return null;

  const court = await mattersRepo.validateCourt(lawFirmId, String(courtId).trim());
  if (!court) {
    throw new NotFoundError('Court');
  }

  return {
    id: court.id,
    name: court.name || null,
  };
}

/**
 * The assignees a standalone client event may carry: members of THIS firm only.
 *
 * `event_assignees.user_id` references `users(id)` and nothing else, so the
 * schema accepts another firm's member or a portal client, and the read would
 * then hand their name back to this firm. Refused as a 400 naming nobody: the
 * ids came from the caller, and resolving a name for someone outside the firm
 * would disclose who they are. Runs before any write so a refused create
 * leaves no event row behind.
 */
async function resolveFirmAssignees(lawFirmId: string, assignedTo: any) {
  const ids = [...new Set<string>((Array.isArray(assignedTo) ? assignedTo : []).filter(Boolean))];
  try {
    await assertLawFirmMemberships(lawFirmId, ids);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new ValidationError({ assignedTo: ['Every assignee must be a member of this law firm'] });
    }
    throw err;
  }
  return ids;
}

/**
 * List all standalone client events across all clients for a law firm (used by calendar).
 *
 * `range` (from `shared/utils/calendarRange`) narrows the read to the days the
 * calendar is drawing. Without it every event comes back.
 */
export async function listAllClientEvents({ lawFirmId, userId, timezone, range = null }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const events = await clientEventsRepo.findAllForLawFirm(lawFirmId, range);
  return {
    events: events.map((e: any) => formatClientEvent(e, timezone, { source: 'client', clientName: e._clientName })),
    totalEvents: events.length,
  };
}

/**
 * List all events for a client: aggregates standalone client events
 * and matter events from all of the client's associated matters.
 */
/**
 * A client's events: every event on every matter they are on, plus the events
 * recorded against the client directly.
 *
 * Paging is opt-in — with no `limit` the complete list comes back, which is the
 * contract the calendar and the tab's own count read.
 *
 * Unlike the matter feed, the window is applied in memory rather than in SQL.
 * The list is a MERGE of two tables ordered by a shared date, so no single query
 * can produce the ordered set, and a LIMIT on either side would cut it before the
 * merge — the first ten client events and the first ten matter events are not the
 * first ten events. Both sides are already bounded by the client's own matters,
 * so the merged array is the same size the tab used to hand the browser whole;
 * what changes is that only a page of it now crosses the wire.
 */
export async function listClientEvents({ lawFirmId, clientId, userId, timezone, status, page, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const client = await clientsRepo.findById(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  // Widen to this client's own id plus every company it's linked to via
  // `client_company_links`, so the tab also surfaces events on a linked
  // company's matters and events recorded directly against that company.
  // `clientsRepo.listMatterIds` stays single-id (it also backs the client's
  // own portal and privacy export/erasure, which must NOT widen), so it's
  // called once per effective id here instead of being changed itself.
  const { clientIds: effectiveClientIds } = await resolveEffectiveClientIds(lawFirmId, clientId);
  // Bounded at three reads at once so a person linked to many companies cannot
  // take the shared pool; the first failure still rejects the list.
  const matterIdSettled = await runWithConcurrency(
    effectiveClientIds.map((id: string) => () => clientsRepo.listMatterIds(lawFirmId, id)),
    3,
  );
  const matterIdFailure = matterIdSettled.find((r: any) => r.status === 'rejected');
  if (matterIdFailure) throw matterIdFailure.reason;
  const matterIdLists = matterIdSettled.map((r: any) => r.value);
  const matterIds = [...new Set(matterIdLists.flat().filter(Boolean))];

  // Client records are visible firm-wide, but the matter events merged into
  // this client tab remain matter-confidential. A client association must not
  // turn the generic client read permission into a side door around the
  // owner/admin-or-matter-member rule the direct matter-event routes apply.
  const visibleMatterIds = await isFirmOwnerOrAdmin(lawFirmId, userId)
    ? matterIds
    : [...await getAccessibleMatterIds(lawFirmId, matterIds, userId)];

  // Batched: matter events across all the client's matters + a single matter-name lookup,
  // in parallel with the standalone client events (replaces two per-matter N+1 loops).
  const [matterEventsList, matterNameMap, standaloneEvents] = await Promise.all([
    matterEventsRepo.findAllForMatters(lawFirmId, visibleMatterIds),
    mattersRepo.getNamesByIds(lawFirmId, visibleMatterIds),
    clientEventsRepo.findAll(lawFirmId, effectiveClientIds).catch(() => []),
  ]);

  // Merge matter events (tagged with source: 'matter')
  const matterEvents = matterEventsList
    .map((e: any) => formatClientEvent(e, timezone, { source: 'matter', matterName: matterNameMap[e.matterId] || null }));

  // Merge standalone client events (tagged with source: 'client')
  const clientEventList = standaloneEvents.map((e: any) => formatClientEvent(e, timezone, { source: 'client' }));

  // Merge and sort by date asc (nulls last)
  const allEvents = [...matterEvents, ...clientEventList];
  allEvents.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  // Filtered BEFORE the window, so `totalEvents` describes the status section the
  // caller asked for rather than the whole feed — a pager built on the unfiltered
  // total would offer pages that render empty.
  const matching = status ? allEvents.filter((e) => e.status === status) : allEvents;

  if (!limit) return { events: matching, totalEvents: matching.length };

  const { limit: pageSize, offset: pageOffset } = resolvePage({
    limit, offset, page, fallbackLimit: 10, max: 200,
  });
  return {
    events: matching.slice(pageOffset, pageOffset + pageSize),
    totalEvents: matching.length,
  };
}

/**
 * Create a client event. If matterId is provided, creates a matter event (linked
 * to that matter). Otherwise creates a standalone client event.
 */
export async function createClientEvent({ lawFirmId, clientId, userId, timezone, type, title, date, endsAt, allDay, notes, courtId, locationName, location, status, matterId, assignedTo, assignedToName, contactIds, linkedFiles, clientVisible, clientDescription }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  // The caller belonging to the firm does not make the CLIENT belong to it. See
  // `assertClientInFirm`: without this the event is written with this firm's
  // `law_firm_id` and another firm's `client_id`, which no calendar in either
  // firm can show and which dies when the owning firm deletes that client.
  await assertClientInFirm(lawFirmId, clientId);
  const resolvedCourt = await resolveCourt(lawFirmId, courtId);
  const finalLocationName = locationName?.trim() || resolvedCourt?.name || null;

  if (matterId) {
    // This route is gated on `clients.manage`, not `matters.update` - a caller
    // who can only manage clients must not be able to reach into a matter's
    // events by routing the write through this "merged view" endpoint instead
    // of the matter events route directly. Assert the permission the direct
    // route requires before delegating.
    await assertFirmPermission(lawFirmId, userId, 'matters.update');
    // Delegate to matter events service. Creates in the matter's matterEvents sub-collection
    return matterEventsService.createMatterEvent({
      lawFirmId,
      matterId,
      userId,
      timezone,
      type,
      title,
      date,
      endsAt,
      allDay,
      notes,
      locationName: finalLocationName,
      location,
      status,
      // The matter service checks each assignee is on the matter before any write.
      assignedTo,
      contactIds,
      linkedFiles,
      clientVisible,
      clientDescription,
    });
  }

  const validatedAssignees = await resolveFirmAssignees(lawFirmId, assignedTo);

  // Standalone client event. Linked files are enriched with who linked them,
  // matching matterEventsService.createMatterEvent's enrichedFiles handling.
  const dateTs = resolveEventDate(date, timezone, allDay === true);
  // Same resolution as the start, so a span keeps its exact instants.
  const endsAtTs = endsAt === undefined ? null : resolveEventDate(endsAt, timezone, allDay === true);
  // The CHECK on `events` refuses this too, but a constraint violation reaches
  // the caller as a 500 blaming the system for what is a user mistake. The
  // pre-check gives the message; the constraint keeps the guarantee.
  assertEndAfterStart(dateTs, endsAtTs);
  const enrichedFiles = (linkedFiles || []).map((f: any) => ({
    ...f,
    linkedBy: userId,
    linkedAt: nowIso(),
  }));
  // One transaction for the row and both junctions, the way
  // `matterEvents.service#createMatterEvent` writes a matter event: a failure in
  // either junction leaves no event behind. The bus event is deferred until the
  // commit, so calendar sync never reads a row that could still roll back.
  return withTransactionEffects(async ({ executor, defer }) => {
    if (!await clientEventsRepo.lockClientRow(lawFirmId, clientId, executor)) throw new NotFoundError('Client');
    const created = await clientEventsRepo.create(lawFirmId, clientId, {
      type,
      title: title.trim(),
      date: dateTs,
      endsAt: endsAtTs,
      notes: notes?.trim() || null,
      courtId: resolvedCourt?.id || null,
      locationName: finalLocationName,
      location: location?.trim() || null,
      status: status || 'upcoming',
      createdBy: userId,
      allDay: allDay === true,
      assignedTo: validatedAssignees,
      assignedToName: assignedToName || [],
      clientVisible: clientVisible === true,
      clientDescription: clientDescription?.trim() || null,
      timeZone: timezone,
      linkedFiles: enrichedFiles,
    }, executor);

    // Non-member attendees (opposing counsel, a guardian, an expert) live in a
    // junction, so they are written after the row exists.
    if (contactIds !== undefined) {
      await clientEventsRepo.syncContacts(lawFirmId, created.id, contactIds, executor);
    }
    // Assignees are rows since migration 0218. The display names come from the
    // join on read, so a caller-supplied `assignedToName` is no longer stored.
    await clientEventsRepo.syncAssignees(lawFirmId, created.id, validatedAssignees, executor);

    const fresh = await clientEventsRepo.findById(lawFirmId, clientId, created.id, executor);

    defer(() => {
      eventBus.emit(CLIENT_EVENT_CREATED, {
        lawFirmId,
        clientId,
        eventId: created.id,
        eventData: fresh,
        userId,
        timeZone: timezone,
      });
    });

    return {
      message: 'Client event created successfully',
      eventId: created.id,
      event: formatClientEvent(fresh, timezone, { source: 'client' }),
    };
  });
}

/**
 * Update a client event. If source is 'matter', delegates to matterEventsService.
 * Otherwise updates in clientEventsRepo.
 */
export async function updateClientEvent({ lawFirmId, clientId, userId, timezone, eventId, source, matterId, type, title, date, endsAt, allDay, notes, courtId, locationName, location, status, assignedTo, assignedToName, contactIds, linkedFiles, clientVisible, clientDescription }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const resolvedCourt = await resolveCourt(lawFirmId, courtId);
  const finalLocationName = locationName === undefined
    ? undefined
    : locationName?.trim() || (courtId !== undefined ? (resolvedCourt?.name || null) : null);

  if (source === 'matter') {
    if (!matterId) throw new NotFoundError('Matter event');
    // Same permission gate the direct matter events route enforces - see the
    // comment in createClientEvent above.
    await assertFirmPermission(lawFirmId, userId, 'matters.update');
    return matterEventsService.updateMatterEvent({
      lawFirmId,
      matterId,
      eventId,
      userId,
      timezone,
      type,
      title,
      date,
      endsAt,
      allDay,
      notes,
      locationName: finalLocationName,
      location,
      status,
      // The matter service checks each assignee is on the matter before any write.
      assignedTo,
      contactIds,
      linkedFiles,
      clientVisible,
      clientDescription,
    });
  }

  const validatedAssignees = assignedTo === undefined
    ? undefined
    : await resolveFirmAssignees(lawFirmId, assignedTo);

  // The row, its junctions and the read-back commit together; see createClientEvent.
  return withTransactionEffects(async ({ executor, defer }) => {
    if (!await clientEventsRepo.lockClientRow(lawFirmId, clientId, executor)) throw new NotFoundError('Client event');
    const existing = await clientEventsRepo.findById(lawFirmId, clientId, eventId, executor);
    if (!existing) throw new NotFoundError('Client event');

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
    if (allDay !== undefined) updates.allDay = allDay === true;
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    // The name is not stored; the repository joins `courts` for it (migration 0205).
    if (courtId !== undefined) updates.courtId = resolvedCourt?.id || null;
    if (locationName !== undefined) updates.locationName = finalLocationName;
    if (location !== undefined) updates.location = location?.trim() || null;
    if (status !== undefined) updates.status = status;
    if (clientVisible !== undefined) updates.clientVisible = clientVisible === true;
    if (clientDescription !== undefined) updates.clientDescription = clientDescription?.trim() || null;
    // Forms submit the full schedule even for a title or status edit. Preserve
    // the original zone unless the start or its all-day meaning actually changes.
    if ((date !== undefined && updates.date?.getTime() !== (existing.date ? new Date(existing.date).getTime() : undefined))
      || effectiveAllDay !== (existing.allDay === true)) updates.timeZone = timezone;
    if (linkedFiles !== undefined) {
      updates.linkedFiles = linkedFiles.map((f: any) => ({
        ...f,
        linkedBy: f.linkedBy || userId,
        linkedAt: f.linkedAt || nowIso(),
      }));
    }

    const updated = await clientEventsRepo.update(lawFirmId, clientId, eventId, updates, executor);

    if (validatedAssignees !== undefined) {
      await clientEventsRepo.syncAssignees(lawFirmId, eventId, validatedAssignees, executor);
    }
    if (contactIds !== undefined) {
      await clientEventsRepo.syncContacts(lawFirmId, eventId, contactIds, executor);
    }
    const updatedFresh = (contactIds !== undefined || assignedTo !== undefined)
      ? await clientEventsRepo.findById(lawFirmId, clientId, eventId, executor)
      : null;
    updated.contacts = contactIds !== undefined
      ? (updatedFresh?.contacts || [])
      : (existing.contacts || []);
    updated.assignedTo = updatedFresh?.assignedTo ?? existing.assignedTo ?? [];
    updated.assignedToName = updatedFresh?.assignedToName ?? existing.assignedToName ?? [];

    if (status === 'cancelled' && existing.status !== 'cancelled') {
      defer(() => {
        eventBus.emit(CLIENT_EVENT_DELETED, {
          lawFirmId,
          clientId,
          eventId,
          eventData: updated,
          userId,
        });
      });
    } else {
      defer(() => {
        eventBus.emit(CLIENT_EVENT_UPDATED, {
          lawFirmId,
          clientId,
          eventId,
          eventData: updated,
          userId,
          timeZone: timezone,
        });
      });
    }

    return {
      message: 'Client event updated successfully',
      event: formatClientEvent(updated, timezone, { source: 'client' }),
    };
  });
}

/**
 * Delete a client event. If source is 'matter', delegates to matterEventsService.
 * Otherwise deletes from clientEventsRepo.
 */
export async function deleteClientEvent({ lawFirmId, clientId, userId, eventId, source, matterId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  if (source === 'matter') {
    if (!matterId) throw new NotFoundError('Matter event');
    // Same permission gate the direct matter events route enforces - see the
    // comment in createClientEvent above.
    await assertFirmPermission(lawFirmId, userId, 'matters.update');
    return matterEventsService.deleteMatterEvent({ lawFirmId, matterId, eventId, userId });
  }

  return withTransactionEffects(async ({ executor, defer }) => {
    if (!await clientEventsRepo.lockClientRow(lawFirmId, clientId, executor)) throw new NotFoundError('Client event');
    const existing = await clientEventsRepo.findById(lawFirmId, clientId, eventId, executor);
    if (!existing) throw new NotFoundError('Client event');

    await clientEventsRepo.delete(lawFirmId, clientId, eventId, executor);

    defer(() => {
      eventBus.emit(CLIENT_EVENT_DELETED, {
        lawFirmId,
        clientId,
        eventId,
        eventData: existing,
        userId,
      });
    });

    return { message: 'Client event deleted successfully', eventId };
  });
}

/**
 * Before a client is removed: emit CLIENT_EVENT_DELETED for every one of its
 * standalone events so `calendar.events.ts` can pull each off whichever
 * member's real Google/Outlook calendar it was synced to and drop the
 * `calendar_mappings` row, before `events.client_id ... on delete
 * cascade` (schema.sql) removes the rows out from under it. Mirrors
 * `matterEvents.service#emitCalendarDeletesForAllMatterEvents`.
 *
 * Emit once per member with a current provider map, using the union of Google
 * and Outlook user IDs. A client event may have copies on multiple calendars.
 */
export async function emitCalendarDeletesForAllClientEvents({ lawFirmId, clientId }: any) {
  if (!lawFirmId || !clientId) return;

  const events = await clientEventsRepo.findAll(lawFirmId, clientId);
  for (const ev of events) {
    const syncedUserIds = new Set<string>([
      ...Object.keys(ev.calendarSync?.google || {}),
      ...Object.keys(ev.calendarSync?.outlook || {}),
    ]);

    for (const uid of syncedUserIds) {
      eventBus.emit(CLIENT_EVENT_DELETED, {
        lawFirmId,
        clientId,
        eventId: ev.id,
        eventData: ev,
        userId: uid,
      });
    }
  }
}
