/**
 * Standalone client calendar events (Postgres, relational, `events`,
 * migration 0027; formerly a Firestore kv table, now fully relational).
 * Timestamps are returned as ISO strings.
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, lt, notInArray, sql } from 'drizzle-orm';
import {
  clients, courts, events, reminders,
} from '../../shared/database/drizzle/schema';
import { ceilingLimit, withinCeiling } from '../../shared/database/readCeiling';
import { tenantQuery, type DrizzleExecutor } from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsert,
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

type ClientEventInsert = InsertValues<typeof events>;
type ClientEventUpdate = UpdateValues<typeof events>;

/** Every column on `events` an application write is allowed to set. */
type WritableField = keyof ClientEventUpdate;

// 'uuid' behaves exactly as 'text' in `toParam` (both fall through to the
// pass-through default; the parameter is sent untyped and Postgres coerces
// it to the column type). It exists so the map states the real column type:
// court_id became a uuid with a foreign key in migration 0198, and a spec
// that still called it text would read as though it were free-form.
type FieldKind = 'text' | 'uuid' | 'bool' | 'ts' | 'jsonb';
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

const FIELDS = {
  type: { col: 'type', kind: 'text' },
  title: { col: 'title', kind: 'text' },
  notes: { col: 'notes', kind: 'text' },
  courtId: { col: 'court_id', kind: 'uuid' },
  locationName: { col: 'location_name', kind: 'text' },
  location: { col: 'location', kind: 'text' },
  status: { col: 'status', kind: 'text' },
  allDay: { col: 'all_day', kind: 'bool' },
  clientVisible: { col: 'client_visible', kind: 'bool' },
  clientDescription: { col: 'client_description', kind: 'text' },
  timeZone: { col: 'time_zone', kind: 'text' },
  createdBy: { col: 'created_by', kind: 'text' },
  googleEventId: { col: 'google_event_id', kind: 'text' },
  outlookId: { col: 'outlook_id', kind: 'text' },
  outlookChangeKey: { col: 'outlook_change_key', kind: 'text' },
  googleCalendarId: { col: 'google_calendar_id', kind: 'text' },
  date: { col: 'date', kind: 'ts' },
  endsAt: { col: 'ends_at', kind: 'ts' },
  lastSyncedToGoogle: { col: 'last_synced_to_google', kind: 'ts' },
  lastSyncedToOutlook: { col: 'last_synced_to_outlook', kind: 'ts' },
  googleLastModified: { col: 'google_last_modified', kind: 'ts' },
  outlookLastModified: { col: 'outlook_last_modified', kind: 'ts' },
  calendarSync: { col: 'calendar_sync', kind: 'jsonb' },
  linkedFiles: { col: 'linked_files', kind: 'jsonb' },
} satisfies Partial<Record<WritableField, FieldSpec>>;

/** A field this repository knows how to read and write. */
type MappedField = keyof typeof FIELDS;

const MAPPED_FIELDS = Object.keys(FIELDS) as MappedField[];

const isMappedField = (field: string): field is MappedField =>
  Object.prototype.hasOwnProperty.call(FIELDS, field);

const COL_TO_FIELD: Record<string, MappedField> = Object.fromEntries(
  Object.entries(FIELDS).map(([f, s]) => [s.col, f as MappedField]),
);

const tsParam = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v as string | number);
};

function toParam(field: MappedField, value: unknown) {
  const spec: FieldSpec = FIELDS[field];
  if (value === undefined) return undefined;
  switch (spec.kind) {
    case 'ts': return tsParam(value);
    case 'jsonb':
      if (value != null) return value;
      // `calendar_sync` is an object keyed by provider; every other jsonb
      // column here (assigned_to, assigned_to_name, linked_files) is an
      // array, so clearing it to null must default back to `[]`, not `{}` -
      // an object default would corrupt the array shape callers expect.
      return spec.col === 'calendar_sync' ? {} : [];
    case 'bool': return value === true;
    default: return value;
  }
}

/**
 * Assigns one mapped field onto a write payload.
 *
 * `FIELDS` guarantees the key is a real writable column; the value comes from
 * `toParam`, whose return is a union TypeScript cannot narrow per key, so the
 * widening cast is confined here instead of spreading `as any` over every call
 * to the scoped writers.
 */
