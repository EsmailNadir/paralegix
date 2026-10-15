const eventBus = require('../../../shared/events/eventBus');
const { TIME_ENTRY_CHANGED } = require('../../../shared/events/eventTypes');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../../shared/errors/AppError');
const { assertLawFirmMembership, getAccessibleMatterIds } = require('../../../shared/utils/membership');
const { resolveClientsInFirm } = require('../../../shared/utils/clientScope');
const { resolveContext, authorizeContext, CONTEXT_TYPES, MODE_READ } = require('../context');
const timeEntriesRepo = require('./timeEntries.repository');
const invoicesRepo = require('../invoices/invoices.repository');
const billingReads = require('../shared/billingReads');
const { getFirmBillingSettings } = require('../shared/billingSettings');
const { roundHoursUp } = require('../shared/timeRounding');
const { zonedDayString } = require('../../../shared/utils/time');
const { assertBillingCodeInFirm } = require('../shared/billingCodeGuard');
const firmBillingService = require('../shared/firmBilling.service');
const { MAX_PAGE_SIZE } = require('../shared/firmBillingWindow');
const tasksRepo = require('../../tasks/tasks.repository');
const matterEventsRepo = require('../../matters/matterEvents.repository');
const mattersRepo = require('../../matters/matters.repository');
const usersRepo = require('../../users/users.repository');
const { assertFirmPermission, loadResolvedMember } = require('../../lawfirms/roles/requirePermission');

/**
 * Acting on an entry whose timekeeper is someone else (editing, moving or
 * deleting it, or logging hours in their name) needs this code on top of
 * `billing.manageTimeEntries`. Acting on one's own entries does not.
 */
const MANAGE_OTHERS_PERMISSION = 'billing.manageOthersTimeEntries';

/**
 * Refuse unless the caller is the entry's timekeeper or may manage other
 * members' time. Firm-level time has no timekeeper (`null`), so it is nobody's
 * own and needs the code too.
 */
async function assertMayActOnTimekeeper({ lawFirmId, actingUserId, timekeeperId }: any) {
  if (timekeeperId && timekeeperId === actingUserId) return;
  await assertFirmPermission(lawFirmId, actingUserId, MANAGE_OTHERS_PERMISSION);
}

async function mayManageOthersTime(lawFirmId: string, actingUserId: string) {
  const member = await loadResolvedMember(lawFirmId, actingUserId);
  if (!member) return false;
  return !!member.isOwner || member.resolvedPermissions.includes(MANAGE_OTHERS_PERMISSION);
}

