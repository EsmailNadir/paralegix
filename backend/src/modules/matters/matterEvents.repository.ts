/**
 * Matter events repository. Queryable/scoping/sync fields are columns; nested
 * data (assignees, deps, postponement history, linked files, recurrence config,
 * per-user calendar_sync) is jsonb. Timestamps are returned as ISO strings;
 * callers format them directly.
 *
 * The table is `events`, shared with client events since migration 0205, and the
 * parent is the `matter_id` column. Every read below already narrows by a
 * specific matter id, which is what keeps client events out of these results;
 * a new query that does NOT name a matter must add `isNotNull(events.matterId)`
 * for itself.
 */

import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { ceilingLimit, withinCeiling } from '../../shared/database/readCeiling';
import {
  courts,
  events,
  matters,
  reminders,
} from '../../shared/database/drizzle/schema';
import {
  rootQueryExecutor,
  tenantQuery,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsert,
  scopedInsertMany,
  scopedUpdate,
  type InsertValues,
  type UpdateValues,
} from '../../shared/database/scopedWrite';
import {
  assigneesByEvent,
  attendeesByEvent,
  replaceEventAssignees,
  replaceEventContacts,
} from '../../shared/calendarEvents/eventParticipants';
import { claimEventReminder, releaseEventReminder } from '../../shared/calendarEvents/eventReminderClaim';
const { isUuid } = require('../../shared/utils/isUuid');
const calendarSyncRepo = require('../calendar/shared/calendarSync.repository');

type EventInsert = InsertValues<typeof events>;
type EventUpdate = UpdateValues<typeof events>;

/** Every column on `events` an application write is allowed to set. */
type WritableField = keyof EventUpdate;

type FieldKind = 'text' | 'ts' | 'bool' | 'int' | 'jsonb';
interface FieldSpec {
  col: string;
  kind: FieldKind;
}

/**
 * The maps below drive every write in this repository, so their keys are the
 * real contract with the table. `satisfies Partial<Record<WritableField, …>>`
 * makes the compiler hold that contract: a key that is not a writable column
 * (because it was renamed, dropped, or misspelt) is a build error here rather
 * than a field that quietly stops being saved. `Partial` because neither map
 * needs to cover every column.
 */
const SYNC_COLUMNS = {
  googleEventId: 'google_event_id',
  outlookId: 'outlook_id',
  outlookChangeKey: 'outlook_change_key',
  googleCalendarId: 'google_calendar_id',
} satisfies Partial<Record<WritableField, string>>;

type SyncField = keyof typeof SYNC_COLUMNS;

const isSyncField = (field: string): field is SyncField =>
  Object.prototype.hasOwnProperty.call(SYNC_COLUMNS, field);

// entityField -> { col, kind }. kind: text | ts | bool | int | jsonb
const FIELDS = {
  type: { col: 'type', kind: 'text' },
  title: { col: 'title', kind: 'text' },
  notes: { col: 'notes', kind: 'text' },
  locationName: { col: 'location_name', kind: 'text' },
  location: { col: 'location', kind: 'text' },
  status: { col: 'status', kind: 'text' },
  createdBy: { col: 'created_by', kind: 'text' },
  recurrenceGroupId: { col: 'recurrence_group_id', kind: 'text' },
  cancellationReason: { col: 'cancellation_reason', kind: 'text' },
  cancelledBy: { col: 'cancelled_by', kind: 'text' },
  googleEventId: { col: 'google_event_id', kind: 'text' },
  outlookId: { col: 'outlook_id', kind: 'text' },
  outlookChangeKey: { col: 'outlook_change_key', kind: 'text' },
  googleCalendarId: { col: 'google_calendar_id', kind: 'text' },
  date: { col: 'date', kind: 'ts' },
  endsAt: { col: 'ends_at', kind: 'ts' },
  cancelledAt: { col: 'cancelled_at', kind: 'ts' },
  lastSyncedToGoogle: { col: 'last_synced_to_google', kind: 'ts' },
  lastSyncedToOutlook: { col: 'last_synced_to_outlook', kind: 'ts' },
  googleLastModified: { col: 'google_last_modified', kind: 'ts' },
  outlookLastModified: { col: 'outlook_last_modified', kind: 'ts' },
  clientVisible: { col: 'client_visible', kind: 'bool' },
  clientDescription: { col: 'client_description', kind: 'text' },
  timeZone: { col: 'time_zone', kind: 'text' },
  allDay: { col: 'all_day', kind: 'bool' },
  isRecurrenceParent: { col: 'is_recurrence_parent', kind: 'bool' },
  recurrenceIndex: { col: 'recurrence_index', kind: 'int' },
  postponementCount: { col: 'postponement_count', kind: 'int' },
  dependsOn: { col: 'depends_on', kind: 'jsonb' },
  linkedFiles: { col: 'linked_files', kind: 'jsonb' },
  recurrence: { col: 'recurrence', kind: 'jsonb' },
  postponementHistory: { col: 'postponement_history', kind: 'jsonb' },
  calendarSync: { col: 'calendar_sync', kind: 'jsonb' },
} satisfies Partial<Record<WritableField, FieldSpec>>;

