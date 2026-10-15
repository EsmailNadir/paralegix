import { ceilingLimit, withinCeiling } from '../../shared/database/readCeiling';
import type { DrizzleExecutor } from '../../shared/database/queryContext';
/**
 * Calendar events repository (Postgres, relational; `calendar_events`).
 *
 * Standalone external events synced into Paralegix from Google/Outlook, scoped
 * per firm. Fully relational (formerly a jsonb-doc store; now real columns).
 *
 * The sync engines / external-event adapter read these camelCase keys off the
 * returned object: `title`, `description`, `notes`, `location`, `start`, `end`,
 * `startTimeZone`, `allDay`, `provider`, `externalEventId`, `googleEventId`,
 * `outlookId`, `outlookChangeKey`, `calendarId`, `lastSyncedToGoogle`,
 * `lastSyncedToOutlook`, `googleLastModified`, `outlookLastModified`,
 * `createdAt`, `updatedAt`. The `start`/`end` keys map to the `starts_at`/
 * `ends_at` columns and are returned as JS Date objects (callers use
 * `toDate(...)` defensively, which accepts a Date).
 */

const { privilegedParameterizedQuery } = require('../../shared/database/queryContext');
const { isUuid } = require('../../shared/utils/isUuid');

const calendarSql = (text: string, params: unknown[] = [], executor?: DrizzleExecutor) => privilegedParameterizedQuery(
  'calendar event repository validates firm or provider identity at each entry point', text, params, executor,
);

// camelCase doc field -> { col, kind }. kind: text | ts | bool
const FIELDS: any = {
  title: { col: 'title', kind: 'text' },
  description: { col: 'description', kind: 'text' },
  notes: { col: 'notes', kind: 'text' },
  location: { col: 'location', kind: 'text' },
  start: { col: 'starts_at', kind: 'ts' },
  end: { col: 'ends_at', kind: 'ts' },
  allDay: { col: 'all_day', kind: 'bool' },
  provider: { col: 'provider', kind: 'text' },
  source: { col: 'source', kind: 'text' },
  externalEventId: { col: 'external_event_id', kind: 'text' },
  googleEventId: { col: 'google_event_id', kind: 'text' },
  outlookId: { col: 'outlook_id', kind: 'text' },
  outlookChangeKey: { col: 'outlook_change_key', kind: 'text' },
  calendarId: { col: 'calendar_id', kind: 'text' },
  createdBy: { col: 'created_by', kind: 'text' },
  lastSyncedToGoogle: { col: 'last_synced_to_google', kind: 'ts' },
  lastSyncedToOutlook: { col: 'last_synced_to_outlook', kind: 'ts' },
  googleLastModified: { col: 'google_last_modified', kind: 'ts' },
  outlookLastModified: { col: 'outlook_last_modified', kind: 'ts' },
  icalUid: { col: 'ical_uid', kind: 'text' },
  seriesEventId: { col: 'series_event_id', kind: 'text' },
  startTimeZone: { col: 'start_time_zone', kind: 'text' },
  meeting: { col: 'provider_details', kind: 'json' },
};
const COL_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELDS).map(([f, s]) => [(s as { col: string }).col, f]),
);

// Exactly the columns `rowToDoc` reads, so the list read stops paying for the ones
// it does not. `select *` also returned `stable_id`, a long composite id that
// `rowToDoc` has no mapping for and silently discarded, which cost about 40 kB
// per 720-event calendar window. Derived from COL_TO_FIELD so a new mapped field
// cannot be left out of the projection.
const READ_COLUMNS = ['id', 'law_firm_id', ...Object.keys(COL_TO_FIELD), 'created_at', 'updated_at'].join(', ');

// startTimeZone is the zone the provider reported for the event's start
// (`start_time_zone`), written by the inbound upsert so an edit keeps it.

function tsParam(v: any) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return new Date(v);
}