function formatEntry(entry: any) {
  return {
    id: entry.id,
    ...entry,
    date: entry.date || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

/**
 * Hours as they will be stored. Applies the firm's rounding, then refuses a
 * value that numeric(6,2) would store as zero. The route schema has the same
 * floor; this one also covers callers that reach the service directly (a
 * note's "Add time").
 */
function storableHours(hours: any, timeRounding: any) {
  const billed = roundHoursUp(hours, timeRounding);
  if (!(Math.round(Number(billed) * 100) >= 1)) {
    throw new ValidationError({ hours: ['hours must be at least 0.01'] });
  }
  return billed;
}

/**
 * An entry's date as the UTC-midnight anchor of its calendar day. A day-only
 * string already names its day; a timestamp is projected into the caller's zone
 * so the stored day is the one the caller sees on their clock.
 */
function parseDateOrThrow(date: any, timeZone?: any) {
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) {
    throw new ValidationError({ date: ['Invalid date format'] });
  }
  const day = zonedDayString(date, timeZone);
  return day ? new Date(`${day}T00:00:00.000Z`) : parsed;
}

/**
 * Validate a task/event source link against the billing context it is being
 * recorded under, and return the ids to persist. Display titles are NOT returned:
 * they are joined at read time so a rename propagates to existing entries.
 *
 * A task with no matter and no clients has no billing context of its own, so it
 * can be linked to whatever matter or client the user picks — the check below only
 * rejects a task that belongs to a *different* context than the one selected.
 */
async function resolveSourceMetadata({ lawFirmId, resolvedContext, sourceTaskId, sourceEventId }: any) {
  if (sourceTaskId && sourceEventId) {
    throw new ValidationError({ sourceTaskId: ['Select either a task or an event source'] });
  }

  if (sourceTaskId) {
    const task = await tasksRepo.findByIdRaw(lawFirmId, sourceTaskId);

    if (!task) {
      throw new ValidationError({ sourceTaskId: ['Selected task no longer exists'] });
    }

    const taskClientIds = Array.isArray(task.clientIds) ? task.clientIds : [];
    const isUnscopedTask = !task.matterId && taskClientIds.length === 0;

    const matchesMatterContext =
      resolvedContext.type === CONTEXT_TYPES.matter && task.matterId === resolvedContext.entityId;
    const matchesClientContext =
      resolvedContext.type === CONTEXT_TYPES.client && taskClientIds.includes(resolvedContext.entityId);

    if (!isUnscopedTask && !matchesMatterContext && !matchesClientContext) {
      throw new ValidationError({ sourceTaskId: ['Task does not belong to the selected billing context'] });
    }

    return { sourceTaskId, sourceEventId: null };
  }

  if (sourceEventId) {
    if (resolvedContext.type !== CONTEXT_TYPES.matter) {
      throw new ValidationError({ sourceEventId: ['Events can only be logged against a matter'] });
    }

    const event = await matterEventsRepo.findById(lawFirmId, resolvedContext.entityId, sourceEventId);

    if (!event) {
      throw new ValidationError({ sourceEventId: ['Selected event no longer exists'] });
    }

    return { sourceTaskId: null, sourceEventId };
  }

  return { sourceTaskId: null, sourceEventId: null };
}

async function assertTargetUserAllowed({ lawFirmId, context, targetUserId }: any) {
  if (!targetUserId) return;

  if (context.type === CONTEXT_TYPES.matter) {
    const matterData = await mattersRepo.findByIdRaw(lawFirmId, context.entityId);
    const members = matterData?.members || [];
    if (!members.find((m: any) => m && m.userId === targetUserId)) {
      throw new ValidationError({ userId: ['User is not a member of this matter'] });
    }
    return;
  }

  await assertLawFirmMembership(lawFirmId, targetUserId);
}

async function resolvePreferredMatterClients({ lawFirmId, resolvedContext, matterClientIds }: any) {
  const normalizedIds = Array.from(new Set((Array.isArray(matterClientIds) ? matterClientIds : []).filter(Boolean)));
  if (normalizedIds.length === 0) return [];

  if (resolvedContext.type !== CONTEXT_TYPES.matter) {
    throw new ValidationError({ matterClientIds: ['Preferred clients can only be set for matter time entries'] });
  }

  const matterClients = await mattersRepo.listMatterClients(lawFirmId, resolvedContext.entityId);
  const byId = new Map(matterClients.map((client: any) => [client.id, client]));

  const missingIds = normalizedIds.filter((matterClientId) => !byId.has(matterClientId));
  if (missingIds.length > 0) {
    throw new ValidationError({ matterClientIds: ['One or more selected preferred clients are not linked to this matter'] });
  }

  return normalizedIds.map((matterClientId) => byId.get(matterClientId));
}

/**
 * Validate moving a client-logged time entry onto one of that client's matters,
 * returning the target matter id.
 *
 * Work is often logged against a client before a matter exists for it (intake,
 * a consultation), and it should be billable under the matter once one is open.
 * Two rules make that safe:
 *  - only CLIENT-context entries move. Shifting work between matters would
 *    silently restate two matters' records at once;
 *  - the target matter must already list this client. Without that check a
 *    firm could file one client's work under an unrelated client's matter,
 *    which is a confidentiality problem, not just a reporting one;
 *  - the acting user must be a member of the target matter, the same standing
 *    logging time there directly needs, and so must the entry's own timekeeper.
 */
async function resolveMoveToMatter({ lawFirmId, resolvedContext, matterId, actingUserId, timekeeperId }: any) {
  if (resolvedContext.type !== CONTEXT_TYPES.client) {
    throw new ValidationError({ matterId: ['Only time logged against a client can be moved to a matter'] });
  }

  const matter = await mattersRepo.findByIdRaw(lawFirmId, matterId);
  if (!matter) {
    throw new NotFoundError('Matter');
  }

  // Moving time onto a matter writes to it, so it needs the standing that
  // logging time there directly needs: membership of the matter. Checked before
  // the matter's roster is read, so a non-member learns nothing about it.
  await authorizeContext({ type: CONTEXT_TYPES.matter, lawFirmId, entityId: matterId }, actingUserId);

  const clientId = resolvedContext.entityId;
  const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId);
  if (!matterClients.some((client: any) => client.id === clientId)) {
    throw new ValidationError({
      matterId: ['That matter does not belong to this client. Add the client to the matter first.'],
    });
  }

  // The entry's own timekeeper has to be on the matter too, the rule direct
  // creation applies to whoever the time is logged for. An entry with no
  // timekeeper (firm-level time) is exempt there as well.
  await assertTargetUserAllowed({
    lawFirmId,
    context: { type: CONTEXT_TYPES.matter, entityId: matterId },
    targetUserId: timekeeperId,
  });

  return matterId;
}