/** A field this repository knows how to read and write. */
type MappedField = keyof typeof FIELDS;

const MAPPED_FIELDS = Object.keys(FIELDS) as MappedField[];

const isMappedField = (field: string): field is MappedField =>
  Object.prototype.hasOwnProperty.call(FIELDS, field);

const COL_TO_FIELD: Record<string, MappedField> = Object.fromEntries(
  Object.entries(FIELDS).map(([f, s]) => [s.col, f as MappedField]),
);

/**
 * Assigns one mapped field onto a write payload.
 *
 * `FIELDS` guarantees the key is a real writable column; the value comes from
 * `toParam`, whose return is a union TypeScript cannot narrow per key, so the
 * widening cast is confined here instead of spreading `as any` over every call
 * to the scoped writers.
 */
function setField(
  values: EventInsert | EventUpdate,
  field: MappedField | SyncField,
  value: unknown,
): void {
  (values as Record<string, unknown>)[field] = value;
}

// Default ceiling for the upcoming client-visible read, used when a caller does
// not ask for a narrower one.
const UPCOMING_VISIBLE_LIMIT = 500;

/**
 * Every event column plus its reminder state and its matter's court name.
 *
 * Reminder state is a shared `reminders` row (migration 0245) rather than two
 * columns on the event, and `rowToEntity` still expects `lastReminderSentAt` /
 * `reminderCount`, so the join supplies them under those names.
 *
 * `courtName` is the MATTER's court. `events.court_id` belongs to client events
 * and is null on a matter event, so the name is reached through
 * `matters.court_id` and joined at read, never copied onto the event: a renamed
 * court shows its new name everywhere at once. A read selecting this projection
 * must apply all three joins below (`EVENT_JOINS`); one that forgets a join
 * fails in SQL rather than answering a blank court.
 *
 * `count(*)` and id-only reads do not need any of it and do not join.
 */
const EVENT_WITH_REMINDER = {
  ...getTableColumns(events),
  lastReminderSentAt: reminders.lastSentAt,
  reminderCount: sql<number>`coalesce(${reminders.sentCount}, 0)`,
  courtName: courts.name,
};

const REMINDER_JOIN = eq(reminders.eventId, events.id);

/** The event's matter, held to the event's own firm. */
const MATTER_JOIN = and(eq(matters.id, events.matterId), eq(matters.lawFirmId, events.lawFirmId))!;

/**
 * The matter's court, held to the same firm. `matters.court_id` is a
 * single-column foreign key (a composite `set null` key would null the tenant
 * column), so nothing in the schema stops it naming another firm's court; this
 * predicate is what keeps that court's name out of the answer.
 */
const MATTER_COURT_JOIN = and(eq(courts.id, matters.courtId), eq(courts.lawFirmId, events.lawFirmId))!;