function toParam(field: any, value: any) {
  const spec = FIELDS[field];
  if (!spec || value === undefined) return undefined;
  switch (spec.kind) {
    case 'ts': return tsParam(value);
    case 'bool': return value === true;
    case 'json': return JSON.stringify(value);
    default: return value;
  }
}

function rowToDoc(row: any) {
  if (!row) return null;
  const doc: any = { id: row.id, lawFirmId: row.law_firm_id };
  for (const [col, field] of Object.entries(COL_TO_FIELD)) {
    // timestamps stay JS Date objects (callers use Date / .toDate() defensively)
    doc[field] = row[col] == null ? null : row[col];
  }
  doc.createdAt = row.created_at || null;
  doc.updatedAt = row.updated_at || null;
  return doc;
}

class CalendarEventsRepository {
  /**
   * Upsert an external event. `id` is the engine-supplied stable id
   * (`google_<eventId>` / `outlook_<eventId>`); we resolve it to the row's uuid
   * via the stable_id column so the same logical event round-trips.
   */
  async upsert(lawFirmId: string, id: any, data: any) {
    const existing = await findRowByStableId(lawFirmId, id);
    if (existing) {
      const set = [];
      const vals = [lawFirmId, existing.id];
      for (const [field, value] of Object.entries(data)) {
        const spec = FIELDS[field];
        if (!spec || value === undefined) continue;
        vals.push(toParam(field, value));
        set.push(`${spec.col} = $${vals.length}`);
      }
      set.push('updated_at = now()');
      const { rows } = await calendarSql(
        `update calendar_events set ${set.join(',')} where law_firm_id = $1 and id = $2 returning *`,
        vals
      );
      return rowToDoc(rows[0]);
    }

    const cols = ['law_firm_id', 'stable_id'];
    const vals = [lawFirmId, id];
    for (const [field, spec] of Object.entries(FIELDS) as Array<[string, { col: string; kind?: string }]>) {
      if (data[field] === undefined) continue;
      cols.push(spec.col);
      vals.push(toParam(field, data[field]));
    }
    if (!cols.includes('title')) { cols.push('title'); vals.push('Untitled Event'); }
    const ph = vals.map((_, i) => `$${i + 1}`);
    const { rows } = await calendarSql(
      `insert into calendar_events (${cols.join(',')}) values (${ph.join(',')}) returning *`,
      vals
    );
    return rowToDoc(rows[0]);
  }

  /**
   * One event, optionally restricted to its owner.
   *
   * `userId` is optional because the sync engine resolves rows it is about to
   * write and legitimately has no acting user. Every CALLER-facing path must
   * pass it: the update and delete routes are gated on `calendar.sync`, which
   * the built-in Attorney and Paralegal roles hold, so without it a colleague
   * could rewrite or delete another member's synced row.
   */
  async findById(lawFirmId: string, id: any, userId: string | null = null) {
    const row = await findRowByStableId(lawFirmId, id);
    if (!row) return null;
    if (userId != null && row.created_by !== userId) return null;
    return rowToDoc(row);
  }