/**
 * Create a time entry for a matter or client context.
 */
export async function createTimeEntry({ lawFirmId, matterId, clientId, context, actingUserId, timeZone, body }: any) {
  const resolvedContext = resolveContext({
    lawFirmId,
    context: context || body.context,
    matterId: matterId || body.matterId,
    clientId: clientId || body.clientId,
  });

  const {
    userId,
    hours,
    date,
    matterClientIds,
    name,
    description,
    hourlyRate,
    chargeCodeId,
    sourceTaskId,
    sourceEventId,
    utbmsTaskCode,
    utbmsActivityCode,
    billable,
    // Set only when a note's own "Add time" created this entry, so the note
    // panel can find its way back to it. Never set by the Log Time modal.
    linkedNoteId,
    source,
  } = body;
  await authorizeContext(resolvedContext, actingUserId);
  await assertMayActOnTimekeeper({
    lawFirmId,
    actingUserId,
    timekeeperId: userId === 'FIRM' ? null : userId,
  });
  await assertBillingCodeInFirm('charge', lawFirmId, chargeCodeId || null, 'chargeCodeId');

  const firmBillingSettings = await getFirmBillingSettings(lawFirmId);
  const billedHours = storableHours(hours, firmBillingSettings.timeRounding);

  // `'FIRM'` is time logged to the firm rather than to a person. It is not a
  // user id, and `activities.user_id` is a real key to `users`, so it is stored
  // as no user; the name is a display convention only.
  const timekeeperId = userId === 'FIRM' ? null : userId;
  let userName = '';
  if (userId === 'FIRM') {
    userName = 'Firm';
  } else {
    await assertTargetUserAllowed({
      lawFirmId,
      context: resolvedContext,
      targetUserId: userId,
    });

    const user = await usersRepo.findById(userId);
    userName = user?.name || '';
  }

  const entryDate = parseDateOrThrow(date, timeZone);
  const sourceMetadata = await resolveSourceMetadata({
    lawFirmId,
    resolvedContext,
    sourceTaskId: sourceTaskId || null,
    sourceEventId: sourceEventId || null,
  });
  const preferredMatterClients: any[] = await resolvePreferredMatterClients({
    lawFirmId,
    resolvedContext,
    matterClientIds: Array.isArray(matterClientIds) ? matterClientIds : [],
  });

  // Rated at write time. The rate an entry carries is decided when the work is
  // recorded, not when it happens to be read, so a later change to a member's
  // default or a client's negotiated rate leaves this entry where it was.
  const rated = await billingReads.resolveEntryRate(lawFirmId, {
    contextType: resolvedContext.type,
    entityId: resolvedContext.entityId,
    userId: timekeeperId,
    chargeCodeId: chargeCodeId || null,
    hourlyRate: typeof hourlyRate === 'number' ? hourlyRate : null,
    // The VALIDATED list, the same one the row is written with below. Resolving
    // the rate from the raw request instead would let a stamped rate name one
    // payer while the stored entry names another.
    matterClientIds: preferredMatterClients.map((client: any) => client.id),
  });

  const entry = await timeEntriesRepo.create(resolvedContext, {
    lawFirmId,
    contextType: resolvedContext.type,
    entityId: resolvedContext.entityId,
    matterId: resolvedContext.type === CONTEXT_TYPES.matter ? resolvedContext.entityId : null,
    matterClientIds: preferredMatterClients.length > 0 ? preferredMatterClients.map((client) => client.id) : [],
    clientContextId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    clientId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    userId: timekeeperId,
    userName,
    hours: billedHours,
    date: entryDate,
    name: (name || '').trim(),
    description: (description || '').trim(),
    hourlyRate: typeof hourlyRate === 'number' ? hourlyRate : null,
    resolvedRateCents: rated.resolvedRateCents,
    rateSource: rated.rateSource,
    chargeCodeId: chargeCodeId || null,
    ...sourceMetadata,
    utbmsTaskCode: utbmsTaskCode || null,
    utbmsActivityCode: utbmsActivityCode || null,
    billable: billable !== false,
    linkedNoteId: linkedNoteId || null,
    source: source || null,
    createdBy: actingUserId,
  });

  eventBus.emit(TIME_ENTRY_CHANGED, {
    type: resolvedContext.type,
    lawFirmId,
    entityId: resolvedContext.entityId,
    userId,
    entryId: entry.id,
  });

  return { message: 'Time entry created successfully', timeEntry: formatEntry(entry) };
}