/**
 * The court's name for rows a write returned. A write answers with the row it
 * wrote (`RETURNING`), which carries no join, so `create`, `batchCreate` and
 * `update` resolve the name here. Every row of one call shares one matter, so
 * this is one lookup per write, not one per row.
 */
async function matterCourtName(lawFirmId: string, matterId: string, executor?: DrizzleExecutor): Promise<string | null> {
  if (!isUuid(matterId)) return null;
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
    .select({ name: courts.name }).from(matters)
    .innerJoin(courts, and(eq(courts.id, matters.courtId), eq(courts.lawFirmId, matters.lawFirmId)))
    .where(and(scope, eq(matters.id, matterId))).limit(1), executor);
  return rows[0]?.name ?? null;
}

const tsParam = (v: any): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  return new Date(v);
};

/** camelCase entity field -> SQL param value for its column. */
function toParam(field: MappedField, value: unknown) {
  const spec: FieldSpec = FIELDS[field];
  if (value === undefined) return undefined;
  switch (spec.kind) {
    case 'ts': return tsParam(value);
    case 'jsonb':
      if (value != null) return value;
      if (spec.col === 'recurrence') return null;
      return spec.col === 'calendar_sync' ? {} : [];
    case 'bool': return value === true;
    case 'int': return value == null ? null : Number(value);
    default: return value;
  }
}

/** Column default for a field omitted by some rows in a batched multi-row insert. */
function defaultParam(field: MappedField) {
  const spec: FieldSpec = FIELDS[field];
  if (spec.kind === 'jsonb') {
    if (spec.col === 'recurrence') return null;
    return spec.col === 'calendar_sync' ? {} : [];
  }
  if (spec.kind === 'bool') return false;
  return null;
}

/**
 * DB row -> camelCase entity (timestamps as ISO strings, jsonb already parsed).
 * `courtName` comes from the read's join, or from the caller for a written row.
 */
function rowToEntity(row: any, courtName: string | null = row?.courtName ?? null) {
  if (!row) return null;
  const e: any = { id: row.id, matterId: row.matterId, lawFirmId: row.lawFirmId };
  for (const field of Object.values(COL_TO_FIELD)) {
    let v = row[field];
    if (v instanceof Date) v = v.toISOString();
    e[field] = v;
  }
  // Not `events` columns any more: they come from the joined reminders row and
  // are absent on a read that did not join it (a count, or an id-only select).
  e.lastReminderSentAt = row.lastReminderSentAt instanceof Date
    ? row.lastReminderSentAt.toISOString()
    : (row.lastReminderSentAt ?? null);
  e.reminderCount = Number(row.reminderCount ?? 0);
  e.courtName = courtName;
  return e;
}

class MatterEventsRepository {
  /**
   * `executor` defaults to the root pool, so every existing caller (an
   * independent, single-statement create) is unaffected. A caller applying
   * SEVERAL creates as one unit (deadlineSets.applyDeadlineSet) passes the
   * executor from an open `withDrizzleTransaction`, so this insert becomes
   * part of that outer transaction instead of its own committed statement.
   */
  async create(lawFirmId: string, matterId: string, data: any, executor: DrizzleExecutor = rootQueryExecutor) {
    // `title` is seeded rather than left to the loop because it is the one
    // NOT NULL column here without a default: naming it keeps that requirement
    // visible instead of surfacing as a constraint violation at insert time.
    const values: EventInsert = { matterId, title: data.title };
    for (const field of MAPPED_FIELDS) {
      if (data[field] === undefined) continue;
      setField(values, field, toParam(field, data[field]));
    }
    const rows = await scopedInsert(events, lawFirmId, values, executor);
    return rowToEntity(rows[0], await matterCourtName(lawFirmId, matterId, executor));
  }