  async findByGoogleEventId(lawFirmId: string, googleEventId: any, userId: string) {
    if (!googleEventId) return null;
    const { rows } = await calendarSql(
      `select * from calendar_events where law_firm_id = $1 and google_event_id = $2 and (created_by = $3 or created_by is null) limit 1`,
      [lawFirmId, googleEventId, userId]
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async findByOutlookId(lawFirmId: string, outlookId: any, userId: string) {
    if (!outlookId) return null;
    const { rows } = await calendarSql(
      `select * from calendar_events where law_firm_id = $1 and outlook_id = $2 and (created_by = $3 or created_by is null) limit 1`,
      [lawFirmId, outlookId, userId]
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  /**
   * Every external event for a firm, optionally bounded to a calendar window.
   *
   * `range` is the half-open UTC interval `[startUtc, endUtc)` the calendar is
   * drawing. The predicate is an OVERLAP, not a containment test: an event that
   * began before the window but runs into it still has to be drawn. Events with
   * no end fall back to their start, so a point-in-time event is treated as a
   * zero-length interval.
   */
  /**
   * Every synced external event belonging to ONE member.
   *
   * `userId` is required, not optional. These rows are pages of that member's
   * personal Google or Outlook calendar (`resolveCalendarId` returns 'primary'
   * for the default target), and the route that reads them is gated on
   * `calendar.view`, which is baseline. Firm scope alone therefore showed every
   * member every colleague's personal calendar.
   *
   * A row with a NULL `created_by` predates the column being populated and is
   * excluded, so it is visible to nobody until it is backfilled. That fails
   * closed: the alternative is showing an unowned row to the whole firm, which
   * is the behaviour being removed.
   */
  async listAll(lawFirmId: string, userId: string, range: any = null) {
    const params: unknown[] = [lawFirmId, userId];
    let where = `law_firm_id = $1 and created_by is not null and created_by = $2`;
    if (range) {
      params.push(range.endUtc, range.startUtc);
      where += ` and starts_at is not null and starts_at < $3 and coalesce(ends_at, starts_at) >= $4`;
    }

    // One row past the ceiling, so a would-be truncation is detectable. Without
    // a range this returns every personal event the user has ever created, so
    // it grows with how long they have used the product rather than with the
    // request. It refuses instead of returning a short list: a calendar missing
    // its oldest month looks exactly like a calendar that has nothing in it.
    params.push(ceilingLimit());
    const { rows } = await calendarSql(
      `select ${READ_COLUMNS} from calendar_events where ${where}
        order by starts_at asc nulls last limit $${params.length}`,
      params
    );
    return withinCeiling(rows, 'personal calendar events').map(rowToDoc);
  }

  /**
   * Provider ids of the events one member imported from `provider`, optionally
   * only those starting inside `[from, to)`, whose id starts with `idPrefix`
   * (the occurrences of one Google series), or that are occurrences of
   * `seriesEventId`. The full poll compares them with
   * what the provider still lists, which is how a deletion whose notification
   * never arrived is caught. Ids only, so the read stays small.
   */
  async listImportedProviderIds(
    lawFirmId: string, userId: string, provider: 'google' | 'outlook',
    { from = null, to = null, idPrefix = null, seriesEventId = null }:
      { from?: Date | null; to?: Date | null; idPrefix?: string | null; seriesEventId?: string | null } = {},
  ) {
    const col = provider === 'google' ? 'google_event_id' : 'outlook_id';
    // `left(...) = prefix`, not LIKE: a Google occurrence id prefix ends in `_`,
    // which LIKE would read as a wildcard.
    const { rows } = await calendarSql(
      `select ${col} as provider_id from calendar_events
        where law_firm_id = $1 and created_by = $2 and provider = $3 and ${col} is not null
          and ($4::timestamptz is null or starts_at >= $4)
          and ($5::timestamptz is null or starts_at < $5)
          and ($6::text is null or left(${col}, length($6::text)) = $6::text)
          and ($7::text is null or series_event_id = $7::text)`,
      [lawFirmId, userId, provider, from, to, idPrefix, seriesEventId]
    );
    return rows.map((r: any) => r.provider_id as string);
  }

  /**
   * Drop what one member imported from a provider they just disconnected, in
   * every firm. An event that was also copied to their OTHER calendar, still
   * connected, stays, now owned by that calendar: it is still on a calendar
   * Paralegix syncs. Everything else from that provider goes, since nothing can
   * update or remove it any more. Provider ids on the rows are left as they
   * are, so a later reconnect updates the same events instead of copying them
   * a second time.
   */
  async forgetProviderImports(userId: string, provider: 'google' | 'outlook', executor?: DrizzleExecutor) {
    const sibling = provider === 'google'
      ? { provider: 'outlook', tokenProvider: 'microsoft', col: 'outlook_id' }
      : { provider: 'google', tokenProvider: 'google', col: 'google_event_id' };
    // calendar_mappings has no FK to the row it names, so the mappings of the
    // copies Paralegix pushed for a removed row are deleted with it.
    const { rows } = await calendarSql(
      `with sibling as (
         select exists (select 1 from user_oauth_tokens
                         where user_id = $1 and provider = $3 and access_token is not null) as connected
       ), kept as (
         update calendar_events set provider = $4, updated_at = now()
          where created_by = $1 and provider = $2 and ${sibling.col} is not null
            and (select connected from sibling)
         returning id
       ), removed as (
         delete from calendar_events
          where created_by = $1 and provider = $2 and id not in (select id from kept)
         returning id
       ), unmapped as (
         delete from calendar_mappings
          where entity_type = 'externalEvent' and entity_id in (select id::text from removed)
       )
       select count(*)::int as removed from removed`,
      [userId, provider, sibling.tokenProvider, sibling.provider],
      executor,
    );
    return rows[0]?.removed || 0;
  }

  /**
   * One member's import of a meeting from `provider`, by the invitation's
   * normalized iCalendar UID. Occurrences of a repeating event are excluded:
   * they share the series' UID on Google, so the UID alone does not say which
   * occurrence a row is.
   */
  async findImportByICalUid(lawFirmId: string, userId: string, provider: 'google' | 'outlook', icalUid: string) {
    if (!icalUid) return null;
    const { rows } = await calendarSql(
      `select * from calendar_events
        where law_firm_id = $1 and created_by = $2 and provider = $3
          and ical_uid = $4 and series_event_id is null
        limit 1`,
      [lawFirmId, userId, provider, icalUid]
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async delete(lawFirmId: string, id: any) {
    const row = await findRowByStableId(lawFirmId, id);
    if (!row) return;
    await calendarSql(`delete from calendar_events where law_firm_id = $1 and id = $2`, [lawFirmId, row.id]);
  }

  // ── typed calendar-sync writebacks (external event variant) ──────────────
  // External events store the provider event id in simple columns (no per-user
  // map). These apply the descriptors emitted by the external-event adapter.

  async setProviderField(lawFirmId: string, id: any, field: any, value: any) {
    const spec = FIELDS[field];
    if (!spec) return;
    const row = await findRowByStableId(lawFirmId, id);
    if (!row) return;
    await calendarSql(
      `update calendar_events set ${spec.col} = $3, updated_at = now() where law_firm_id = $1 and id = $2`,
      [lawFirmId, row.id, toParam(field, value)]
    );
  }

  async touchProviderSync(lawFirmId: string, id: any, provider: any) {
    const col = provider === 'google' ? 'last_synced_to_google' : 'last_synced_to_outlook';
    const row = await findRowByStableId(lawFirmId, id);
    if (!row) return;
    await calendarSql(
      `update calendar_events set ${col} = now(), updated_at = now() where law_firm_id = $1 and id = $2`,
      [lawFirmId, row.id]
    );
  }
}

/**
 * Resolve a row by the engine-supplied stable id. Accepts the row uuid directly
 * or the `google_<id>` / `outlook_<id>` style id stored in stable_id.
 *
 * `stable_id` is NOT `external_event_id`: the latter holds the provider's own
 * bare event id, while this one is the engine's provider-prefixed composite.
 */
async function findRowByStableId(lawFirmId: string, id: any) {
  if (id == null) return null;
  if (isUuid(id)) {
    const { rows } = await calendarSql(
      `select * from calendar_events where law_firm_id = $1 and id = $2 limit 1`,
      [lawFirmId, id]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await calendarSql(
    `select * from calendar_events where law_firm_id = $1 and stable_id = $2 limit 1`,
    [lawFirmId, String(id)]
  );
  return rows[0] || null;
}

const repo = new CalendarEventsRepository();

export = Object.assign(repo, { FIELDS });