/**
 * List time entries for a matter or client context, optionally filtered by userId.
 */
/**
 * Time entries for one matter/client context.
 *
 * `unbilledOnly` drops entries already carried by an invoice before the response
 * is built. It is opt-in: callers that ask for nothing still get the complete
 * list, including billed entries, which is what the time-tracking and
 * client-billing views render.
 *
 * The filter deliberately runs HERE, on the derived `isBilled` flag, rather than
 * as a `where billed = false` in SQL. `isBilled` means "appears on an invoice for
 * this context" and is computed from the invoices this function already loads;
 * the `billed` column is a separate denormalized flag. Filtering on the column
 * would give an unbilled list assembled from a different definition than the
 * `isBilled` every caller displays, which is exactly where a quiet money
 * discrepancy would live.
 */
export async function listTimeEntries({ lawFirmId, matterId, clientId, context, actingUserId, userId, unbilledOnly = false }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId, MODE_READ);

  if (userId) {
    await assertTargetUserAllowed({ lawFirmId, context: resolvedContext, targetUserId: userId });
  }

  // The billed-id set comes from one query against the line items rather than
  // from loading every invoice in the context and walking its graph. Same
  // definition — the graph's line items ARE these rows — but it stops pulling
  // the whole invoice tree plus its five child tables to answer a set-membership
  // question. See `billedSourceIds`.
  const [entries, billedTimeEntryIds] = await Promise.all([
    timeEntriesRepo.findByContext(resolvedContext, userId || null),
    billingReads.billedSourceIds(resolvedContext, 'time_entry'),
  ]);

  // No re-sort here: `date` is a day-only 'YYYY-MM-DD' string, and the Firestore
  // `.toDate()` this used to call returned undefined on it, so every sort key was 0
  // and the comparator did nothing. The repository already orders by entry_date desc.

  const timeEntries = entries
    .map((entry: any) => ({
      ...formatEntry(entry),
      isBilled: billedTimeEntryIds.has(entry.id),
    }))
    .filter((entry: any) => !unbilledOnly || !entry.isBilled);

  return { timeEntries };
}

/**
 * Update a time entry.
 */