function setField(
  values: ClientEventInsert | ClientEventUpdate,
  field: MappedField | SyncField,
  value: unknown,
): void {
  (values as Record<string, unknown>)[field] = value;
}

/**
 * `courtName` is JOINED, not stored. `events.court_name` was a
 * denormalized copy the service rewrote on every save; migration 0205 dropped it
 * and every read below LEFT JOINs `courts` for the name instead, which is how
 * matters.repository, tasks.repository and contacts.repository have always read
 * it. A copy that is never written cannot go stale.
 */
function rowToEntity(row: any, courtName: string | null = null) {
  if (!row) return null;
  const e: any = { id: row.id, clientId: row.clientId, lawFirmId: row.lawFirmId, matterId: null };
  for (const field of Object.values(COL_TO_FIELD)) {
    let v = row[field];
    if (v instanceof Date) v = v.toISOString();
    e[field] = v;
  }
  // Read-only here: a client event is cancelled through its status, and these
  // are reported when a row carries them.
  e.cancellationReason = row.cancellationReason ?? null;
  e.cancelledBy = row.cancelledBy ?? null;
  e.cancelledAt = row.cancelledAt instanceof Date ? row.cancelledAt.toISOString() : row.cancelledAt ?? null;
  e.courtName = courtName;
  return e;
}

/**
 * The projection every read here uses: the whole event row plus the court's
 * name. Kept in one place so a new read cannot quietly forget the join and
 * return a client event whose court renders blank.
 */
const EVENT_WITH_COURT = { event: events, courtName: courts.name };

/** The join that fills `EVENT_WITH_COURT.courtName`. LEFT: most events have no court. */
const COURT_JOIN = eq(courts.id, events.courtId);

/**
 * The court's name for a written row. A write returns the row it wrote rather
 * than re-reading it through a join, so this is the one place that resolves the
 * name for `create` and `update`; without it both would answer with a null
 * `courtName` for an event that has a court, which is what the callers render.
 */
async function courtNameFor(lawFirmId: string, courtId: any, executor?: DrizzleExecutor): Promise<string | null> {
  if (!courtId || !isUuid(courtId)) return null;
  const rows = await tenantQuery(courts, lawFirmId, ({ executor: run, scope }) => run
    .select({ name: courts.name }).from(courts).where(and(scope, eq(courts.id, courtId))).limit(1), executor);
  return rows[0]?.name ?? null;
}

class ClientEventsRepository {
  /**
   * Lock this firm's client row for the rest of the caller's transaction, the
   * way `matters.repository#lockMatterRow` locks a matter before its events are
   * written. Serialises event writes against a concurrent client delete, and
   * answers false when the client is not this firm's.
   */
  async lockClientRow(lawFirmId: string, clientId: string, executor: DrizzleExecutor) {
    if (!isUuid(clientId)) return false;
    const rows = await tenantQuery(clients, lawFirmId, ({ executor: run, scope }) => run
      .select({ id: clients.id }).from(clients)
      .where(and(scope, eq(clients.id, clientId))).limit(1).for('update'), executor);
    return rows.length > 0;
  }

  async create(lawFirmId: string, clientId: string, data: any, executor?: DrizzleExecutor) {
    // `title` is seeded rather than left to the loop because it is the one
    // NOT NULL column here without a default: naming it keeps that requirement
    // visible instead of surfacing as a constraint violation at insert time.
    const values: ClientEventInsert = { clientId, title: data.title };
    for (const field of MAPPED_FIELDS) {
      if (data[field] === undefined) continue;
      setField(values, field, toParam(field, data[field]));
    }
    const rows = await scopedInsert(events, lawFirmId, values, executor);
    return rowToEntity(rows[0], await courtNameFor(lawFirmId, rows[0]?.courtId, executor));
  }