  async findById(lawFirmId: string, matterId: string, eventId: string, executor?: DrizzleExecutor) {
    if (!isUuid(eventId)) return null;
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN).where(and(
        scope, eq(events.matterId, matterId), eq(events.id, eventId),
      )).limit(1), executor);
    if (!rows[0]) return null;
    const event = rowToEntity(rows[0]);
    const byEvent = await attendeesByEvent(lawFirmId, [event.id], executor);
    event.contacts = byEvent.get(event.id) || [];
    const assignees = await assigneesByEvent(lawFirmId, [event.id], executor);
    const forEvent = assignees.get(event.id);
    event.assignedTo = forEvent?.assignedTo || [];
    event.assignedToName = forEvent?.assignedToName || [];
    return event;
  }

  /**
   * Every event on one matter.
   *
   * Unpaged by design: callers aggregate over the whole set (totals, the
   * dependency graph, a calendar month). The ceiling is a guard against a
   * pathological matter rather than a page size, and it refuses instead of
   * truncating, because a short array here reads as a complete answer. Screens
   * that page use `findPage`.
   */
  async findAll(lawFirmId: string, matterId: string, executor?: DrizzleExecutor) {
    const rows = withinCeiling(
      await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
        .select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN).where(and(scope, eq(events.matterId, matterId)))
        .orderBy(sql`${events.date} asc nulls last`).limit(ceilingLimit()), executor),
      'events on one matter',
    );
    const rowEntities = rows.map((row: any) => rowToEntity(row));
    // One batched attendee read for the whole list rather than one per event.
    const byEvent = await attendeesByEvent(lawFirmId, rowEntities.map((e: any) => e.id), executor);
    for (const event of rowEntities) event.contacts = byEvent.get(event.id) || [];
    const assignees = await assigneesByEvent(lawFirmId, rowEntities.map((e: any) => e.id), executor);
    for (const event of rowEntities) {
      const forEvent = assignees.get(event.id);
      event.assignedTo = forEvent?.assignedTo || [];
      event.assignedToName = forEvent?.assignedToName || [];
    }
    return rowEntities;
  }

  /**
   * Every event on the matter, projected to just what the dependency graph needs.
   *
   * Deliberately unpaged and deliberately narrow. The events tab resolves
   * `dependsOn` against this, so a partial answer would silently read as "not
   * blocked" — the one failure mode that lets a firm close a deadline whose
   * blocker is still open. Keeping the projection to five columns is what makes
   * reading all of them affordable on a matter with years of history.
   */
  async findGraph(lawFirmId: string, matterId: string) {
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor.select({
      id: events.id, type: events.type, title: events.title,
      status: events.status, date: events.date, dependsOn: events.dependsOn,
    }).from(events).where(and(scope, eq(events.matterId, matterId)))
      .orderBy(sql`${events.date} asc nulls last`));
    return rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      status: r.status,
      date: r.date,
      dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn : [],
    }));
  }

  /**
   * One page of a matter's events, optionally narrowed to a single status.
   *
   * `totalItems` is the pre-window count for that status, so a section footer can
   * state the real total rather than the size of the page it is showing.
   */
  async findPaged(lawFirmId: string, matterId: string, { status = null, limit = null, offset = 0 }: any = {}) {
    const filters = status
      ? and(eq(events.matterId, matterId), eq(events.status, status))
      : eq(events.matterId, matterId);
    const countRows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select({ total: sql<number>`count(*)::int` })
      .from(events).where(and(scope, filters)));
    const totalItems = countRows[0]?.total ?? 0;

    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => {
      const query = executor.select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN)
        .where(and(scope, filters)).orderBy(sql`${events.date} asc nulls last`);
      return limit === null
        ? query
        : query.limit(Math.max(0, Math.trunc(Number(limit))))
          .offset(Math.max(0, Math.trunc(Number(offset))));
    });

    const rowEntities = rows.map((row: any) => rowToEntity(row));
    // Same batched attendee read findAll does; a paged row without its attendees
    // would render as an event nobody is attending.
    const byEvent = await attendeesByEvent(lawFirmId, rowEntities.map((e: any) => e.id));
    for (const event of rowEntities) event.contacts = byEvent.get(event.id) || [];
    const assignees = await assigneesByEvent(lawFirmId, rowEntities.map((e: any) => e.id));
    for (const event of rowEntities) {
      const forEvent = assignees.get(event.id);
      event.assignedTo = forEvent?.assignedTo || [];
      event.assignedToName = forEvent?.assignedToName || [];
    }

    return { rows: rowEntities, totalItems };
  }

  /**
   * Replace an event's assignees. The caller has already validated the ids
   * against the matter's membership. See `shared/calendarEvents/eventParticipants`.
   */
  async syncAssignees(lawFirmId: string, eventId: string, userIds: string[], executor?: DrizzleExecutor) {
    await replaceEventAssignees(lawFirmId, eventId, userIds, executor);
  }

  /** Replace an event's non-member attendees. Replace-set, like `syncAssignees`. */
  async syncContacts(lawFirmId: string, eventId: string, contactIds: string[], executor?: DrizzleExecutor) {
    await replaceEventContacts(lawFirmId, eventId, contactIds, executor);
  }

  /**
   * Batched read across many matters (replaces per-matter findAll N+1). Globally
   * date-ordered.
   *
   * `range` narrows the read to the calendar days the caller is drawing, as the
   * half-open UTC interval `[startUtc, endUtc)` resolved from the viewer's local
   * days. Undated events fall out of a ranged read, which is correct: an event
   * with no date cannot land on a calendar day. With no range every event comes
   * back, including undated ones, which is what the unwindowed callers expect.
   */
  async findAllForMatters(lawFirmId: string, matterIds: string[], range: any = null, page?: { limit: number; offset: number }) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return [];

    // Counted across every matter at once, not per matter, or the total would
    // still grow with how many matters the caller can see. Refuses rather than
    // truncating: this feeds a calendar and a reminder sweep, and a short list
    // reads as "there is nothing else" to both.
    const selected = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
        .select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN).where(and(
          scope,
          inArray(events.matterId, ids),
          range ? gte(sql`coalesce(${events.endsAt}, ${events.date})`, tsParam(range.startUtc)!) : undefined,
          range ? lt(events.date, tsParam(range.endUtc)!) : undefined,
        )).orderBy(sql`${events.date} asc nulls last`, asc(events.id)).limit(page ? page.limit : ceilingLimit()).offset(page?.offset || 0));
    const rows = page ? selected : withinCeiling(selected, 'events across these matters');
    const rowEntities = rows.map((row: any) => rowToEntity(row));
    // The reminder sweep reads `assignedTo` off these to decide who to email, so
    // the assignees must be hydrated here too (migration 0218 made them rows).
    const assignees = await assigneesByEvent(lawFirmId, rowEntities.map((e: any) => e.id));
    for (const event of rowEntities) {
      const forEvent = assignees.get(event.id);
      event.assignedTo = forEvent?.assignedTo || [];
      event.assignedToName = forEvent?.assignedToName || [];
    }
    return rowEntities;
  }

  /**
   * Portal read: only client-visible, non-cancelled, upcoming events across matters.
   *
   * Capped because the portal renders an agenda, not an archive: a long-running
   * matter can accumulate years of scheduled events, and no client scrolls past
   * the next few hundred. The cap is applied in SQL after the date sort, so what
   * is dropped is always the furthest-out events. A limit that is not a positive
   * number falls back to the default rather than reaching the query.
   */
  /**
   * Client-visible events still to come: a timed one until it starts, an
   * all-day one for its whole day (its noon-UTC anchor on or after
   * `todayAnchorIso`, the viewer's today). Without `todayAnchorIso` an all-day
   * event is held to `nowIso` like any other.
   *
   * The one read here that can also return CLIENT events. Those come back with a
   * null `courtName`, since the join reaches a court through the matter; a
   * client event's own court is `events.court_id`, which
   * `clientEvents.repository` joins. The portal agenda shows no court.
   */
  async findUpcomingVisibleForMatters(lawFirmId: string, matterIds: string[], nowIso: any, { limit, todayAnchorIso, clientRecordId }: any = {}) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length && !isUuid(clientRecordId)) return [];
    const requested = Math.trunc(Number(limit));
    const cap = Number.isFinite(requested) && requested > 0 ? requested : UPCOMING_VISIBLE_LIMIT;
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN).where(and(
        scope,
        or(
          ids.length ? inArray(events.matterId, ids) : undefined,
          isUuid(clientRecordId) ? and(isNull(events.matterId), eq(events.clientId, clientRecordId)) : undefined,
        ),
        eq(events.clientVisible, true),
        ne(events.status, 'cancelled'),
        isNotNull(events.date),
        todayAnchorIso
          ? or(
            and(eq(events.allDay, true), gte(events.date, tsParam(todayAnchorIso)!)),
            and(ne(events.allDay, true), gte(events.date, tsParam(nowIso)!)),
          )
          : gte(events.date, tsParam(nowIso)!),
      )).orderBy(asc(events.date)).limit(cap));
    return rows.map((row: any) => rowToEntity(row));
  }

  async update(lawFirmId: string, matterId: string, eventId: string, updates: any, executor?: DrizzleExecutor) {
    if (!isUuid(eventId)) return null;
    const values: EventUpdate = {};
    for (const [field, value] of Object.entries(updates)) {
      if (!isMappedField(field) || value === undefined) continue;
      setField(values, field, toParam(field, value));
    }
    if (!Object.keys(values).length) return this.findById(lawFirmId, matterId, eventId, executor);
    const rows = await scopedUpdate(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.id, eventId),
    )!, values, executor);
    return rows[0] ? rowToEntity(rows[0], await matterCourtName(lawFirmId, matterId, executor)) : null;
  }

  async removeDependencyReferences(lawFirmId: string, matterId: string, eventId: string, executor?: DrizzleExecutor) {
    await scopedUpdate(events, lawFirmId, and(
      eq(events.matterId, matterId),
      sql`${events.dependsOn} @> ${JSON.stringify([eventId])}::jsonb`,
    )!, { dependsOn: sql`${events.dependsOn} - ${eventId}` }, executor);
  }

  async delete(lawFirmId: string, matterId: string, eventId: string, executor?: DrizzleExecutor) {
    if (!isUuid(eventId)) return;
    await scopedDelete(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.id, eventId),
    )!, executor);
  }

  /** Delete all events for a matter (matter delete also cascades via FK). */
  async deleteAllForMatter(lawFirmId: string, matterId: string) {
    await scopedDelete(events, lawFirmId, eq(events.matterId, matterId));
  }

  /** Find all events in a recurrence group. */
  async findByRecurrenceGroup(lawFirmId: string, matterId: string, groupId: any, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select(EVENT_WITH_REMINDER).from(events).leftJoin(reminders, REMINDER_JOIN)
        .leftJoin(matters, MATTER_JOIN).leftJoin(courts, MATTER_COURT_JOIN).where(and(
        scope, eq(events.matterId, matterId), eq(events.recurrenceGroupId, groupId),
      )), executor);
    return rows.map((row: any) => rowToEntity(row));
  }

  /** Insert many events in one statement (recurrence series). Returns rows ordered by recurrenceIndex. */
  async batchCreate(lawFirmId: string, matterId: string, rowsData: any, executor?: DrizzleExecutor) {
    if (!rowsData || !rowsData.length) return [];
    // union of fields present across rows (so divergent keys like `recurrence` are covered)
    const fieldSet: MappedField[] = [];
    const seen = new Set<string>();
    for (const r of rowsData) for (const f of Object.keys(r)) {
      if (isMappedField(f) && !seen.has(f)) { seen.add(f); fieldSet.push(f); }
    }
    const values = rowsData.map((row: any) => {
      const value: EventInsert = { matterId, title: row.title };
      for (const field of fieldSet) {
        setField(value, field, row[field] === undefined ? defaultParam(field) : toParam(field, row[field]));
      }
      return value;
    });
    const rows = await scopedInsertMany(events, lawFirmId, values, executor);
    const courtName = await matterCourtName(lawFirmId, matterId, executor);
    return rows
      .map((row: any) => rowToEntity(row, courtName))
      .sort((a: any, b: any) => (a.recurrenceIndex ?? 0) - (b.recurrenceIndex ?? 0));
  }

  /** Delete a whole recurrence group in one statement. */
  async deleteByRecurrenceGroup(lawFirmId: string, matterId: string, groupId: any, executor?: DrizzleExecutor) {
    await scopedDelete(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.recurrenceGroupId, groupId),
    )!, executor);
  }

  // ── calendar sync writebacks (relational; replaces the entityRef shim) ──────
  async applyCalendarSync(lawFirmId: string, matterId: string, eventId: string, descriptor: any) {
    if (!isUuid(eventId)) return;
    await calendarSyncRepo.applyCalendarSyncDescriptor(
      'events',
      { sql: 'law_firm_id = $1 and matter_id = $2 and id = $3', params: [lawFirmId, matterId, eventId] },
      descriptor,
      (field: string) => (isSyncField(field) ? SYNC_COLUMNS[field] : null)
    );
  }

  async setSyncFields(lawFirmId: string, matterId: string, eventId: string, fields: any) {
    if (!isUuid(eventId)) return;
    const values: EventUpdate = {};
    for (const [field, value] of Object.entries(fields)) {
      if (!isSyncField(field)) continue;
      setField(values, field, value === undefined ? null : value);
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.id, eventId),
    )!, values);
  }

  async touchProviderSync(lawFirmId: string, matterId: string, eventId: string, provider: any) {
    if (!isUuid(eventId)) return;
    const values = provider === 'google'
      ? { lastSyncedToGoogle: sql`now()` }
      : { lastSyncedToOutlook: sql`now()` };
    await scopedUpdate(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.id, eventId),
    )!, values);
  }

  /** Inbound webhook update (date/end/title/notes + provider stamps). */
  async applyInboundUpdate(lawFirmId: string, matterId: string, eventId: string, fields: any) {
    if (!isUuid(eventId)) return;
    const allowed: MappedField[] = [
      'title', 'notes', 'status', 'allDay', 'location', 'locationName', 'timeZone', 'googleLastModified', 'outlookLastModified',
      'outlookChangeKey', 'outlookId', 'googleEventId',
    ];
    const values: EventUpdate = {};
    for (const field of allowed) {
      if (fields[field] === undefined) continue;
      setField(values, field, toParam(field, fields[field]));
    }
    if (fields.date !== undefined) {
      values.date = fields.date == null ? null : tsParam(fields.date);
    }
    if (fields.endsAt !== undefined) {
      values.endsAt = fields.endsAt == null ? null : tsParam(fields.endsAt);
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(events, lawFirmId, and(
      eq(events.matterId, matterId), eq(events.id, eventId),
    )!, values);
  }

  /**
   * Claim the right to send this event's reminder, BEFORE the email goes out.
   * See `shared/calendarEvents/eventReminderClaim` for why the window lives in
   * the statement rather than in JavaScript.
   *
   * @returns {Promise<boolean>} true if this call won the right to send.
   */
  async claimReminderSend(lawFirmId: string, matterId: string, eventId: string, withinHours = 24) {
    return claimEventReminder(lawFirmId, { kind: 'matter', matterId }, eventId, withinHours);
  }

  /** Undo a reminder claim whose sends all failed, so the next sweep retries. */
  async releaseReminderClaim(lawFirmId: string, matterId: string, eventId: string, previous = null) {
    await releaseEventReminder(lawFirmId, { kind: 'matter', matterId }, eventId, previous);
  }
}

export = Object.assign(new MatterEventsRepository(), { FIELDS, rowToEntity });
