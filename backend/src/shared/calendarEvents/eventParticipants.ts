/**
 * Who is on an `events` row: the firm's own people (`event_assignees`) and the
 * directory contacts invited from outside the firm (`event_contacts`).
 *
 * Matter events and standalone client events share the `events` table, so they
 * share these junctions and the code that reads and replaces them. Both
 * repositories delegate here rather than each carrying a copy.
 *
 * Every function takes an optional `executor`. Passed the executor of an open
 * transaction, the work joins it (the replace-set writes become a savepoint), so
 * a failure later in the caller's transaction rolls these rows back with the
 * event itself.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { contacts, eventAssignees, eventContacts, events, users } from '../database/drizzle/schema';
import { tenantQuery, withDrizzleTransaction, type DrizzleExecutor } from '../database/queryContext';
import { scopedDelete, scopedInsertManyOnConflictDoNothing } from '../database/scopedWrite';
const { isUuid } = require('../utils/isUuid');

export interface EventAssignees {
  assignedTo: string[];
  assignedToName: string[];
}

export interface EventAttendee {
  contactId: string;
  name: string;
  category: string;
  email: string | null;
  organization: string | null;
}

/**
 * Assignees per event: the ids, and their CURRENT names joined from `users`.
 * Migration 0218 made assignees rows, so a renamed member shows their new name
 * on every event at once.
 */
export async function assigneesByEvent(lawFirmId: string, eventIds: any, executor?: DrizzleExecutor) {
  const ids = (eventIds || []).filter(isUuid);
  const byEvent = new Map<string, EventAssignees>();
  if (!ids.length) return byEvent;

  const rows = await tenantQuery(eventAssignees, lawFirmId, ({ executor: run, scope }) => run
    .select({
      eventId: eventAssignees.eventId,
      userId: eventAssignees.userId,
      name: users.name,
    })
    .from(eventAssignees)
    .leftJoin(users, eq(users.id, eventAssignees.userId))
    .where(and(scope, inArray(eventAssignees.eventId, ids)))
    .orderBy(asc(eventAssignees.userId)), executor);
  for (const row of rows) {
    const entry = byEvent.get(row.eventId) || { assignedTo: [], assignedToName: [] };
    entry.assignedTo.push(row.userId);
    entry.assignedToName.push(row.name || '');
    byEvent.set(row.eventId, entry);
  }
  return byEvent;
}

/**
 * Directory contacts attending each event, keyed by event id. Read as one
 * batched query rather than a join on every event read, because most reads of
 * `events` (calendar sync, reminders) have no use for attendees.
 */
export async function attendeesByEvent(lawFirmId: string, eventIds: any, executor?: DrizzleExecutor) {
  const ids = (eventIds || []).filter(isUuid);
  const byEvent = new Map<string, EventAttendee[]>();
  if (!ids.length) return byEvent;

  const rows = await tenantQuery(eventContacts, lawFirmId, ({ executor: run, scope }) => run.select({
    eventId: eventContacts.eventId,
    contactId: contacts.id,
    name: contacts.name,
    category: contacts.category,
    email: contacts.email,
    organization: contacts.organization,
  }).from(eventContacts).innerJoin(contacts, and(
    eq(contacts.id, eventContacts.contactId),
    eq(contacts.lawFirmId, eventContacts.lawFirmId),
  )).where(and(scope, inArray(eventContacts.eventId, ids))).orderBy(asc(contacts.name)), executor);
  for (const row of rows) {
    const list = byEvent.get(row.eventId) || [];
    list.push({
      contactId: row.contactId,
      name: row.name || '',
      category: row.category || 'other',
      email: row.email || null,
      organization: row.organization || null,
    });
    byEvent.set(row.eventId, list);
  }
  return byEvent;
}

/** True when the event exists in this firm. Guards the junction inserts below. */
async function eventExists(lawFirmId: string, eventId: string, executor: DrizzleExecutor) {
  const rows = await tenantQuery(events, lawFirmId, ({ executor: run, scope }) => run
    .select({ id: events.id }).from(events)
    .where(and(scope, eq(events.id, eventId))).limit(1), executor);
  return rows.length > 0;
}

/**
 * Replace an event's assignees (delete then insert, one transaction). The
 * caller validates the ids against whatever membership the parent requires;
 * the tenant-scoped insert is what stops another firm's row landing here.
 */
export async function replaceEventAssignees(
  lawFirmId: string,
  eventId: string,
  userIds: string[],
  executor?: DrizzleExecutor,
) {
  if (!isUuid(eventId)) return;
  const ids = [...new Set<string>((userIds || []).filter(Boolean) as string[])];
  await withDrizzleTransaction(async (transaction) => {
    await scopedDelete(eventAssignees, lawFirmId, eq(eventAssignees.eventId, eventId), transaction);
    if (!ids.length) return;
    if (!(await eventExists(lawFirmId, eventId, transaction))) return;
    await scopedInsertManyOnConflictDoNothing(
      eventAssignees,
      lawFirmId,
      ids.map((userId) => ({ eventId, userId })),
      [eventAssignees.eventId, eventAssignees.userId],
      undefined,
      transaction,
    );
  }, executor);
}

/**
 * Replace an event's non-member attendees (delete then insert, one
 * transaction). Contacts belonging to another firm are dropped by the
 * tenant-scoped select rather than trusted from the caller.
 */
export async function replaceEventContacts(
  lawFirmId: string,
  eventId: string,
  contactIds: string[],
  executor?: DrizzleExecutor,
) {
  if (!isUuid(eventId)) return;
  const ids = [...new Set<string>((contactIds || []).filter(isUuid) as string[])];
  await withDrizzleTransaction(async (transaction) => {
    await scopedDelete(eventContacts, lawFirmId, eq(eventContacts.eventId, eventId), transaction);
    if (!ids.length) return;
    if (!(await eventExists(lawFirmId, eventId, transaction))) return;

    const validContacts = await tenantQuery(contacts, lawFirmId, ({ executor: run, scope }) => run
      .select({ id: contacts.id }).from(contacts)
      .where(and(scope, inArray(contacts.id, ids))), transaction);
    await scopedInsertManyOnConflictDoNothing(
      eventContacts,
      lawFirmId,
      validContacts.map((contact) => ({ eventId, contactId: contact.id })),
      [eventContacts.lawFirmId, eventContacts.eventId, eventContacts.contactId],
      undefined,
      transaction,
    );
  }, executor);
}