export async function updateTimeEntry({ lawFirmId, matterId, clientId, context, timeEntryId, actingUserId, timeZone, body }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await timeEntriesRepo.findById(resolvedContext, timeEntryId);
  if (!existing) {
    throw new NotFoundError('Time entry');
  }

  await assertMayActOnTimekeeper({ lawFirmId, actingUserId, timekeeperId: existing.userId });

  // An invoiced entry exists on the invoice as a line-item snapshot. Editing the
  // fields that snapshot was computed from would diverge the firm's records from
  // the client's issued invoice, so they are frozen once billed (the same reason
  // deleteTimeEntry blocks outright). Descriptive fields and the task/event link
  // stay editable: they do not change what was charged.
  // Moving the entry restates which matter the work belongs to, so it is frozen
  // once billed for the same reason the money fields are.
  const FROZEN_ONCE_BILLED = ['hours', 'hourlyRate', 'date', 'chargeCodeId', 'matterClientId', 'matterClientIds', 'billable', 'matterId'];
  const attemptedFrozenEdits = FROZEN_ONCE_BILLED.filter((field) => body[field] !== undefined);
  if (attemptedFrozenEdits.length > 0
      && await billingReads.isSourceBilled(resolvedContext, 'time_entry', [existing.id])) {
    throw new ForbiddenError('Cannot change the hours, rate, date, or billing of a time entry that has been billed on an invoice');
  }

  const updateData: Record<string, any> = {};

  if (body.matterId !== undefined) {
    updateData.matterId = await resolveMoveToMatter({
      lawFirmId,
      resolvedContext,
      matterId: body.matterId,
      actingUserId,
      timekeeperId: existing.userId,
    });
    // activities carries a matter XOR a client, so the client link has to go
    // when the matter arrives. The client it was logged for is preserved as the
    // matter-client attribution, which is what the per-client reporting reads.
    const originClientId = resolvedContext.entityId;
    updateData.clientId = null;
    updateData.matterClientIds = originClientId ? [originClientId] : [];

    // The entry may have been logged from one of the client's own tasks. That
    // task does not move with it, and every other write path rejects a source
    // link that belongs to a different context than the entry, so keep the link
    // only while it still fits the destination and drop it otherwise. Left
    // alone, a matter entry would cite a task belonging to a client.
    if (existing.sourceTaskId) {
      const sourceTask = await tasksRepo.findByIdRaw(lawFirmId, existing.sourceTaskId);
      const taskClientIds = Array.isArray(sourceTask?.clientIds) ? sourceTask.clientIds : [];
      const stillFits = sourceTask
        && (sourceTask.matterId === updateData.matterId
          || (!sourceTask.matterId && taskClientIds.length === 0));
      // Both source columns move together, per the check constraint that allows
      // at most one of them.
      if (!stillFits) {
        updateData.sourceTaskId = null;
        updateData.sourceEventId = null;
      }
    }
  }

  if (body.hours !== undefined) {
    const firmBillingSettings = await getFirmBillingSettings(lawFirmId);
    updateData.hours = storableHours(body.hours, firmBillingSettings.timeRounding);
  }
  if (body.date !== undefined) updateData.date = body.date ? parseDateOrThrow(body.date, timeZone) : null;
  if (body.matterClientIds !== undefined) {
    const preferredMatterClients: any[] = await resolvePreferredMatterClients({
      lawFirmId,
      resolvedContext,
      matterClientIds: Array.isArray(body.matterClientIds) ? body.matterClientIds : [],
    });
    updateData.matterClientIds = preferredMatterClients.length > 0 ? preferredMatterClients.map((client) => client.id) : [];
  }
  if (body.name !== undefined) updateData.name = body.name.trim();
  if (body.description !== undefined) updateData.description = body.description.trim();
  if (body.hourlyRate !== undefined) updateData.hourlyRate = typeof body.hourlyRate === 'number' ? body.hourlyRate : null;
  if (body.chargeCodeId !== undefined) {
    await assertBillingCodeInFirm('charge', lawFirmId, body.chargeCodeId || null, 'chargeCodeId');
    updateData.chargeCodeId = body.chargeCodeId || null;
  }
  if (body.utbmsTaskCode !== undefined) updateData.utbmsTaskCode = body.utbmsTaskCode || null;
  if (body.utbmsActivityCode !== undefined) updateData.utbmsActivityCode = body.utbmsActivityCode || null;
  if (body.billable !== undefined) updateData.billable = body.billable !== false;

  // Re-point (or clear) the task/event this time was recorded against. Both ids
  // are always written together so the single-source constraint holds and a stale
  // link can never survive on the other column.
  if (body.sourceTaskId !== undefined || body.sourceEventId !== undefined) {
    // Setting one side implicitly clears the other, so switching an entry from an
    // event to a task (or back) does not read as "both supplied" and get rejected.
    const sourceMetadata = await resolveSourceMetadata({
      lawFirmId,
      resolvedContext,
      sourceTaskId: body.sourceTaskId !== undefined
        ? body.sourceTaskId
        : (body.sourceEventId ? null : existing.sourceTaskId),
      sourceEventId: body.sourceEventId !== undefined
        ? body.sourceEventId
        : (body.sourceTaskId ? null : existing.sourceEventId),
    });
    Object.assign(updateData, sourceMetadata);
  }

  // A move leaves the entry outside the context it was requested under, so both
  // the read-back and the change event have to follow it to the matter. Reading
  // under the old client context returns nothing once client_id is cleared.
  const destinationContext = updateData.matterId
    ? { type: CONTEXT_TYPES.matter, lawFirmId, entityId: updateData.matterId }
    : resolvedContext;

  // Re-rated only when one of the rate's own inputs changed: the override, the
  // charge code, or the context the entry is billed under. Anything else leaves
  // the stored rate alone, which is the point of storing it.
  // `matterClientIds` joins the list because the payer decides which client's
  // negotiated rate applies: moving an entry to another client on the same
  // matter changes its rate exactly as moving it to another matter does.
  if (body.hourlyRate !== undefined || body.chargeCodeId !== undefined
      || body.matterId !== undefined || body.matterClientIds !== undefined) {
    const rated = await billingReads.resolveEntryRate(lawFirmId, {
      contextType: destinationContext.type,
      entityId: destinationContext.entityId,
      userId: existing.userId || null,
      chargeCodeId: updateData.chargeCodeId !== undefined ? updateData.chargeCodeId : (existing.chargeCodeId || null),
      hourlyRate: updateData.hourlyRate !== undefined ? updateData.hourlyRate : (existing.hourlyRate ?? null),
      matterClientIds: updateData.matterClientIds !== undefined
        ? updateData.matterClientIds : (existing.matterClientIds || null),
    });
    updateData.resolvedRateCents = rated.resolvedRateCents;
    updateData.rateSource = rated.rateSource;
  }

  const updated = await timeEntriesRepo.update(resolvedContext, timeEntryId, updateData);
  const finalEntry = updateData.matterId
    ? await timeEntriesRepo.findById(destinationContext, timeEntryId)
    : updated;

  eventBus.emit(TIME_ENTRY_CHANGED, {
    type: destinationContext.type,
    lawFirmId,
    entityId: destinationContext.entityId,
    userId: existing.userId,
    entryId: timeEntryId,
  });

  return { message: 'Time entry updated successfully', timeEntry: formatEntry(finalEntry) };
}

