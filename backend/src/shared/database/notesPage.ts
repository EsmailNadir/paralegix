import { toIlikeTerm } from './searchTerm';

type QueryResult = { rows: any[] };
type RunQuery = (text: string, params: unknown[]) => Promise<QueryResult>;

/**
 * DB row -> camelCase keys.
 *
 * The paged reads here run a raw `select *`/explicit-column SQL string through
 * `tenantParameterizedQuery`, which has no Drizzle column mapper to translate
 * `note_date` into `noteDate` the way a typed `.select().from(table)` query
 * would. Every `format()` callback (matter notes, task notes, the firm-wide
 * list) is written against camelCase fields, so the row is normalized here
 * once rather than in each caller.
 */
function toCamelRow(row: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const key in row) {
    out[key.replace(/_([a-z0-9])/g, (_match: string, c: string) => c.toUpperCase())] = row[key];
  }
  return out;
}

/** Column names the caller's table uses, so this builder stays table-agnostic. */
export interface NoteColumns {
  [key: string]: string;
}

/** The filter set every notes listing accepts off the query string. */
export interface NoteFilters {
  search?: string;
  noteType?: string;
  timeFilter?: string;
  tag?: string;
  /** A single author's user id. */
  authorId?: string;
  /** Inclusive note-date bounds, as 'YYYY-MM-DD'. */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Filter and paging SQL shared by the notes lists on matters and tasks.
 *
 * Both feed the same notes panel, whose search box, type dropdown, time tabs and
 * tag dropdown used to run over the entity's whole note history in the browser.
 * Now that only a page is downloaded, those filters have to run in Postgres, and
 * they have to mean exactly the same thing on both entities — otherwise the same
 * control would select different notes depending on which tab it was opened from.
 * So the predicates live here rather than being spelled out twice.
 *
 * Task notes carry no `note_type` or linked time entry. Rather than skip those
 * filters there (which would make "with time" quietly return every note), the
 * caller passes null for the missing column and the predicate resolves to the
 * constant the absent column implies: every task note reads as an untimed
 * 'general' note, which is exactly how the panel rendered them before.
 */

const { buildPageClause, resolveWindowTotal } = require('./pagination');

/**
 * A `#tag` inside note content. The capture group is the bare word, so the same
 * pattern serves both the tag filter and the distinct-tag list the dropdown is
 * built from.
 */
export const TAG_PATTERN = '#(\\w+)';

/** Note type a row with no `note_type` column reads as, matching the UI's default. */
export const DEFAULT_NOTE_TYPE = 'general';

/**
 * Append the notes filters to `params` (mutating it) and return the SQL to AND
 * onto the caller's tenant/parent predicate.
 *
 * @param {object} args
 * @param {object} args.filters - `{ search, noteType, timeFilter, tag, authorId, dateFrom, dateTo }` from the query string.
 * @param {object} args.columns - SQL expressions for this table; null where the column doesn't exist.
 * @param {string} args.columns.content
 * @param {?string} args.columns.subject
 * @param {?string} args.columns.author - the joined author name, searched alongside the text.
 * @param {?string} args.columns.author_id
 * @param {?string} args.columns.noteType
 * @param {?string} args.columns.noteDate
 * @param {?string} args.columns.hasTime
 * @param {Array} args.params - the caller's param array, appended to in place.
 * @returns {string} the extra WHERE body, already prefixed with ` and ` (empty when nothing filters).
 */
export function buildNotesFilters({ filters = {}, columns, params }: {
  filters?: NoteFilters;
  columns: NoteColumns;
  params: unknown[];
}) {
  const clauses = [];
  const { search, noteType, timeFilter, tag } = filters;

  // `toIlikeTerm` escapes the LIKE metacharacters before adding the surrounding
  // wildcards, and the predicate declares `escape '\'` to match. Interpolating
  // the raw term instead let a caller typing `%` match every note they can read
  // and `_` match any single character, which turns the search box into a way to
  // dump the whole list rather than search it.
  const searchTerm = toIlikeTerm(search);
  if (searchTerm) {
    params.push(searchTerm);
    const needle = `$${params.length}`;
    const targets = [columns.content, columns.subject, columns.author].filter(Boolean);
    clauses.push(`(${targets.map((col) => `${col} ilike ${needle} escape '\\'`).join(' or ')})`);
  }

  if (noteType && noteType !== 'all') {
    if (columns.noteType) {
      params.push(noteType);
      clauses.push(`coalesce(${columns.noteType}, '${DEFAULT_NOTE_TYPE}') = $${params.length}`);
    } else if (noteType !== DEFAULT_NOTE_TYPE) {
      // No type column: every row is 'general', so any other type matches nothing.
      clauses.push('false');
    }
  }

  if (timeFilter === 'with-time') {
    clauses.push(columns.hasTime ? `coalesce(${columns.hasTime}, false) = true` : 'false');
  } else if (timeFilter === 'without-time') {
    clauses.push(columns.hasTime ? `coalesce(${columns.hasTime}, false) = false` : 'true');
  }

  if (tag && tag.trim()) {
    params.push(tag.trim());
    // `\y` is a word boundary, so filtering on #due doesn't also match #duedate.
    clauses.push(`${columns.content} ~* ('#' || $${params.length} || '\\y')`);
  }

  if (filters.authorId && columns.author_id) {
    params.push(filters.authorId);
    clauses.push(`${columns.author_id} = $${params.length}`);
  }

  // Bounds run against the user-settable note date rather than created_at:
  // a note written up on Friday about Tuesday's call belongs to Tuesday.
  if (filters.dateFrom && columns.noteDate) {
    params.push(filters.dateFrom);
    clauses.push(`${columns.noteDate} >= $${params.length}::date`);
  }
  if (filters.dateTo && columns.noteDate) {
    params.push(filters.dateTo);
    clauses.push(`${columns.noteDate} <= $${params.length}::date`);
  }

  return clauses.length ? ` and ${clauses.join(' and ')}` : '';
}

/**
 * Run a paged notes read and resolve its match count.
 *
 * `selectSql` and `countSql` are templates taking the assembled WHERE body and,
 * for the page query, the LIMIT/OFFSET clause. Both must use identical $N
 * numbering, which is why the caller snapshots its params before paging is
 * appended.
 */
export async function readNotesPage({
  query, baseParams, filters, columns, paging, selectSql, countSql, format,
}: {
  query: RunQuery;
  baseParams: unknown[];
  filters?: NoteFilters;
  columns: NoteColumns;
  paging?: { limit?: number; offset?: number; page?: number };
  selectSql: (...args: string[]) => string;
  countSql: (...args: string[]) => string;
  format: (row: any) => unknown;
}) {
  const params: unknown[] = [...baseParams];
  const filterSql = buildNotesFilters({ filters, columns, params });
  const filterParams = [...params];
  const { pageClause, pageOffset } = buildPageClause({
    limit: paging?.limit,
    offset: paging?.offset,
    page: paging?.page,
    params,
    fallbackLimit: 10,
    max: 200,
    optional: true,
  });

  const { rows } = await query(selectSql(filterSql, pageClause), params);
  // Read before camelCasing: this reads the window count off the raw
  // `total_count` alias, which `toCamelRow` would otherwise rename first.
  const totalNotes = await resolveWindowTotal({
    rows,
    pageOffset,
    countSql: countSql(filterSql),
    filterParams,
    countQuery: async () => (await query(countSql(filterSql), filterParams)).rows,
  });
  return { notes: rows.map((row) => format(toCamelRow(row))), totalNotes };
}

/**
 * Counts for the panel's All / With time / Without time tabs.
 *
 * Computed over the search / type / tag filters but NOT over the time filter
 * itself, so selecting one tab cannot zero the other two — the same rule the
 * invoice status chips follow. A count taken from the rows on screen would drift
 * further from the truth with every page.
 *
 * A table with no time column reports everything as untimed, which is how the
 * panel has always rendered task notes.
 */
export async function readNoteTimeCounts({ query, baseParams, filters, columns, countSql }: {
  query: RunQuery;
  baseParams: unknown[];
  filters?: NoteFilters;
  columns: NoteColumns;
  countSql: (...args: string[]) => string;
}) {
  const params: unknown[] = [...baseParams];
  // `timeFilter` is deliberately dropped: it is what these counts describe.
  const filterSql = buildNotesFilters({
    filters: { ...filters, timeFilter: undefined },
    columns,
    params,
  });
  const timed = columns.hasTime ? `coalesce(${columns.hasTime}, false)` : 'false';
  const { rows } = await query(
    countSql(filterSql, `count(*) filter (where ${timed}) as with_time`),
    params
  );
  const all = Number(rows[0].total) || 0;
  const withTime = Number(rows[0].with_time) || 0;
  return { all, withTime, withoutTime: all - withTime };
}

/**
 * The distinct `#tags` used across an entity's notes, for the tag dropdown.
 *
 * Read separately from the page because the dropdown has to offer every tag the
 * entity has ever used, not just the ones that happen to appear on the page in
 * front of the reader — a tag filter that can only select what is already
 * visible filters nothing.
 */
export async function readNoteTags({ query, table, parentColumn, lawFirmId, parentId, useIn = false }: {
  query: RunQuery;
  table: string;
  parentColumn: string;
  lawFirmId: string;
  /** A single parent id, or (when `useIn` is true) an array to widen the match. */
  parentId: string | string[];
  useIn?: boolean;
}) {
  const matchSql = useIn ? `n.${parentColumn} = any($2::uuid[])` : `n.${parentColumn} = $2`;
  const { rows } = await query(
    `select distinct m[1] as tag
       from ${table} n
       cross join lateral regexp_matches(n.content, $3, 'g') as m
      where n.law_firm_id = $1 and ${matchSql}
      order by 1`,
    [lawFirmId, parentId, TAG_PATTERN]
  );
  return rows.map((r: any) => r.tag).filter(Boolean);
}