  async findById(lawFirmId: string, clientId: string, eventId: string, executor?: DrizzleExecutor) {
    // BOTH ids are uuid columns. Guarding only the event id left a malformed
    // client id to reach `client_id = $2` as a cast error, so a route that
    // carries both in its path (PUT/DELETE /clients/:clientId/events/:eventId)
    // answered 500 instead of the 404 its own null check produces.
    if (!isUuid(eventId) || !isUuid(clientId)) return null;
    const rows = await tenantQuery(events, lawFirmId, ({ executor: run, scope }) => run
      .select(EVENT_WITH_COURT).from(events).leftJoin(courts, COURT_JOIN).where(and(
        scope, eq(events.clientId, clientId), eq(events.id, eventId),
      )).limit(1), executor);
    if (!rows[0]) return null;
    const event = rowToEntity(rows[0].event, rows[0].courtName);
    const byEvent = await attendeesByEvent(lawFirmId, [event.id], executor);
    event.contacts = byEvent.get(event.id) || [];
    const assignees = await assigneesByEvent(lawFirmId, [event.id], executor);
    const forEvent = assignees.get(event.id);
    event.assignedTo = forEvent?.assignedTo || [];
    event.assignedToName = forEvent?.assignedToName || [];
    return event;
  }

  /**
   * `clientId` accepts either a single client id or an array (the
   * client-detail Events tab widens it to that client's id plus every company
   * it's linked to via `client_company_links`, so standalone events recorded
   * against a linked company show up too). A single id is wrapped so the
   * `inArray` match below covers both callers identically.
   */
  async findAll(lawFirmId: string, clientId: string) {
    const clientIds = Array.isArray(clientId) ? clientId : [clientId];
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select(EVENT_WITH_COURT).from(events).leftJoin(courts, COURT_JOIN)
      .where(and(scope, inArray(events.clientId, clientIds)))
      .orderBy(sql`${events.date} asc nulls last`));
    const rowEntities = rows.map((r: any) => rowToEntity(r.event, r.courtName));
    // One batched attendee read for the whole list rather than one per event.
    const byEvent = await attendeesByEvent(lawFirmId, rowEntities.map((e: any) => e.id));
    for (const event of rowEntities) event.contacts = byEvent.get(event.id) || [];
    const assignees = await assigneesByEvent(lawFirmId, rowEntities.map((e: any) => e.id));
    for (const event of rowEntities) {
      const forEvent = assignees.get(event.id);
      event.assignedTo = forEvent?.assignedTo || [];
      event.assignedToName = forEvent?.assignedToName || [];
    }
    return rowEntities;
  }

  /**
   * One page of a client's standalone events, optionally narrowed to a status.
   * `totalItems` is the pre-window count so a section footer can state the real
   * total rather than the page size. See `findAll` for the `clientId` shape.
   */
  async findPaged(lawFirmId: string, clientId: string, { status = null, limit = null, offset = 0 }: any = {}) {
    const clientIds = Array.isArray(clientId) ? clientId : [clientId];
    const clientFilter = inArray(events.clientId, clientIds);
    const filters = status
      ? and(clientFilter, eq(events.status, status))
      : clientFilter;
    const countRows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select({ total: sql<number>`count(*)::int` }).from(events).where(and(scope, filters)));
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => {
      const query = executor.select(EVENT_WITH_COURT).from(events).leftJoin(courts, COURT_JOIN)
        .where(and(scope, filters))
        .orderBy(sql`${events.date} asc nulls last`);
      return limit === null ? query : query.limit(Number(limit)).offset(Number(offset));
    });

    const rowEntities = rows.map((r: any) => rowToEntity(r.event, r.courtName));
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

    return { rows: rowEntities, totalItems: countRows[0]?.total ?? 0 };
  }

  /**
   * Replace an event's assignees. The service has already held the ids to this
   * firm's members. See `shared/calendarEvents/eventParticipants`.
   */
  async syncAssignees(lawFirmId: string, eventId: string, userIds: string[], executor?: DrizzleExecutor) {
    await replaceEventAssignees(lawFirmId, eventId, userIds, executor);
  }

  /**
   * Replace an event's non-member attendees. Contacts belonging to another firm
   * are dropped by the tenant-scoped select rather than trusted from the caller.
   */
  async syncContacts(lawFirmId: string, eventId: string, contactIds: string[], executor?: DrizzleExecutor) {
    await replaceEventContacts(lawFirmId, eventId, contactIds, executor);
  }

  async update(lawFirmId: string, clientId: string, eventId: string, updates: any, executor?: DrizzleExecutor) {
    if (!isUuid(eventId) || !isUuid(clientId)) return null;
    const values: ClientEventUpdate = {};
    for (const [field, value] of Object.entries(updates)) {
      if (!isMappedField(field) || value === undefined) continue;
      setField(values, field, toParam(field, value));
    }
    if (!Object.keys(values).length) return this.findById(lawFirmId, clientId, eventId, executor);
    const rows = await scopedUpdate(events, lawFirmId, and(
      eq(events.clientId, clientId), eq(events.id, eventId),
    )!, values, executor);
    return rows[0] ? rowToEntity(rows[0], await courtNameFor(lawFirmId, rows[0].courtId, executor)) : null;
  }

  async delete(lawFirmId: string, clientId: string, eventId: string, executor?: DrizzleExecutor) {
    if (!isUuid(eventId) || !isUuid(clientId)) return;
    await scopedDelete(events, lawFirmId, and(
      eq(events.clientId, clientId), eq(events.id, eventId),
    )!, executor);
  }

  /**
   * Every standalone event for a client, deleted outright.
   *
   * `events.client_id` used to carry a hard FK to `clients(id) on
   * delete cascade` (schema.sql's own CREATE TABLE), but the WHOLE-SCHEMA
   * SOFT-REFERENCE sweep at the bottom of that same file strips every FK
   * pointing at `users`/`clients` on every fresh apply, turning it into an
   * unenforced id column - deleting the client leaves these rows behind with
   * a `client_id` that resolves to nothing. Unlike `events` (whose FK
   * points at `matters`, untouched by that sweep, so it genuinely cascades),
   * nothing removes these rows unless application code does, and an orphan
   * left in place surfaces forever on the firm-wide calendar
   * (`findAllForLawFirm`'s LEFT JOIN to `clients` for the display name means
   * the row survives the join with a blank client name rather than
   * disappearing). Called from `clients.repository#deleteClientCascade`
   * inside its transaction, so it commits or rolls back with the rest of the
   * client delete; pass that transaction's executor through `tx` so this
   * participates in it instead of opening a second one.
   */
  async deleteAllForClient(lawFirmId: string, clientId: string, tx?: any) {
    await scopedDelete(events, lawFirmId, eq(events.clientId, clientId), tx);
  }

  // ── calendar sync writebacks (relational; replaces the entityRef shim) ──────
  async applyCalendarSync(lawFirmId: string, clientId: string, eventId: string, descriptor: any) {
    if (!isUuid(eventId)) return;
    await calendarSyncRepo.applyCalendarSyncDescriptor(
      'events',
      { sql: 'law_firm_id = $1 and client_id = $2 and id = $3', params: [lawFirmId, clientId, eventId] },
      descriptor,
      (field: string) => (isSyncField(field) ? SYNC_COLUMNS[field] : null)
    );
  }

  async setSyncFields(lawFirmId: string, clientId: string, eventId: string, fields: any) {
    if (!isUuid(eventId)) return;
    const values: ClientEventUpdate = {};
    for (const [field, value] of Object.entries(fields)) {
      if (!isSyncField(field)) continue;
      setField(values, field, value === undefined ? null : value);
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(events, lawFirmId, and(
      eq(events.clientId, clientId), eq(events.id, eventId),
    )!, values);
  }

  async touchProviderSync(lawFirmId: string, clientId: string, eventId: string, provider: any) {
    if (!isUuid(eventId)) return;
    const values = provider === 'google'
      ? { lastSyncedToGoogle: sql`now()` }
      : { lastSyncedToOutlook: sql`now()` };
    await scopedUpdate(events, lawFirmId, and(
      eq(events.clientId, clientId), eq(events.id, eventId),
    )!, values);
  }

  async applyInboundUpdate(lawFirmId: string, clientId: string, eventId: string, fields: any) {
    if (!isUuid(eventId)) return;
    const allowed: MappedField[] = [
      'title', 'notes', 'status', 'allDay', 'location', 'locationName', 'timeZone', 'googleLastModified', 'outlookLastModified',
      'outlookChangeKey', 'outlookId', 'googleEventId',
    ];
    const values: ClientEventUpdate = {};
    for (const field of allowed) {
      if (fields[field] === undefined) continue;
      setField(values, field, toParam(field, fields[field]));
    }
    if (fields.date !== undefined) {
      const d = fields.date == null ? null : (fields.date instanceof Date ? fields.date : new Date(fields.date));
      values.date = d;
    }
    if (fields.endsAt !== undefined) {
      values.endsAt = fields.endsAt == null ? null : (fields.endsAt instanceof Date ? fields.endsAt : new Date(fields.endsAt));
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(events, lawFirmId, and(
      eq(events.clientId, clientId), eq(events.id, eventId),
    )!, values);
  }

  /**
   * One page of this firm's standalone client events the reminder sweep may
   * have to mail: dated inside `[fromUtc, toUtc]`, neither cancelled nor
   * completed, with their reminder state and assignees.
   *
   * `matter_id is null` is what keeps a matter event off this list even when it
   * also names a client: the matter sweep owns those, and reading them here too
   * would mail the same assignee twice. Ordered by date then id so consecutive
   * pages are stable.
   */
  async findForReminders(lawFirmId: string, { fromUtc, toUtc, limit, offset = 0 }: {
    fromUtc: Date; toUtc: Date; limit: number; offset?: number;
  }) {
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select({ event: events, lastReminderSentAt: reminders.lastSentAt })
      .from(events).leftJoin(reminders, eq(reminders.eventId, events.id))
      .where(and(
        scope,
        isNotNull(events.clientId),
        isNull(events.matterId),
        notInArray(events.status, ['cancelled', 'completed']),
        gte(events.date, fromUtc),
        lte(events.date, toUtc),
      ))
      .orderBy(asc(events.date), asc(events.id))
      .limit(limit).offset(offset));
    const entities = rows.map((r: any) => {
      const e = rowToEntity(r.event);
      e.lastReminderSentAt = r.lastReminderSentAt instanceof Date
        ? r.lastReminderSentAt.toISOString()
        : (r.lastReminderSentAt ?? null);
      return e;
    });
    const assignees = await assigneesByEvent(lawFirmId, entities.map((e: any) => e.id));
    for (const event of entities) {
      const forEvent = assignees.get(event.id);
      event.assignedTo = forEvent?.assignedTo || [];
      event.assignedToName = forEvent?.assignedToName || [];
    }
    return entities;
  }

  /** Claim this client event's reminder before sending. See `eventReminderClaim`. */
  async claimReminderSend(lawFirmId: string, clientId: string, eventId: string, withinHours = 24) {
    return claimEventReminder(lawFirmId, { kind: 'client', clientId }, eventId, withinHours);
  }

  /** Undo a claim whose sends all failed, so the next sweep retries. */
  async releaseReminderClaim(lawFirmId: string, clientId: string, eventId: string, previous: unknown = null) {
    await releaseEventReminder(lawFirmId, { kind: 'client', clientId }, eventId, previous);
  }

  /**
   * All standalone client events across a law firm (used by calendar), with client name.
   *
   * `range` narrows the read to the half-open UTC interval `[startUtc, endUtc)`
   * the calendar is drawing. Undated events fall out of a ranged read, which is
   * correct: an event with no date cannot land on a calendar day. With no range
   * every event comes back, including undated ones.
   */
  async findAllForLawFirm(lawFirmId: string, range: any = null) {
    const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
      .select({ ...EVENT_WITH_COURT, clientName: clients.name }).from(events)
      .leftJoin(clients, and(
        eq(clients.id, events.clientId), eq(clients.lawFirmId, events.lawFirmId),
      )).leftJoin(courts, COURT_JOIN).where(and(
        scope,
        // The only read here that names no client of its own, so it is also the
        // only one that has to say which parent it wants. The join to `clients`
        // is LEFT (a client event whose client row was deleted still shows), so
        // it does not narrow, and without this every matter event in the firm
        // would come back as a client event with a null name.
        isNotNull(events.clientId),
        range ? gte(sql`coalesce(${events.endsAt}, ${events.date})`, tsParam(range.startUtc)!) : undefined,
        range ? lt(events.date, tsParam(range.endUtc)!) : undefined,
      )).orderBy(sql`${events.date} asc nulls last`).limit(ceilingLimit()));
    // Firm-wide and, without a range, over all of history: the read here that
    // grows fastest. It refuses rather than truncating, because a calendar
    // missing its oldest month looks exactly like a calendar with nothing in it.
    return withinCeiling(rows, 'client events in this firm').map((r: any) => {
      const e = rowToEntity(r.event, r.courtName);
      e._clientName = r.clientName || null;
      return e;
    });
  }
}

export = Object.assign(new ClientEventsRepository(), { FIELDS, rowToEntity });