/**
 * Delete a time entry.
 */
export async function deleteTimeEntry({ lawFirmId, matterId, clientId, context, timeEntryId, actingUserId }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await timeEntriesRepo.findById(resolvedContext, timeEntryId);
  if (!existing) {
    throw new NotFoundError('Time entry');
  }

  await assertMayActOnTimekeeper({ lawFirmId, actingUserId, timekeeperId: existing.userId });

  // Block deletion of a time entry already billed on an invoice: it exists there
  // as a line-item snapshot, so removing the source would diverge the firm's
  // records from the client's issued invoice.
  if (await billingReads.isSourceBilled(resolvedContext, 'time_entry', [existing.id])) {
    throw new ForbiddenError('Cannot delete a time entry that has been billed on an invoice');
  }

  await timeEntriesRepo.delete(resolvedContext, timeEntryId);

  eventBus.emit(TIME_ENTRY_CHANGED, {
    type: resolvedContext.type,
    lawFirmId,
    entityId: resolvedContext.entityId,
    userId: existing.userId,
    entryId: timeEntryId,
  });

  return { message: 'Time entry deleted successfully' };
}

/**
 * The most time-entry ids `POST /billing/time-entries/bulk-delete` accepts.
 *
 * One thousand, which is exactly what the firm time-entry list's "select all
 * matching" can produce: `FIRM_TIME_ENTRY_SELECT_ALL_CEILING` in
 * `frontend/src/services/billing.service.ts` is `FIRM_BILLING_MAX_LIMIT` (200,
 * the same `MAX_PAGE_SIZE` this module's list route enforces) times the five
 * pages that walk will make. A lower cap would turn a full, legitimate
 * selection into a 400; a higher one would accept an id list no screen in the
 * app could have assembled.
 *
 * Refused whole rather than truncated. A caller handed a silent subset would
 * report a delete that never happened for the tail of its selection.
 */
export const MAX_BULK_TIME_ENTRY_IDS = 1000;

/**
 * Delete a selection of time entries in one request.
 *
 * WHY. The three time-entry panels used to send one DELETE per selected row, so
 * a select-all delete was up to a thousand round trips against an instance that
 * holds twelve Postgres connections for every user on it.
 *
 * PER-ENTRY OUTCOMES, NOT ALL-OR-NOTHING. Two rules refuse a single delete and
 * both still refuse one here: an entry the caller cannot reach (`authorizeContext`
 * write access: matter membership for matter work, firm membership plus the
 * client belonging to this firm for client work) and an entry an invoice already
 * carries (`billingReads`, whose authority is `invoice_line_items`, with
 * `activities_billed_immutable` as the database's own backstop). A refusal is
 * reported against that id in `errors` and the rest of the batch still goes,
 * because the alternative is one billed row in a thousand-row selection
 * cancelling the other 999.
 *
 * A CONSTANT NUMBER OF QUERIES. Every decision above is resolved for the whole
 * batch at once: one read for the entries, one for the matters the user is
 * staffed on, one for the clients that are this firm's, one for the ids an
 * invoice names, and one delete. Resolving any of them per entry would put the
 * burst back on the pool in a different place.
 */
