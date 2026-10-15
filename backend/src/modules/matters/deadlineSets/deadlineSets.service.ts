/**
 * Deadline Set templates: firm-defined recipes that turn a single anchor date
 * into a cascade of matter events. Templates are managed in firm settings;
 * applying one to a matter materializes each item as a normal matter event
 * (via the matter-events service, so calendar sync / reminders / portal
 * visibility all behave like a hand-entered event).
 */

import { withDrizzleTransaction } from '../../../shared/database/queryContext';

const { assertLawFirmMembership, assertMatterMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const deadlineSetsRepo = require('./deadlineSets.repository');
const matterEventsService = require('../matterEvents.service');
const eventBus = require('../../../shared/events/eventBus');
const { MATTER_EVENT_CREATED } = require('../../../shared/events/eventTypes');

function formatTemplate(t: any) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    description: t.description || null,
    adjustForWeekends: t.adjustForWeekends === true,
    items: Array.isArray(t.items) ? t.items : [],
    createdBy: t.createdBy || null,
    createdAt: t.createdAt || null,
    updatedAt: t.updatedAt || null,
  };
}

/**
 * Normalize a raw item to the stored shape (trimmed, defaulted). `isFirst`
 * forces relativeTo back to 'trigger' since the first item has no previous
 * item to chain from.
 */
function normalizeItem(item: any, isFirst: boolean) {
  return {
    title: item.title.trim(),
    type: item.type,
    offsetDays: Number(item.offsetDays),
    offsetDirection: item.offsetDirection === 'before' ? 'before' : 'after',
    relativeTo: !isFirst && item.relativeTo === 'previous' ? 'previous' : 'trigger',
    clientVisible: item.clientVisible === true,
    notes: item.notes?.trim() || null,
  };
}

/**
 * Compute a deadline's day-only date from an anchor date and an offset.
 * Day math is done in UTC so it never drifts across DST. Returns 'YYYY-MM-DD'.
 */
function computeDeadlineDate(anchorYmd: any, offsetDays: any, offsetDirection: any, adjustForWeekends: any) {
  const [y, m, d] = anchorYmd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const delta = offsetDirection === 'before' ? -offsetDays : offsetDays;
  base.setUTCDate(base.getUTCDate() + delta);

  if (adjustForWeekends) {
    const dow = base.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const before = offsetDirection === 'before';
    if (dow === 6) base.setUTCDate(base.getUTCDate() + (before ? -1 : 2));
    else if (dow === 0) base.setUTCDate(base.getUTCDate() + (before ? -2 : 1));
  }

  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export async function listDeadlineSets({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const templates = await deadlineSetsRepo.findAll(lawFirmId);
  templates.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
  return { deadlineSets: templates.map(formatTemplate) };
}

export async function getDeadlineSet({ lawFirmId, templateId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const template = await deadlineSetsRepo.findById(lawFirmId, templateId);
  if (!template) throw new NotFoundError('Deadline set');
  return { deadlineSet: formatTemplate(template) };
}

export async function createDeadlineSet({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { name, description, adjustForWeekends, items } = body;

  const created = await deadlineSetsRepo.create(lawFirmId, {
    name: name.trim(),
    description: description?.trim() || null,
    adjustForWeekends: adjustForWeekends === true,
    items: (items || []).map((item: any, idx: number) => normalizeItem(item, idx === 0)),
    createdBy: actingUserId,
  });

  return { message: 'Deadline set created successfully', deadlineSetId: created.id, deadlineSet: formatTemplate(created) };
}

export async function updateDeadlineSet({ lawFirmId, templateId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const existing = await deadlineSetsRepo.findById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Deadline set');

  const updates: Record<string, any> = {};
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.adjustForWeekends !== undefined) updates.adjustForWeekends = body.adjustForWeekends === true;
  if (body.items !== undefined) updates.items = body.items.map((item: any, idx: number) => normalizeItem(item, idx === 0));

  const updated = await deadlineSetsRepo.update(lawFirmId, templateId, updates);
  return { message: 'Deadline set updated successfully', deadlineSet: formatTemplate(updated) };
}

export async function deleteDeadlineSet({ lawFirmId, templateId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const existing = await deadlineSetsRepo.findById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Deadline set');
  await deadlineSetsRepo.delete(lawFirmId, templateId);
  return { message: 'Deadline set deleted successfully', deadlineSetId: templateId };
}

/**
 * Apply a template to a matter: create one matter event per item, dated at its
 * offset from the anchor.
 *
 * All of a template's events are written inside ONE transaction
 * (`withDrizzleTransaction`, threaded into every create via
 * `matterEventsService._createMatterEventTx`), so a real failure partway
 * through - a bad row, a dropped connection, anything - rolls back every
 * event this call already wrote instead of leaving a partially-applied
 * template with some deadlines committed and no record of which ones are
 * missing. Each item's date is computed up front (pure, no I/O) so the loop
 * inside the transaction only does writes.
 *
 * Calendar-sync/reminder listeners are fire-and-forget on the event bus, so
 * they are emitted only AFTER the transaction commits: emitting mid-
 * transaction would let a listener observe an event id that a later rollback
 * makes disappear.
 */
export async function applyDeadlineSet({ lawFirmId, matterId, templateId, actingUserId, timezone, anchorDate }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const template = await deadlineSetsRepo.findById(lawFirmId, templateId);
  if (!template) throw new NotFoundError('Deadline set');

  const anchorYmd = String(anchorDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorYmd)) {
    throw new ValidationError('Anchor date must be a valid date');
  }

  await assertMatterMembership(lawFirmId, matterId, actingUserId);

  const items = Array.isArray(template.items) ? template.items : [];
  const adjustForWeekends = template.adjustForWeekends === true;

  const plannedItems: any[] = [];
  let previousYmd = anchorYmd;
  for (const item of items) {
    const base = item.relativeTo === 'previous' ? previousYmd : anchorYmd;
    const date = computeDeadlineDate(base, Number(item.offsetDays) || 0, item.offsetDirection, adjustForWeekends);
    previousYmd = date;
    plannedItems.push({ ...item, date });
  }

  const createdEvents = await withDrizzleTransaction(async (transaction: any) => {
    const created = [];
    for (const planned of plannedItems) {
      const event = await matterEventsService._createMatterEventTx({
        executor: transaction,
        lawFirmId,
        matterId,
        userId: actingUserId,
        timezone,
        type: planned.type,
        title: planned.title,
        date: planned.date,
        // A deadline is a day, not a moment: an all-day event on that day.
        allDay: true,
        notes: planned.notes || undefined,
        clientVisible: planned.clientVisible === true,
      });
      created.push(event);
    }
    return created;
  });

  for (const event of createdEvents) {
    eventBus.emit(MATTER_EVENT_CREATED, {
      lawFirmId,
      matterId,
      eventId: event.id,
      eventData: event,
      userId: actingUserId,
      timeZone: timezone,
    });
  }

  return {
    message: `Applied "${template.name}" (${createdEvents.length} ${createdEvents.length === 1 ? 'event' : 'events'} created)`,
    created: createdEvents.length,
    events: createdEvents.map((event: any) => matterEventsService.formatEvent(event, timezone)),
  };
}