export async function bulkDeleteTimeEntries({ lawFirmId, timeEntryIds, actingUserId }: any) {
  // Proves the CALLER belongs to this firm before anything is read. The ids
  // themselves are scoped to the firm by the read below, so an outsider sending
  // another firm's ids under their own firm matches nothing either way.
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const requestedIds = (Array.isArray(timeEntryIds) ? timeEntryIds : []).map(String);
  const uniqueIds = [...new Set(requestedIds)];
  const errors: Record<string, string> = {};

  const entries = await timeEntriesRepo.findManyForFirm(lawFirmId, uniqueIds);
  const byId = new Map(entries.map((entry: any) => [entry.id, entry]));
  for (const id of uniqueIds) {
    // A malformed id, an id from another firm and an id that never existed are
    // answered identically: anything else confirms which ids are real elsewhere.
    if (!byId.has(id)) errors[id] = 'Time entry not found';
  }

  const matterIds = entries
    .filter((entry: any) => entry.contextType === CONTEXT_TYPES.matter)
    .map((entry: any) => entry.matterId);
  const clientIds = entries
    .filter((entry: any) => entry.contextType === CONTEXT_TYPES.client)
    .map((entry: any) => entry.clientId);

  const [accessibleMatters, clientsInFirm, billedIds] = await Promise.all([
    getAccessibleMatterIds(lawFirmId, matterIds, actingUserId),
    resolveClientsInFirm(lawFirmId, clientIds),
    billingReads.billedSourceIdsForFirm(lawFirmId, 'time_entry', entries.map((e: any) => e.id)),
  ]);

  // Another member's entry in a selection refuses the WHOLE request, unlike the
  // per-entry outcomes below: a caller without the right to delete other
  // members' time sent a selection that was never theirs to make, and silently
  // deleting its own rows would hide that. Only entries the caller can already
  // reach count, so the refusal never confirms a teammate's entry on a matter
  // the caller is not staffed on.
  const mayManageOthers = await mayManageOthersTime(lawFirmId, actingUserId);

  const deletable: any[] = [];
  for (const entry of entries) {
    if (entry.contextType === CONTEXT_TYPES.matter && !accessibleMatters.has(entry.matterId)) {
      errors[entry.id] = 'User is not a member of this matter';
      continue;
    }
    if (entry.contextType === CONTEXT_TYPES.client && !clientsInFirm.has(entry.clientId)) {
      errors[entry.id] = 'Time entry not found';
      continue;
    }
    if (!mayManageOthers && entry.userId !== actingUserId) {
      throw new ForbiddenError('You do not have permission to delete other members\' time entries');
    }
    if (billedIds.has(entry.id)) {
      // Same refusal as `deleteTimeEntry`: the entry exists on the invoice as a
      // line-item snapshot, so removing the source would leave the firm's
      // records disagreeing with the document the client already has.
      errors[entry.id] = 'Cannot delete a time entry that has been billed on an invoice';
      continue;
    }
    deletable.push(entry);
  }

  const deleted = deletable.length > 0
    ? await timeEntriesRepo.deleteManyForFirm(lawFirmId, deletable.map((entry: any) => entry.id))
    : 0;

  // One event per CONTEXT, not per entry: every listener of this event
  // invalidates a context's derived billing figures, so a matter whose fifty
  // entries just went needs to hear that once.
  const notified = new Set<string>();
  for (const entry of deletable) {
    const key = `${entry.contextType}:${entry.entityId}`;
    if (notified.has(key)) continue;
    notified.add(key);
    eventBus.emit(TIME_ENTRY_CHANGED, {
      type: entry.contextType,
      lawFirmId,
      entityId: entry.entityId,
    });
  }

  return {
    message: 'Bulk delete completed',
    requested: requestedIds.length,
    deleted,
    failed: Object.keys(errors),
    errors,
  };
}

/**
 * List time entries across the firm (accessible matters + client-context entries),
 * bounded by the HTTP ceiling.
 *
 * This is the route's entry point and nothing else calls it, which is what lets
 * the ceiling live here. The firm-wide aggregates (`getBillingWorkbench`,
 * `billingAnalytics`) call `firmBillingService.listFirmTimeEntries` directly and
 * still receive every row, because they sum the firm's hours and unbilled value
 * over the complete set and a page would make those figures wrong.
 *
 * A request over the ceiling is REFUSED by the route schema (400) rather than
 * quietly clamped: a caller that asked for 5,000 rows and silently got 200 would
 * page off a page size it never agreed to. A request with NO `limit` is clamped
 * instead, because refusing it would break the "select all matching" read with
 * nothing to fall back on, and because an unbounded list used to hold one of the
 * instance's 12 pool connections while the firm's entire time log was read,
 * derived and serialized.
 *
 * `truncated` is how a clamped response stays honest: true means the SERVER
 * withheld rows, not that the caller asked for a window. `totalItems` and
 * `summary` are computed over the whole match set either way, so a truncated
 * response never understates the firm's hours or value; only `timeEntries` is
 * short, and a caller that acts on the id list (bulk invoice, bulk delete) must
 * treat `truncated: true` as "this is not all of them".
 */
export async function listFirmTimeEntries(options: any) {
  const requestedLimit = options?.limit;
  const result = await firmBillingService.listFirmTimeEntries({
    ...options,
    limit: requestedLimit ?? MAX_PAGE_SIZE,
  });

  return {
    ...result,
    truncated: requestedLimit == null && result.totalItems > (result.timeEntries?.length || 0),
  };
}

/**
 * Re-rate every UNBILLED time entry in a context against today's rate sources.
 *
 * The stored rate is deliberately sticky (see `createTimeEntry`), so this is the
 * one sanctioned way to make a rate change reach existing work: a member asks
 * for it, for one matter or client, and only entries not yet on an invoice
 * move. A billed entry keeps the rate its invoice was built from; the freeze
 * trigger would refuse the write in any case. An entry's rate is its
 * timekeeper's business, so re-rating a context that holds anyone else's
 * unbilled work needs `billing.manageOthersTimeEntries`.
 */
export async function rerateTimeEntries({ lawFirmId, matterId, clientId, context, actingUserId }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const [entries, billedIds] = await Promise.all([
    timeEntriesRepo.findByContext(resolvedContext, null),
    billingReads.billedSourceIds(resolvedContext, 'time_entry'),
  ]);

  // Re-rating restates stored rates, so any unbilled entry that is not the
  // caller's own (another member's, or firm-level time with no timekeeper)
  // needs the standing that editing it does. Checked before any write so a
  // refusal leaves every rate where it was.
  if (entries.some((entry: any) => !billedIds.has(entry.id) && entry.userId !== actingUserId)) {
    await assertFirmPermission(lawFirmId, actingUserId, MANAGE_OTHERS_PERMISSION);
  }

  let rerated = 0;
  let billed = 0;
  for (const entry of entries) {
    if (billedIds.has(entry.id)) { billed += 1; continue; }
    // eslint-disable-next-line no-await-in-loop -- each entry resolves against
    // its own charge code and timekeeper; a context holds tens of entries.
    const rated = await billingReads.resolveEntryRate(lawFirmId, {
      contextType: resolvedContext.type,
      entityId: resolvedContext.entityId,
      userId: entry.userId || null,
      chargeCodeId: entry.chargeCodeId || null,
      hourlyRate: entry.hourlyRate ?? null,
      matterClientIds: entry.matterClientIds || null,
    });
    if (rated.resolvedRateCents === (entry.resolvedRate == null ? null : Math.round(entry.resolvedRate * 100))
        && rated.rateSource === entry.rateSource) continue;
    // eslint-disable-next-line no-await-in-loop
    await timeEntriesRepo.update(resolvedContext, entry.id, {
      resolvedRateCents: rated.resolvedRateCents, rateSource: rated.rateSource,
    });
    rerated += 1;
  }

  eventBus.emit(TIME_ENTRY_CHANGED, { type: resolvedContext.type, lawFirmId, entityId: resolvedContext.entityId });
  return { message: 'Time entries re-rated successfully', rerated, skippedBilled: billed };
}
