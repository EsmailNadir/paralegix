/**
 * Tasks repository (Postgres).
 *
 * The legacy Firestore task document embedded denormalized arrays + name copies.
 * The normalized model stores assignees / clients / dependencies in junction
 * tables and derives the rest at read time:
 *
 *   assignedTo / assignedToName  <- task_assignees JOIN users
 *   dependencies                 <- task_dependencies (task_id -> depends_on)
 *   dependents                   <- task_dependencies (reverse)
 *   visibleToUserIds             <- matter_members (matter-scoped) | members (firm)
 *   clientIds / clientNames      <- matter_clients (matter-scoped) | task_clients (firm)
 *   matterName / practiceAreaName / courtName / createdByName  <- JOINs
 *
 * Operational fields (recurrence, reminder recipients, attachments, external
 * calendar ids) live as columns on `tasks`.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import {
  clients,
  members,
  taskAssignees,
  taskClients,
  taskDependencies,
  notes,
  tasks,
  activities,
  users,
} from '../../shared/database/drizzle/schema';
import {
  rootQueryExecutor,
  tenantParameterizedQuery,
  tenantQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsert,
  scopedInsertManyOnConflictDoNothing,
  scopedUpdate,
  setColumn,
  type UpdateValues,
  type WritableColumn,
} from '../../shared/database/scopedWrite';
import { setAttachments } from '../../shared/attachments/attachmentLinks';

type TaskUpdate = UpdateValues<typeof tasks>;
type TaskColumn = WritableColumn<typeof tasks>;

const { isUuid } = require('../../shared/utils/isUuid');
const { taskDueInstant } = require('./taskDue');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const { clampLimit, buildOrderBy, buildPageClause, resolveWindowTotal } = require('../../shared/database/pagination');
const { ValidationError } = require('../../shared/errors/AppError');
const calendarSyncRepo = require('../calendar/shared/calendarSync.repository');
const { zonedDayString } = require('../../shared/utils/time');

// Scalar provider-id columns the calendar adapters can set/clear via descriptors.
// Keyed by the Drizzle column name so a rename in the schema is a build error
// here rather than a sync field that quietly stops being written.
const TASK_SYNC_COLUMNS = {
  googleEventId: 'google_event_id',
  outlookId: 'outlook_id',
  outlookChangeKey: 'outlook_change_key',
  googleCalendarId: 'google_calendar_id',
} satisfies Partial<Record<TaskColumn, string>>;

type TaskSyncColumn = keyof typeof TASK_SYNC_COLUMNS;

const isTaskSyncColumn = (field: string): field is TaskSyncColumn =>
  Object.prototype.hasOwnProperty.call(TASK_SYNC_COLUMNS, field);

const { rowIso: iso } = require('../../shared/utils/dateConversion');

// Default cap for the "upcoming tasks" 7-day window feed. The dashboard passes
// its own explicit limit, but this default is the single source of truth so the
// two "intended cap" numbers cannot drift across files. The dashboard imports
// this constant (see dashboard.service.js UPCOMING_TASKS_LIMIT) instead of
// hard-coding its own literal.
const UPCOMING_TASKS_DEFAULT_LIMIT = 15;

/**
 * The enriched task projection is kept in three pieces rather than one ready-made
 * SELECT string, so the paged read can put a pre-paged CTE ahead of `tasks` in the
 * FROM. A paginated read needs a total count, and computing that count with a
 * `count(*) over()` window inside the enriched select would force Postgres to
 * materialize every matching row before LIMIT applies, running the lateral
 * assignee/client/dependency joins across the whole match set to display one page.
 * Keeping the pieces separate lets the count live in a CTE over the bare `tasks`
 * table while these joins only ever see the ids that survived the window.
 * See `findVisibleToUserPaged`.
 */

/** Enriched task select list. Assumes `tasks` is aliased `t`. */
const TASK_COLUMNS = `
    t.*,
    c.name  as matter_name,
    pa.name as practice_area_name,
    ct.name as court_name,
    cb.name as created_by_name,
    coalesce(asg.assigned_to, '{}')       as assigned_to_ids,
    coalesce(asg.assigned_to_name, '{}')  as assigned_to_names,
    coalesce(dep.dependencies, '{}')      as dependencies,
    coalesce(dpt.dependents, '{}')        as dependents,
    coalesce(depst.has_incomplete_dependencies, false) as has_incomplete_dependencies,
    coalesce(sbt.subtask_count, 0)           as subtask_count,
    coalesce(sbt.incomplete_subtask_count, 0) as incomplete_subtask_count,
    case when t.matter_id is null then coalesce(fm.ids, '{}') else coalesce(cmv.ids, '{}') end as visible_to_user_ids,
    case when t.matter_id is null then coalesce(tcl.ids, '{}')  else coalesce(ccl.ids, '{}')  end as client_ids,
    case when t.matter_id is null then coalesce(tcl.names, '{}') else coalesce(ccl.names, '{}') end as client_names,
    att.items as attachments`;

/** JOIN chain for `TASK_COLUMNS`. Assumes `tasks` is already aliased `t`. */
const TASK_JOINS = `
  left join matters          c  on c.id  = t.matter_id
  left join practice_areas pa on pa.id = t.practice_area_id
  left join courts         ct on ct.id = t.court_id
  left join users          cb on cb.id = t.created_by
  left join lateral (
    select array_agg(ta.user_id order by ta.user_id)              as assigned_to,
           array_agg(coalesce(u.name,'') order by ta.user_id)     as assigned_to_name
    from task_assignees ta left join users u on u.id = ta.user_id
    where ta.task_id = t.id
  ) asg on true
  -- What is attached, assembled from the attachments and files tables rather
  -- than read off a jsonb column that copied both. A lateral rather than a
  -- second query because ten read paths share this projection; the note reads,
  -- whose SQL is assembled by a shared builder, use withAttachments instead.
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', f.id,
             'name', f.name,
             'size', coalesce(f.size_bytes, 0),
             'type', coalesce(f.mime_type, 'application/octet-stream'),
             'objectPath', f.object_path
           -- sort_order is the record's own order (migration 0262). created_at
           -- cannot serve: it defaults to now(), the TRANSACTION timestamp, so
           -- every row one save writes carries the same value.
           ) order by a.sort_order nulls last, a.created_at), '[]'::jsonb) as items
      from attachments a
      join files f on f.id = a.file_id and f.law_firm_id = a.law_firm_id
     where a.law_firm_id = t.law_firm_id and a.task_id = t.id
       and f.deleted_at is null
  ) att on true
  left join lateral (select array_agg(depends_on_task_id) as dependencies from task_dependencies where task_id = t.id) dep on true
  left join lateral (select array_agg(task_id) as dependents from task_dependencies where depends_on_task_id = t.id) dpt on true
  left join lateral (
    select bool_or(dt.status is distinct from 'completed') as has_incomplete_dependencies
    from task_dependencies td
    join tasks dt on dt.id = td.depends_on_task_id and dt.law_firm_id = t.law_firm_id
    where td.task_id = t.id
  ) depst on true
  left join lateral (
    select count(*)                                     as subtask_count,
           count(*) filter (where not is_completed)      as incomplete_subtask_count
    from task_subtasks
    where task_id = t.id
  ) sbt on true
  left join lateral (select array_agg(user_id) as ids from matter_members where matter_id = t.matter_id) cmv on true
  -- Everyone in the firm, for the firm-scoped (matter-less) tasks. LATERAL rather
  -- than a CTE that groups members by law_firm_id and joins on it: Postgres cannot
  -- push a join qualifier through a GROUP BY, so that shape aggregates every member
  -- row of every tenant on every task read. This one is driven by t.law_firm_id and
  -- touches only this firm's rows.
  left join lateral (select array_agg(user_id) as ids from members where law_firm_id = t.law_firm_id) fm on true
  left join lateral (
    select array_agg(cli.id) as ids, array_agg(cli.name) as names
    from matter_clients ccj join clients cli on cli.id = ccj.client_id where ccj.matter_id = t.matter_id
  ) ccl on true
  left join lateral (
    select array_agg(cli.id) as ids, array_agg(cli.name) as names
    from task_clients tcj join clients cli on cli.id = tcj.client_id where tcj.task_id = t.id
  ) tcl on true
`;

/**
 * The assembled enriched projection every non-paged read appends its own
 * `where` / `order by` to. Identical to the string this module has always used.
 */
const TASK_SELECT = `
  select${TASK_COLUMNS}
  from tasks t${TASK_JOINS}`;

function hydrate(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    taskId: r.id,
    lawFirmId: r.law_firm_id,
    matterId: r.matter_id,
    matterName: r.matter_name || null,
    title: r.title,
    description: r.description || '',
    location: r.location || null,
    status: r.status,
    priority: r.priority || 'medium',
    dueDate: r.due_date || null, // 'YYYY-MM-DD'
    dueAt: r.due_at ? (r.due_at instanceof Date ? r.due_at.toISOString() : r.due_at) : null,
    endsAt: r.ends_at ? (r.ends_at instanceof Date ? r.ends_at.toISOString() : r.ends_at) : null,
    dueDateTimeZone: r.due_date_timezone || null,
    allDay: r.all_day || false,
    source: r.source || null,
    assignedTo: r.assigned_to_ids || [],
    assignedToName: r.assigned_to_names || [],
    visibleToUserIds: r.visible_to_user_ids || [],
    clientIds: r.client_ids || [],
    clientNames: r.client_names || [],
    practiceAreaId: r.practice_area_id,
    practiceAreaName: r.practice_area_name || null,
    courtId: r.court_id,
    courtName: r.court_name || null,
    createdBy: r.created_by,
    createdByName: r.created_by_name || null,
    dependencies: r.dependencies || [],
    dependents: r.dependents || [],
    hasIncompleteDependencies: r.has_incomplete_dependencies || false,
    subtaskCount: Number(r.subtask_count || 0),
    incompleteSubtaskCount: Number(r.incomplete_subtask_count || 0),
    recurrence: r.recurrence || null,
    reminderRecipientIds: r.reminder_recipient_ids || [],
    sendReminderEarly: r.send_reminder_early || false,
    attachments: r.attachments || [],
    googleEventId: r.google_event_id || null,
    outlookId: r.outlook_id || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const dateOnly = (v: any) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
};

async function oneById(lawFirmId: string, taskId: string, executor?: DrizzleExecutor) {
  if (!isUuid(taskId)) return null;
  const [{ rows }, timeRows] = await Promise.all([
    tenantParameterizedQuery(
      tasks,
      lawFirmId,
      `${TASK_SELECT} where t.law_firm_id = $1 and t.id = $2 limit 1`,
      [lawFirmId, taskId],
      't',
      executor,
    ),
    // Time recorded against this task, split by whether it can be invoiced. Only
    // the detail read pays for this aggregate; the list SELECT stays untouched.
    tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor.select({
      totalHours: sql<string>`coalesce(sum(${activities.hours}), 0)`,
      billableHours: sql<string>`coalesce(sum(${activities.hours}) filter (where ${activities.billable}), 0)`,
      entryCount: sql<number>`count(*)`,
    }).from(activities).where(and(scope, eq(activities.kind, 'time'), eq(activities.sourceTaskId, taskId))), executor),
  ]);
  if (!rows[0]) return null;
  const totals = timeRows[0] || {};
  return {
    ...hydrate(rows[0]),
    loggedHours: Number(totals.totalHours || 0),
    billableLoggedHours: Number(totals.billableHours || 0),
    timeEntryCount: Number(totals.entryCount || 0),
  };
}

/**
 * WHERE clause + params shared by every task-list read: the enriched paged list
 * and the ids-only read behind "select all". Both must agree exactly on what the
 * current filters match, so the predicate lives here once rather than being
 * written twice.
 *
 * `t` is the `tasks` alias, and $1 is always the law firm. Filters are appended in
 * order and index off `params.length`, so the caller can keep appending its own
 * (paging) params afterwards.
 *
 * @returns {{ whereSql: string, params: any[] }}
 */
function buildTaskListWhere(lawFirmId: string, userId: string, {
  seeAll = false,
  status,
  assignee,
  matterId,
  clientId,
  priority,
  search,
  dueFrom,
  dueTo,
  includeSpanning = false,
  spanZone = 'UTC',
}: any = {}) {
  const where = [`t.law_firm_id = $1`];
  const params: unknown[] = [lawFirmId];

  // Firm owners/admins (`seeAll`) see every firm task, so the membership predicate
  // (and its userId param) is omitted; subsequent filters index off params.length
  // so they stay correct either way.
  if (!seeAll) {
    params.push(userId);
    where.push(`(t.matter_id is null or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $${params.length}))`);
  }

  // `active` is a filter-only sentinel for "not completed", spanning open,
  // in_progress and blocked. A caller listing outstanding work cannot express that
  // by matching one status, and picking `open` alone hides in-progress and blocked
  // tasks that are still due.
  if (status === 'active') {
    where.push(`t.status <> 'completed'`);
  } else if (status) {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (priority) { params.push(priority); where.push(`t.priority = $${params.length}`); }
  // `due_date` is a day-only `date` column, so an inclusive day window is compared
  // as calendar days with no timezone conversion. A task with no due date is
  // dropped by a bounded read: it cannot land on a calendar day.
  // Calendar reads also include a task that started earlier and is still
  // running when the window opens: an all-day span whose exclusive end is after
  // the first day's noon anchor, or a timed one whose end is after midnight of
  // the first day in the caller's zone. Ordinary due-date filters stay start-only.
  if (dueFrom) {
    params.push(dueFrom);
    const lower = `$${params.length}::date`;
    if (includeSpanning) {
      params.push(spanZone);
      const zone = `$${params.length}::text`;
      where.push(`(t.due_date >= ${lower} or t.ends_at > case when t.all_day
          then (${lower} + time '12:00') at time zone 'UTC'
          else ${lower}::timestamp at time zone ${zone} end)`);
    } else {
      where.push(`t.due_date >= ${lower}`);
    }
  }
  if (dueTo) { params.push(dueTo); where.push(`t.due_date <= $${params.length}::date`); }
  if (assignee) {
    params.push(assignee);
    where.push(`exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $${params.length})`);
  }
  if (matterId === 'none') {
    where.push(`t.matter_id is null`);
  } else if (isUuid(matterId)) {
    params.push(matterId); where.push(`t.matter_id = $${params.length}`);
  }
  // `clientId` accepts either a single client id or an already-resolved array
  // (the client-detail Tasks tab widens it to that client's id plus every
  // company it's linked to via `client_company_links`, so items belonging to
  // a linked company show up too). A single id is wrapped so the `= any(...)`
  // shape below covers both callers identically.
  const clientIdList = Array.isArray(clientId)
    ? clientId.filter(isUuid)
    : (isUuid(clientId) ? [clientId] : []);
  if (clientIdList.length) {
    params.push(clientIdList);
    where.push(`(
      t.id in (
        select tc.task_id
          from task_clients tc
          join clients client_scope on client_scope.id = tc.client_id
                                   and client_scope.law_firm_id = $1
         where tc.client_id = any($${params.length}::uuid[])
      )
      or t.matter_id in (
        select mc.matter_id
          from matter_clients mc
         where mc.law_firm_id = $1
           and mc.client_id = any($${params.length}::uuid[])
      )
    )`);
  }
  // Free-text search: title/description plus any linked client name (firm-scoped
  // via task_clients, matter-scoped via matter_clients). Parameterized ILIKE with an
  // escaped term so user input can't inject wildcards/SQL.
  //
  // Both client arms are UNCORRELATED `in (...)`, pinned to the firm by $1, and that
  // shape is load-bearing. Written as correlated `exists (... where tcs.task_id = t.id)`
  // they read more naturally and return the same rows, but the planner can only run
  // each as a SubPlan once per CANDIDATE task, so their cost tracks the firm's total
  // task count rather than the page size. Measured over a 5,000-task firm asking for
  // 25 rows: the correlated pair looped 5,000 times each for 30,186 shared buffers,
  // the uncorrelated pair is evaluated once into a hash and probed, for 472.
  //
  // `in` is safe against NULL semantics here: `task_clients.task_id` and
  // `matter_clients.matter_id` are both NOT NULL, so neither subquery can yield a
  // NULL. `t.matter_id` itself IS nullable, but a matter-less task simply fails that
  // arm, exactly as the correlated EXISTS did, and `t.title` is NOT NULL so the OR
  // never collapses to UNKNOWN.
  //
  // `task_clients` carries no law_firm_id of its own; its tenant scope comes from
  // requiring the joined client to be in this firm, intersected with the outer
  // `t.law_firm_id = $1` on the task side.
  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const p = params.length;
    // UNION of index-friendly arms rather than one OR containing two correlated
    // subqueries. This was the worst of the four search predicates: measured at
    // 17.7 SECONDS over 80k tasks, because an OR reaching another table cannot
    // be index-served, so the client-name subqueries re-ran per candidate row.
    // Each arm below hits one table and seeks its own trigram index. Same rows,
    // measured 17,749ms -> 0.71ms; see migration 0141's header.
    //
    // The matter arm returns task ids directly (joined through `tasks`) rather
    // than matter ids, so every arm is union-compatible on `t.id`.
    where.push(`t.id in (
                   select id from tasks where law_firm_id = $1 and title ilike $${p} escape '\\'
             union select id from tasks where law_firm_id = $1 and description ilike $${p} escape '\\'
             union select tcs.task_id from task_clients tcs
                    join clients cls on cls.id = tcs.client_id and cls.law_firm_id = $1
                   where cls.name ilike $${p} escape '\\'
             union select t2.id from tasks t2
                    join matter_clients ccs on ccs.matter_id = t2.matter_id and ccs.law_firm_id = $1
                    join clients cls2 on cls2.id = ccs.client_id and cls2.law_firm_id = $1
                   where t2.law_firm_id = $1 and cls2.name ilike $${p} escape '\\'
                 )`);
  }

  return { whereSql: where.join(' and '), params };
}

class TasksRepository {
  async findByIdRaw(lawFirmId: string, taskId: string) {
    return oneById(lawFirmId, taskId);
  }

  /**
   * Batched title lookup for a set of task ids, scoped to the firm. One
   * round-trip instead of one findByIdRaw per id.
   * Malformed (non-uuid) ids are dropped. Returns a map `{ [taskId]: title }`;
   * ids with no matching task are simply absent.
   */
  async findTitlesByIds(lawFirmId: string, taskIds: string[]) {
    const ids = Array.from(new Set((taskIds || []).filter((id: any) => isUuid(id))));
    if (ids.length === 0) return {};
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ id: tasks.id, title: tasks.title }).from(tasks)
      .where(and(scope, inArray(tasks.id, ids as string[]))));
    const titles: Record<string, any> = {};
    for (const r of rows) titles[r.id] = r.title;
    return titles;
  }

  /**
   * Tasks visible to a user: firm-scoped (any), or matter-scoped where they're a
   * matter member. `seeAll` (firm owners/admins) drops the membership predicate so
   * every firm task is returned, matching the firm-wide matters view they get.
   *
   * `dueFrom`/`dueTo` bound the read to a day window without paginating it: a
   * caller drawing a calendar wants every task due in the days on screen, not the
   * first page of them. Shares `buildTaskListWhere` with the paged read so the two
   * can never disagree about which tasks a filter matches.
   *
   * `status` narrows the read the same way it does on the paged variant. It matters
   * here because this read is unwindowed and every returned row pays for the ten
   * lateral joins in `TASK_SELECT`: a caller that wants only completed tasks and
   * filters the rest out afterwards enriches roughly ten rows for every one it
   * keeps. On a 25,000-task firm that measured ~700ms and ~151,000 buffer hits,
   * against ~70ms and ~28,000 hits once the status reaches the `where`.
   */
  async findVisibleToUser(lawFirmId: string, userId: string, { seeAll = false, status, dueFrom, dueTo, includeSpanning = false, spanZone }: any = {}) {
    const { whereSql, params } = buildTaskListWhere(lawFirmId, userId, { seeAll, status, dueFrom, dueTo, includeSpanning, spanZone });
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT}
       where ${whereSql}
       order by t.created_at desc`,
      params,
      't',
    );
    return rows.map(hydrate);
  }

  /**
   * Server-side paginated/filtered/sorted variant of findVisibleToUser.
   * Filters (`status`, `assignee`, `matterId`), ORDER BY (`sortBy`/`order`) and
   * LIMIT/OFFSET are pushed into SQL; returns `{ tasks, totalTasks }` where
   * totalTasks is the full filtered count, computed in the SAME query via a
   * `count(*) over()` window (one round-trip, not a separate count(*) scan).
   * `assignee` filters on the task_assignees junction; `matterId` accepts a uuid
   * (matter-scoped) or the literal 'none' (firm-scoped only); `priority` filters on
   * the priority enum; `search` is a free-text match against the title /
   * description / client names (ILIKE, so it survives derived/joined columns the
   * generated `search` tsvector doesn't cover). The default sort is `title asc`
   * to match the table UI's initial order (`useTasksTable.ts`). An out-of-range
   * page (offset past the last match) returns no rows but still reports the true
   * `totalTasks`, via a fallback count, so the caller can clamp its page number.
   */
  async findVisibleToUserPaged(lawFirmId: string, userId: string, { seeAll = false, page = 1, limit = 50, status, assignee, matterId, clientId, priority, search, sortBy = 'title', order = 'asc', sort, dueFrom, dueTo, includeSpanning = false, spanZone }: any = {}) {
    const { whereSql, params } = buildTaskListWhere(lawFirmId, userId, {
      seeAll, status, assignee, matterId, clientId, priority, search, dueFrom, dueTo, includeSpanning, spanZone,
    });

    // Whitelist sortable columns -> real ORDER BY expressions (never interpolate
    // user input directly). assignedTo orders by the first assignee name.
    // Sort expressions must be resolvable in the ORDER BY of the wrapping SELECT.
    // matter_name / first-assignee-name reference correlated subqueries (not the
    // derived output aliases, which aren't visible to ORDER BY in this CTE shape).
    const SORT_COLUMNS = {
      title: 't.title',
      status: 't.status',
      priority: 't.priority',
      dueDate: 't.due_date',
      matterId: '(select cs.name from matters cs where cs.id = t.matter_id)',
      assignedTo: '(select min(coalesce(u2.name, \'\')) from task_assignees ta2 left join users u2 on u2.id = ta2.user_id where ta2.task_id = t.id)',
      createdAt: 't.created_at',
    };
    // Build a multi-column ORDER BY from the requested sort model. `sort` is an
    // ordered array of { field, dir }; unknown fields are skipped. Falls back to
    // the single sortBy/order, then to title asc. `t.created_at desc` is always
    // appended as a stable tiebreaker so pagination is deterministic.
    const orderSql = buildOrderBy({
      sort, sortBy, order,
      columns: SORT_COLUMNS,
      fallback: { field: 'title', dir: 'asc' },
      tiebreaker: 't.created_at desc',
      defaultDir: 'asc',
    });

    // Snapshot the filter params before the paging params are appended, so the
    // out-of-range count below can reuse `whereSql` with identical $N numbering.
    const filterParams = params.slice();
    // Always windowed (unlike the matters/clients lists): the tasks grid is the
    // only caller, and the full-set reads go through findVisibleToUser instead.
    const { pageClause, pageOffset } = buildPageClause({ limit, page, params, max: 200 });

    // Single round-trip, page-then-enrich. The `page` CTE does the counted, sorted,
    // windowed scan over the bare `tasks` table; the enriched projection then joins
    // onto the ids it produced.
    //
    // `count(*) over()` is a window function, so Postgres must materialize every
    // matching row before LIMIT applies. Computing it inside the enriched select
    // therefore runs the lateral assignee/client/dependency joins once per MATCHING
    // task (thousands) to display one page (tens), regardless of where the count
    // column sits in the select list. Isolating the window in a CTE that touches no
    // joins keeps the count exact while the enrichment sees only the page.
    //
    // `page` must LEAD the FROM. Appending `join page p on p.id = t.id` after the
    // existing join chain is valid SQL and looks equivalent, but it lets the planner
    // pick a merge join that enriches the full match set anyway.
    //
    // The ORDER BY is applied inside the CTE (to choose the page) and again outside
    // (the join does not preserve CTE order); every SORT_COLUMNS expression resolves
    // against `t` or a scalar subquery, so it is valid in both positions.
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `with page as (
         select t.id, count(*) over() as total_count
           from tasks t
          where ${whereSql}
          order by ${orderSql}${pageClause}
       )
       select${TASK_COLUMNS},
              p.total_count
         from page p
         join tasks t on t.id = p.id and t.law_firm_id = $1${TASK_JOINS}
        order by ${orderSql}`,
      params,
      't',
    );
    const totalTasks = await resolveWindowTotal({
      rows,
      pageOffset,
      countSql: `select count(*)::int as total from tasks t where ${whereSql}`,
      filterParams,
      countQuery: async () => {
        const result = await tenantParameterizedQuery(
          tasks,
          lawFirmId,
          `select count(*)::int as total from tasks t where ${whereSql}`,
          filterParams,
          't',
        );
        return result.rows;
      },
    });
    return { tasks: rows.map(hydrate), totalTasks };
  }

  /**
   * Task counts per status for everything the user can see.
   *
   * Callers that show firm-wide totals alongside a date-windowed task list cannot
   * derive them from that list. One grouped query is cheaper than fetching the
   * tasks to count them, and keeps the totals meaning "the whole firm" rather than
   * "the days on screen". Accepts the same filters as the list so the two never
   * disagree about what they are counting.
   */
  async countByStatus(lawFirmId: string, userId: string, { seeAll = false, dueFrom, dueTo }: any = {}) {
    const { whereSql, params } = buildTaskListWhere(lawFirmId, userId, { seeAll, dueFrom, dueTo });
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `select t.status, count(*)::int as count from tasks t where ${whereSql} group by t.status`,
      params,
      't',
    );
    const counts: any = { open: 0, in_progress: 0, completed: 0, blocked: 0 };
    let total = 0;
    for (const row of rows as any[]) {
      if (row.status in counts) counts[row.status] = row.count;
      total += row.count;
    }
    return { counts, total };
  }

  /**
   * Every task id matching the same filters `findVisibleToUserPaged` would apply,
   * ignoring pagination. Backs the grid's "select all", where the user means the
   * whole filtered set rather than the page in front of them.
   *
   * Deliberately id-only: no enrichment joins, no ORDER BY (a selection is a set),
   * so the cost is one index scan over `tasks` regardless of how many match.
   *
   * `max` bounds the answer. One extra row is fetched to detect the overflow, so a
   * caller can tell "exactly max matched" from "more than max matched" and say so
   * instead of silently selecting a subset.
   *
   * @returns {Promise<{ ids: string[], truncated: boolean }>}
   */
  async listVisibleIds(lawFirmId: string, userId: string, { max = 5000, ...filters }: any = {}) {
    const { whereSql, params } = buildTaskListWhere(lawFirmId, userId, filters);
    params.push(max + 1);
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `select t.id from tasks t where ${whereSql} limit $${params.length}`,
      params,
      't',
    );
    return { ids: rows.slice(0, max).map((r: any) => r.id), truncated: rows.length > max };
  }

  /**
   * Slim typeahead source for task pickers. Deliberately does NOT go through
   * TASK_SELECT: hydrating assignees, clients and dependencies through lateral
   * JOINs to render three fields in a dropdown is wasted work on a per-keystroke
   * request. Fetches limit+1 rows so the caller can report `hasMore` without a
   * count query.
   */
  async lookupTasks(lawFirmId: string, userId: string, { seeAll = false, search, exactName, ids, clientId, matterId, limit = 20 }: any = {}) {
    const where = [`t.law_firm_id = $1`];
    const params: unknown[] = [lawFirmId];

    if (clientId !== undefined && clientId !== null && clientId !== '') {
      // A scoped request whose scope cannot be resolved must return nothing.
      // Ignoring an unusable clientId would silently answer "this client's
      // tasks" with every task in the firm, which is exactly the misattribution
      // the scoping exists to prevent. Mirrors lookupMatters.
      if (!isUuid(clientId)) return { items: [], hasMore: false };
      params.push(clientId);
      // task_clients carries no law_firm_id (unlike matter_clients), so tenant
      // scoping rides on `t.law_firm_id` above rather than on the junction row.
      where.push(`exists (select 1 from task_clients tc2
                           where tc2.task_id = t.id
                             and tc2.client_id = $${params.length})`);
    }

    if (matterId !== undefined && matterId !== null && matterId !== '') {
      // Same "unresolvable scope returns nothing" rule as clientId above. This
      // is what lets the create/edit task duplicate-title advisory compare
      // against tasks on the same matter instead of the whole firm - task
      // titles are commonly reused across matters (e.g. "Draft the complaint"),
      // so an unscoped firm-wide match reads as a false alarm on nearly every
      // edit of a task with a common title.
      if (!isUuid(matterId)) return { items: [], hasMore: false };
      params.push(matterId);
      where.push(`t.matter_id = $${params.length}`);
    }

    if (!seeAll) {
      // Firm-level (matter-less) tasks are visible to everyone in the firm;
      // matter-scoped tasks require membership of that matter. Kept in sync with
      // the same predicate in findVisibleToUserPaged.
      params.push(userId);
      where.push(`(t.matter_id is null or exists (select 1 from matter_members cm
                     where cm.matter_id = t.matter_id and cm.user_id = $${params.length}))`);
    }

    const wantsIdResolution = Array.isArray(ids) && ids.length > 0;
    const idList = wantsIdResolution ? ids.filter(isUuid) : [];

    if (wantsIdResolution) {
      // An id-resolution request that matches nothing must return nothing. Falling
      // through to the search branch here would answer "label these specific tasks"
      // with an arbitrary page of unrelated ones, so a picker holding a stale or
      // malformed id would display the wrong task as its selection.
      if (!idList.length) return { items: [], hasMore: false };
      params.push(idList);
      where.push(`t.id = any($${params.length}::uuid[])`);
    } else if (typeof exactName === 'string' && exactName.trim()) {
      params.push(exactName.trim());
      where.push(`lower(btrim(t.title)) = lower($${params.length})`);
    } else {
      const term = toIlikeTerm(search);
      if (term) {
        params.push(term);
        where.push(`t.title ilike $${params.length} escape '\\'`);
      }
    }

    const lim = clampLimit(limit, { fallback: 20, max: 50 });
    params.push(lim + 1);

    // priority/due_date ride along so a caller rendering search results as task
    // rows (the dashboard search) has what it needs without a second read. Two
    // scalar columns on <=51 rows, not an enrichment JOIN.
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `select t.id, t.title, t.status, t.priority, t.due_date,
              (select m.name from matters m where m.id = t.matter_id) as matter_name
         from tasks t
        where ${where.join(' and ')}
        order by t.title asc nulls last, t.created_at desc
        limit $${params.length}`,
      params,
      't',
    );

    const hasMore = rows.length > lim;
    return {
      items: rows.slice(0, lim).map((r: any) => ({
        id: r.id,
        label: r.title || 'Untitled Task',
        sublabel: r.matter_name || null,
        status: r.status || null,
        priority: r.priority || null,
        dueDate: r.due_date || null,
      })),
      hasMore,
    };
  }

  /**
   * Lightweight analytics aggregates: status/priority counts via FILTER, overdue
   * and avg-completion (created->updated) in SQL, plus a small assignee aggregate
   * and a created/completed daily trend, all without hydrating the full
   * TASK_SELECT. `cutoff` (a Date or ISO string) pushes the dateRange window into
   * `where created_at >= cutoff`.
   */
  async getAnalyticsAggregates(lawFirmId: string, userId: string, { cutoff = null, timeZone = 'UTC', seeAll = false }: any = {}) {
    // Firm owners/admins (`seeAll`) aggregate the whole firm, like every other
    // task read; everyone else stays on firm-wide tasks plus their matters.
    const where = [`t.law_firm_id = $1`];
    const params: unknown[] = [lawFirmId];
    if (!seeAll) {
      params.push(userId);
      where.push(`(t.matter_id is null or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $${params.length}))`);
    }
    if (cutoff) { params.push(cutoff instanceof Date ? cutoff.toISOString() : cutoff); where.push(`t.created_at >= $${params.length}`); }
    const whereSql = where.join(' and ');
    // Every day below is a day in the caller's zone.
    params.push(timeZone);
    const tz = `$${params.length}`;

    // overdue: non-completed with a due day behind the caller's today, the rule
    // every other overdue check uses. "Noon UTC on the due day has passed"
    // counted a task due today as overdue from 5am Pacific.
    const summaryQ = tenantParameterizedQuery(tasks, lawFirmId,
      `select
         count(*)::int as total,
         count(*) filter (where t.status = 'completed')::int   as completed,
         count(*) filter (where t.status = 'in_progress')::int as in_progress,
         count(*) filter (where t.status = 'blocked')::int     as blocked,
         count(*) filter (where t.status not in ('completed','in_progress','blocked'))::int as open,
         count(*) filter (where t.status <> 'completed' and t.due_date is not null
                           and t.due_date < (now() at time zone ${tz})::date)::int as overdue,
         count(*) filter (where t.priority = 'low')::int    as p_low,
         count(*) filter (where t.priority = 'medium')::int as p_medium,
         count(*) filter (where t.priority = 'high')::int   as p_high,
         count(*) filter (where t.priority = 'urgent')::int as p_urgent,
         avg(extract(epoch from (t.updated_at - t.created_at)))
           filter (where t.status = 'completed' and t.updated_at > t.created_at) as avg_completion_seconds
       from tasks t where ${whereSql}`,
      params,
      't',
    );

    const byAssigneeQ = tenantParameterizedQuery(tasks, lawFirmId,
      `select ta.user_id as user_id,
              max(coalesce(u.name, '')) as name,
              count(*)::int as total,
              count(*) filter (where t.status = 'completed')::int as completed,
              count(*) filter (where t.status <> 'completed' and t.due_date is not null
                               and t.due_date < (now() at time zone ${tz})::date)::int as overdue
         from tasks t
         join task_assignees ta on ta.task_id = t.id
         left join users u on u.id = ta.user_id
        where ${whereSql}
        group by ta.user_id
        order by count(*) desc`,
      params,
      't',
    );

    const trendQ = tenantParameterizedQuery(tasks, lawFirmId,
      `select day::text as date, sum(created)::int as created, sum(completed)::int as completed
         from (
           select (t.created_at at time zone ${tz})::date as day, 1 as created, 0 as completed
             from tasks t where ${whereSql}
           union all
           select (t.updated_at at time zone ${tz})::date as day, 0 as created, 1 as completed
             from tasks t where ${whereSql} and t.status = 'completed'
         ) s
        group by day
        order by day asc`,
      params,
      't',
    );

    const [summaryR, byAssigneeR, trendR] = await Promise.all([summaryQ, byAssigneeQ, trendQ]);
    return {
      summary: summaryR.rows[0],
      byAssignee: byAssigneeR.rows,
      trend: trendR.rows,
    };
  }

  /**
   * Upcoming-deadline widget feed: tasks visible to the user (firm-scoped or
   * matter-member) that are non-completed and due within today..+7 days
   * (inclusive), ordered by due_date, capped in SQL. The day-window predicate
   * computes today's date in the viewer's `tz` (`(now() at time zone $tz)::date`)
   * using the SAME bounds as dashboard.taskStats' `upcomingDeadlines` count so
   * the list and the count agree at timezone edges. `tz` defaults to 'UTC',
   * which reproduces the server-tz behavior for any caller that omits it.
   */
  async findUpcomingForUser(lawFirmId: string, userId: string, limit = UPCOMING_TASKS_DEFAULT_LIMIT, tz = 'UTC') {
    const zone = tz || 'UTC';
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT}
       where t.law_firm_id = $1
         and t.status <> 'completed'
         and t.due_date is not null
         and t.due_date >= (now() at time zone $4)::date
         and t.due_date <= (now() at time zone $4)::date + 7
         and (t.matter_id is null
              or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $2))
       order by t.due_date asc nulls last, t.created_at desc
       limit $3`,
      [lawFirmId, userId, limit, zone],
      't',
    );
    return rows.map(hydrate);
  }

  /**
   * Visible-to-user, non-completed tasks whose due date is already in the past
   * (`due_date < today`). Mirrors `findUpcomingForUser`'s visibility + the
   * viewer-tz `(now() at time zone $tz)::date` boundary so the dashboard's
   * "Overdue" list and its `overdueTasks` count agree at timezone edges. `tz`
   * defaults to 'UTC' (server-tz behavior) for callers that omit it. Ordered
   * oldest-overdue first.
   */
  async findOverdueForUser(lawFirmId: string, userId: string, limit = UPCOMING_TASKS_DEFAULT_LIMIT, tz = 'UTC') {
    const zone = tz || 'UTC';
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT}
       where t.law_firm_id = $1
         and t.status <> 'completed'
         and t.due_date is not null
         and t.due_date < (now() at time zone $4)::date
         and (t.matter_id is null
              or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $2))
       order by t.due_date asc nulls last, t.created_at desc
       limit $3`,
      [lawFirmId, userId, limit, zone],
      't',
    );
    return rows.map(hydrate);
  }

  /**
   * The tasks of one matter, newest first. `seeAll` (firm owners and admins) drops
   * the membership join, the same see-all branch the firm list and the task
   * detail read use; everyone else must be a member of the matter.
   */
  async findByMatterAndUser(lawFirmId: string, matterId: string, userId: string, { seeAll = false }: any = {}) {
    if (!isUuid(matterId)) return [];
    const params: unknown[] = [lawFirmId, matterId];
    let memberClause = '';
    if (!seeAll) {
      params.push(userId);
      memberClause = `and exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $${params.length})`;
    }
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT}
       where t.law_firm_id = $1 and t.matter_id = $2
         ${memberClause}
       order by t.created_at desc`,
      params,
      't',
    );
    return rows.map(hydrate);
  }

  async findByMatter(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return [];
    const { rows } = await tenantParameterizedQuery(
      tasks, lawFirmId, `${TASK_SELECT} where t.law_firm_id = $1 and t.matter_id = $2`,
      [lawFirmId, matterId], 't',
    );
    return rows.map(hydrate);
  }

  async findAssignedToUser(lawFirmId: string, userId: string, { limit = null }: any = {}) {
    const params: unknown[] = [lawFirmId, userId];
    let pageClause = '';
    if (limit != null) {
      params.push(limit);
      pageClause = ` limit $${params.length}`;
    }
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT}
       where t.law_firm_id = $1 and t.status <> 'completed'
         and exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $2)
         and (t.matter_id is null
              or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $2))
       order by t.due_date asc nulls last${pageClause}`,
      params,
      't',
    );
    return rows.map(hydrate);
  }

  /** Cheap count of assigned non-completed tasks (no heavy JOINs). */
  /**
   * The COUNT that sits above `findAssignedToUser`'s list, so the two must
   * select the same rows. The matter-membership clause is copied from that
   * query for exactly that reason: without it the dashboard showed a member a
   * count of 1 over an empty list, naming a task on a matter they had been
   * taken off and could not open.
   */
  async countAssignedToUser(lawFirmId: string, userId: string) {
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `select count(*)::int as c
         from tasks t
        where t.law_firm_id = $1 and t.status <> 'completed'
          and exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $2)
          and (t.matter_id is null
               or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $2))`,
      [lawFirmId, userId],
      't',
    );
    return rows[0]?.c || 0;
  }

  /** Reminder cron: non-completed tasks with a due date (per firm). */
  async findReminderCandidates(lawFirmId: string) {
    const { rows } = await tenantParameterizedQuery(
      tasks, lawFirmId,
      `${TASK_SELECT} where t.law_firm_id = $1 and t.status <> 'completed' and t.due_date is not null`,
      [lawFirmId], 't',
    );
    return rows.map(hydrate);
  }

  /**
   * Claim one recipient for five minutes. Only successful delivery starts the
   * 24-hour suppression window; a crashed sender's lease can be reclaimed.
   *
   * The task-scoped `reminders` row is read as a second 24-hour gate. Instances
   * still running the previous sender claim and stamp that row, not
   * `task_reminder_deliveries`, so honoring it during the transition keeps a
   * task they reminded from being reminded again. It is read, never written.
   */
  async claimReminderSend(lawFirmId: string, taskId: string, recipientKey: string) {
    if (!isUuid(taskId) || !recipientKey) return null;
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `insert into task_reminder_deliveries (law_firm_id, task_id, recipient_key, claim_token, claim_expires_at)
       select t.law_firm_id, t.id, $3, gen_random_uuid(), now() + interval '5 minutes'
         from tasks t
        where t.law_firm_id = $1 and t.id = $2 and t.status <> 'completed'
          and not exists (select 1 from reminders lr
                           where lr.law_firm_id = t.law_firm_id and lr.task_id = t.id
                             and lr.last_sent_at >= now() - interval '24 hours')
       on conflict (law_firm_id, task_id, recipient_key)
       do update set claim_token = gen_random_uuid(), claim_expires_at = now() + interval '5 minutes'
        where (task_reminder_deliveries.last_sent_at is null
           or task_reminder_deliveries.last_sent_at < now() - interval '24 hours')
          and (task_reminder_deliveries.claim_expires_at is null or task_reminder_deliveries.claim_expires_at <= now())
          and not exists (select 1 from reminders lr
                           where lr.law_firm_id = task_reminder_deliveries.law_firm_id
                             and lr.task_id = task_reminder_deliveries.task_id
                             and lr.last_sent_at >= now() - interval '24 hours')
       returning id, claim_token, sent_count`,
      [lawFirmId, taskId, recipientKey],
      't',
    );
    return rows[0] ? { id: rows[0].id, token: rows[0].claim_token, sentCount: rows[0].sent_count } : null;
  }

  /** Fence completion by the lease token so an expired worker cannot overwrite its successor. */
  async completeReminderSend(lawFirmId: string, taskId: string, recipientKey: string, token: string) {
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `update task_reminder_deliveries r
          set last_sent_at = now(), sent_count = r.sent_count + 1, claim_token = null, claim_expires_at = null
         from tasks t
        where r.task_id = t.id and r.law_firm_id = t.law_firm_id
          and t.law_firm_id = $1 and t.id = $2 and r.recipient_key = $3 and r.claim_token = $4
          and r.claim_expires_at > now()
       returning r.id`,
      [lawFirmId, taskId, recipientKey, token], 't');
    return rows.length > 0;
  }

  /** Release only this worker's failed recipient; successful recipients remain suppressed. */
  async releaseReminderClaim(lawFirmId: string, taskId: string, recipientKey: string, token: string) {
    await tenantParameterizedQuery(tasks, lawFirmId,
      `update task_reminder_deliveries r
          set claim_token = null, claim_expires_at = null
         from tasks t
        where r.task_id = t.id and r.law_firm_id = t.law_firm_id
          and t.law_firm_id = $1 and t.id = $2 and r.recipient_key = $3 and r.claim_token = $4`,
      [lawFirmId, taskId, recipientKey, token],
      't',
    );
  }

  /** Recurrence cron: completed tasks whose recurrence is still enabled. */
  async findRecurringCompleted(lawFirmId: string) {
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `select ${TASK_COLUMNS}, t.xmin::text as recurrence_version
       from tasks t${TASK_JOINS} where t.law_firm_id = $1 and t.status = 'completed'
         and coalesce((t.recurrence->>'enabled')::boolean, false) = true`,
      [lawFirmId],
      't',
    );
    return rows.map((row: any) => ({ ...hydrate(row), recurrenceVersion: row.recurrence_version }));
  }

  /**
   * Turn off recurrence on a task (successor spawned, or limit/endDate reached),
   * and report whether THIS caller was the one that turned it off.
   *
   * The guard on `enabled = true` makes this a claim rather than a blind write,
   * which is what lets the spawn path flip recurrence off BEFORE creating the
   * successor: two concurrent sweeps both read the same completed task, but only
   * one update finds it still enabled, so only one clones the task. Without the
   * guard, both updates succeed and both clone.
   *
   * @returns {Promise<boolean>} true if this call disabled it, false if it was
   *   already disabled (or the task is gone), meaning another worker claimed it.
   */
  async disableRecurrence(lawFirmId: string, taskId: string, executor?: DrizzleExecutor, recurrenceVersion?: string) {
    if (!isUuid(taskId)) return false;
    const rows = await scopedUpdate(tasks, lawFirmId, and(
      eq(tasks.id, taskId),
      eq(tasks.status, 'completed'),
      // The sweep's row version must still match, including edits made after its batch read.
      recurrenceVersion === undefined ? undefined : sql`${tasks}.xmin::text = ${recurrenceVersion}`,
      sql`coalesce((${tasks.recurrence}->>'enabled')::boolean, false) = true`,
    )!, {
      recurrence: sql`jsonb_set(coalesce(${tasks.recurrence}, '{}'::jsonb), '{enabled}', 'false'::jsonb)`,
    }, executor);
    return rows.length > 0;
  }

  /** Calendar sync dedup: resolve a task id by its stored provider event id. */
  async findIdByGoogleEventId(lawFirmId: string, googleEventId: any) {
    if (!googleEventId) return null;
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ id: tasks.id }).from(tasks)
      .where(and(scope, eq(tasks.googleEventId, googleEventId))).limit(1));
    return rows[0]?.id || null;
  }

  async findIdByOutlookId(lawFirmId: string, outlookId: any) {
    if (!outlookId) return null;
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ id: tasks.id }).from(tasks)
      .where(and(scope, eq(tasks.outlookId, outlookId))).limit(1));
    return rows[0]?.id || null;
  }

  async createTask(lawFirmId: string, data: any, writeRelated?: (taskId: string, transaction: DrizzleExecutor) => Promise<void>, executor?: DrizzleExecutor) {
    const taskId = await withDrizzleTransaction(async (client: any) => {
      const cols: any = {
        matterId: isUuid(data.matterId) ? data.matterId : null,
        title: data.title,
        description: data.description || '',
        location: data.location || null,
        status: data.status || 'open',
        priority: data.priority || 'medium',
        dueDate: dateOnly(data.dueDate),
        dueAt: data.dueAt == null
          ? null
          : (data.dueAt instanceof Date ? data.dueAt : new Date(data.dueAt)),
        endsAt: data.endsAt == null
          ? null
          : (data.endsAt instanceof Date ? data.endsAt : new Date(data.endsAt)),
        dueDateTimezone: data.dueDateTimeZone || null,
        allDay: data.allDay === true,
        source: data.source || 'app',
        practiceAreaId: isUuid(data.practiceAreaId) ? data.practiceAreaId : null,
        courtId: isUuid(data.courtId) ? data.courtId : null,
        createdBy: data.createdBy || null,
        recurrence: data.recurrence || null,
        reminderRecipientIds: data.reminderRecipientIds || [],
        sendReminderEarly: data.sendReminderEarly === true,
      };
      const rows = await scopedInsert(tasks, lawFirmId, cols, client);
      const id = rows[0].id;

      await setAttachments(lawFirmId, 'taskId', id, data.attachments,
        { createdBy: data.createdBy || null, executor: client });
      await syncAssignees(client, lawFirmId, id, data.assignedTo || []);
      await syncDependencies(client, lawFirmId, id, data.dependencies || []);
      // Manual clients only apply to firm-scoped tasks (matter-scoped derive from the matter).
      if (!cols.matterId) await syncTaskClients(client, lawFirmId, id, data.clientIds || []);
      if (writeRelated) await writeRelated(id, client);
      return id;
    }, executor);
    return oneById(lawFirmId, taskId, executor);
  }

  async updateTask(lawFirmId: string, taskId: string, updates: any, opts: any = {}) {
    if (!isUuid(taskId)) return null;
    await withDrizzleTransaction(async (client: any) => {
      const map = {
        title: 'title', description: 'description', location: 'location',
        status: 'status', priority: 'priority', dueDateTimeZone: 'dueDateTimezone',
        matterId: 'matterId', practiceAreaId: 'practiceAreaId', courtId: 'courtId',
        sendReminderEarly: 'sendReminderEarly', googleEventId: 'googleEventId', outlookId: 'outlookId',
        allDay: 'allDay',
      } satisfies Record<string, TaskColumn>;
      const values: TaskUpdate = {};
      for (const [field, col] of Object.entries(map)) {
        if (updates[field] !== undefined) {
          let v = updates[field];
          if ((col === 'matterId' || col === 'practiceAreaId' || col === 'courtId') && !isUuid(v)) v = null;
          setColumn<typeof tasks>(values, col, v);
        }
      }
      if (updates.dueDate !== undefined) values.dueDate = dateOnly(updates.dueDate);
      if (updates.dueAt !== undefined) {
        values.dueAt = updates.dueAt == null
          ? null
          : (updates.dueAt instanceof Date ? updates.dueAt : new Date(updates.dueAt));
      }
      if (updates.endsAt !== undefined) {
        values.endsAt = updates.endsAt == null
          ? null
          : (updates.endsAt instanceof Date ? updates.endsAt : new Date(updates.endsAt));
      }
      if (updates.recurrence !== undefined) values.recurrence = updates.recurrence || null;
      if (updates.reminderRecipientIds !== undefined) values.reminderRecipientIds = updates.reminderRecipientIds || [];

      if (Object.keys(values).length) await scopedUpdate(tasks, lawFirmId, eq(tasks.id, taskId), values, client);

      if (updates.attachments !== undefined) {
        await setAttachments(lawFirmId, 'taskId', taskId, updates.attachments,
          { createdBy: updates.editedBy || null, executor: client });
      }

      if (updates.assignedTo !== undefined) await syncAssignees(client, lawFirmId, taskId, updates.assignedTo || []);
      if (updates.dependencies !== undefined) await syncDependencies(client, lawFirmId, taskId, updates.dependencies || []);

      // Determine the effective matter scope after this update.
      let effectiveMatterId = updates.matterId;
      if (effectiveMatterId === undefined) {
        // Use the caller-supplied current scope (the service already loaded the
        // task) to avoid a redundant select; fall back to a query if absent.
        if (opts.currentMatterId !== undefined) {
          effectiveMatterId = opts.currentMatterId || null;
        } else {
          const current = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
            .select({ matterId: tasks.matterId }).from(tasks)
            .where(and(scope, eq(tasks.id, taskId))).limit(1), client);
          effectiveMatterId = current[0]?.matterId || null;
        }
      }
      if (updates.matterId !== undefined) {
        // Matter scope changed. task_clients is only meaningful for firm-scoped
        // tasks, so on a matter->firm transition we always rewrite the junction
        // to the supplied clientIds if present, otherwise to []. Instead of
        // silently leaving stale rows when clientIds is omitted.
        await syncTaskClients(client, lawFirmId, taskId, effectiveMatterId ? [] : (updates.clientIds || []));
      } else if (!effectiveMatterId && updates.clientIds !== undefined) {
        await syncTaskClients(client, lawFirmId, taskId, updates.clientIds || []);
      }
    });
    return oneById(lawFirmId, taskId);
  }

  async deleteTask(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return;
    await scopedDelete(tasks, lawFirmId, eq(tasks.id, taskId));
  }

  // ── calendar sync writebacks (relational; replaces the entityRef shim) ──────
  // Apply a normalized calendar-sync descriptor (from calendarAdapters) to the
  // tasks row: mutate the calendar_sync jsonb map + last_synced_to_* stamps via
  // real SQL, or set/clear a scalar provider-id column.
  async applyCalendarSync(lawFirmId: string, taskId: string, descriptor: any) {
    if (!isUuid(taskId)) return;
    await calendarSyncRepo.applyCalendarSyncDescriptor(
      'tasks',
      { sql: 'law_firm_id = $1 and id = $2', params: [lawFirmId, taskId] },
      descriptor,
      (field: string) => (isTaskSyncColumn(field) ? TASK_SYNC_COLUMNS[field] : null)
    );
  }

  /** Direct scalar writeback used by bulk-sync claim/clear paths. */
  async setSyncFields(lawFirmId: string, taskId: string, fields: any) {
    if (!isUuid(taskId)) return;
    const values: TaskUpdate = {};
    for (const [field, value] of Object.entries(fields)) {
      if (!isTaskSyncColumn(field)) continue;
      setColumn<typeof tasks>(values, field, value === undefined ? null : value);
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(tasks, lawFirmId, eq(tasks.id, taskId), values);
  }

  /** Stamp last_synced_to_<provider> = now() (touch). */
  async touchProviderSync(lawFirmId: string, taskId: string, provider: any) {
    if (!isUuid(taskId)) return;
    const values = provider === 'google'
      ? { lastSyncedToGoogle: sql`now()` }
      : { lastSyncedToOutlook: sql`now()` };
    await scopedUpdate(tasks, lawFirmId, eq(tasks.id, taskId), values);
  }

  /** Raw calendar-state read for the engine (per-user calendarSync map + columns). */
  async getCalendarState(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return null;
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select().from(tasks).where(and(scope, eq(tasks.id, taskId))).limit(1));
    const r = rows[0];
    if (!r) return null;
    const dueAt = taskDueInstant(r);
    const assignees = await tenantQuery(taskAssignees, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: taskAssignees.userId }).from(taskAssignees)
      .where(and(scope, eq(taskAssignees.taskId, taskId))));
    // The clients a matter-less task names, which its calendar description
    // lists. A matter task lists the matter's clients instead.
    const clients = r.matterId ? [] : await tenantQuery(taskClients, lawFirmId, ({ executor, scope }) => executor
      .select({ clientId: taskClients.clientId }).from(taskClients)
      .where(and(scope, eq(taskClients.taskId, taskId)))
      .orderBy(asc(taskClients.createdAt), asc(taskClients.clientId)));
    return {
      id: r.id,
      taskId: r.id,
      lawFirmId,
      status: r.status,
      matterId: r.matterId,
      assignedTo: assignees.map((row) => row.userId),
      clientIds: clients.map((row) => row.clientId),
      location: r.location ?? null,
      dueAt: r.dueAt,
      endsAt: r.endsAt ?? null,
      title: r.title ?? null,
      description: r.description ?? null,
      createdBy: r.createdBy ?? null,
      calendarSync: r.calendarSync || {},
      googleEventId: r.googleEventId ?? null,
      outlookId: r.outlookId ?? null,
      outlookChangeKey: r.outlookChangeKey ?? null,
      googleCalendarId: r.googleCalendarId ?? null,
      dueDate: dueAt,
      dueDateTimeZone: r.dueDateTimezone ?? null,
      allDay: r.allDay || false,
      source: r.source ?? null,
      lastSyncedToGoogle: r.lastSyncedToGoogle ?? null,
      lastSyncedToOutlook: r.lastSyncedToOutlook ?? null,
      googleLastModified: r.googleLastModified ?? null,
      outlookLastModified: r.outlookLastModified ?? null,
      updatedAt: r.updatedAt ?? null,
    };
  }

  /** Inbound webhook update of task fields from a provider event. */
  async applyInboundUpdate(lawFirmId: string, taskId: string, fields: any) {
    if (!isUuid(taskId)) return;
    // Inbound field -> column, so the one name that differs (`dueDateTimeZone`
    // arrives capitalised, the column is `dueDateTimezone`) is declared here
    // rather than special-cased inside the loop.
    const allowed = {
      title: 'title', description: 'description', dueDateTimeZone: 'dueDateTimezone',
      allDay: 'allDay', googleLastModified: 'googleLastModified',
      outlookLastModified: 'outlookLastModified', outlookChangeKey: 'outlookChangeKey',
      outlookId: 'outlookId', googleEventId: 'googleEventId',
    } satisfies Record<string, TaskColumn>;
    const values: TaskUpdate = {};
    for (const [field, column] of Object.entries(allowed)) {
      if (fields[field] === undefined) continue;
      const isTimestamp = field === 'googleLastModified' || field === 'outlookLastModified';
      setColumn<typeof tasks>(
        values,
        column,
        isTimestamp && fields[field] != null ? new Date(fields[field]) : fields[field],
      );
    }
    if (fields.endsAt !== undefined) {
      values.endsAt = fields.endsAt == null ? null : (fields.endsAt instanceof Date ? fields.endsAt : new Date(fields.endsAt));
    }
    if (fields.dueDate !== undefined) {
      const d = fields.dueDate == null ? null : (fields.dueDate instanceof Date ? fields.dueDate : new Date(fields.dueDate));
      // An all-day task has a day and no time, so `due_at` stays null, as
      // `resolveDue` stores it for one saved in Paralegix. The provider's
      // all-day start arrives as the day's noon anchor, which is not a time.
      values.dueAt = fields.allDay === true ? null : d;
      // due_date is a day-only column keyed on by upcoming/overdue/dashboard
      // queries. Derive it as the LOCAL calendar day in the event's timezone so
      // an event whose local day differs from its UTC day lands on the right
      // day; falls back to the UTC day when no timezone is present.
      values.dueDate = d ? zonedDayString(d, fields.allDay === true ? 'UTC' : fields.dueDateTimeZone) : null;
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(tasks, lawFirmId, eq(tasks.id, taskId), values);
  }

  async batchDelete(lawFirmId: string, taskIds: string[]) {
    const ids = (taskIds || []).filter(isUuid);
    if (!ids.length) return;
    await scopedDelete(tasks, lawFirmId, inArray(tasks.id, ids));
  }

  /** Batched hydrated lookup by id set (preserves no particular order). */
  async findByIds(lawFirmId: string, taskIds: string[]) {
    const ids = (taskIds || []).filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await tenantParameterizedQuery(
      tasks, lawFirmId, `${TASK_SELECT} where t.law_firm_id = $1 and t.id = any($2)`,
      [lawFirmId, ids], 't',
    );
    return rows.map(hydrate);
  }

  /**
   * Like findByIds but additionally enforces per-matter visibility: only returns
   * tasks the user can see (firm-level tasks, or matter tasks where the user is a
   * matter member). Used where ids come from a linked-task graph (dependencies),
   * so following an edge can't leak a matter the user isn't a member of.
   */
  async findByIdsVisibleToUser(lawFirmId: string, taskIds: string[], userId: string) {
    const ids = (taskIds || []).filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `${TASK_SELECT} where t.law_firm_id = $1 and t.id = any($2)
         and (t.matter_id is null or exists (select 1 from matter_members cm where cm.matter_id = t.matter_id and cm.user_id = $3))`,
      [lawFirmId, ids, userId],
      't',
    );
    return rows.map(hydrate);
  }

  /** { docs: [{ id, data }], errors } */
  async fetchTasksForFirm(lawFirmId: string, taskIds: string[]) {
    const errors: Record<string, any> = {};
    const ids = [];
    for (const id of taskIds || []) {
      if (isUuid(id)) ids.push(id);
      else errors[id] = 'Task not found';
    }
    if (!ids.length) return { docs: [], errors };
    const { rows } = await tenantParameterizedQuery(
      tasks, lawFirmId, `${TASK_SELECT} where t.law_firm_id = $1 and t.id = any($2)`,
      [lawFirmId, ids], 't',
    );
    const found = new Map(rows.map((r: any) => [r.id, hydrate(r)]));
    ids.forEach((id) => { if (!found.has(id)) errors[id] = 'Task not found'; });
    return { docs: [...found.values()].map((d: any) => ({ id: d.id, data: d })), errors };
  }

  async batchUpdateStatus(lawFirmId: string, taskIds: string[], status: any) {
    const ids = (taskIds || []).filter(isUuid);
    if (!ids.length) return;
    await scopedUpdate(tasks, lawFirmId, inArray(tasks.id, ids), { status });
  }

  async batchUpdateMatter(lawFirmId: string, taskIds: string[], matterId: string) {
    const ids = (taskIds || []).filter(isUuid);
    if (!ids.length) return;
    const cid = isUuid(matterId) ? matterId : null;
    await withDrizzleTransaction(async (transaction) => {
      await scopedUpdate(tasks, lawFirmId, inArray(tasks.id, ids), { matterId: cid }, transaction);
      // Matter-scoped tasks derive clients from the matter; clear any manual task_clients.
      if (cid) {
        await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor.delete(taskClients)
          .where(inArray(
            taskClients.taskId,
            executor.select({ id: tasks.id }).from(tasks).where(and(scope, inArray(tasks.id, ids))),
          )), transaction);
      }
    });
  }

  /** How many notes a task has, for the notes tab badge. */
  async countTaskNotes(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return 0;
    const rows = await tenantQuery(notes, lawFirmId, ({ executor, scope }) => executor
      .select({ total: sql<number>`count(*)` }).from(notes)
      .where(and(scope, eq(notes.taskId, taskId))));
    return Number(rows[0].total) || 0;
  }

}

// ── junction sync helpers (replace-set semantics) ───────────────────
async function syncAssignees(client: any, lawFirmId: string, taskId: string, userIds: string[]) {
  const ownerRows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
    .select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))).limit(1), client);
  if (!ownerRows.length) return;
  await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor.delete(taskAssignees)
    .where(inArray(
      taskAssignees.taskId,
      executor.select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))),
    )), client);
  const ids = [...new Set<string>((userIds || []).filter(Boolean) as string[])];
  if (!ids.length) return;
  // Only assign users who are members of the task's firm. The task_assignees FK is
  // not firm-scoped, so join through the task's law_firm_id (mirroring
  // syncTaskClients) to prevent persisting an assignment — and its notification
  // fan-out — to a user outside this firm.
  const validMembers = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: members.userId }).from(members)
    .where(and(scope, inArray(members.userId, ids))), client);
  if (!validMembers.length) return;
  await client.insert(taskAssignees)
    .values(validMembers.map((member) => ({ lawFirmId, taskId, userId: member.userId })))
    .onConflictDoNothing();
}

async function syncDependencies(client: any, lawFirmId: string, taskId: string, depIds: any) {
  const ownerRows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
    .select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))).limit(1), client);
  if (!ownerRows.length) return;
  const ids = [...new Set<string>((depIds || []).filter((d: any) => isUuid(d) && d !== taskId))];
  const validDependencies = ids.length
    ? await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ id: tasks.id }).from(tasks).where(and(scope, inArray(tasks.id, ids))), client)
    : [];
  const validIds = validDependencies.map((task) => task.id);
  // Acyclicity guard: a cycle is created if any proposed dependency can reach
  // `taskId` through the existing graph. Traverse from the proposed deps, but
  // ignore edges originating at `taskId` itself (those are being replaced by
  // this write). If `taskId` is reachable, adding the edge closes a loop.
  if (validIds.length) {
    const { rows } = await tenantParameterizedQuery(tasks, lawFirmId,
      `with recursive reachable as (
         select dt.id from tasks dt where dt.law_firm_id = $1 and dt.id = any($3::uuid[])
         union
         select td.depends_on_task_id
           from task_dependencies td join reachable r on td.task_id = r.id
          where td.task_id <> $2
       )
       select 1 from reachable where id = $2 limit 1`,
      [lawFirmId, taskId, validIds],
      'dt',
      client,
    );
    if (rows.length) {
      throw new ValidationError('Dependency would create a cycle');
    }
  }
  await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor.delete(taskDependencies)
    .where(inArray(
      taskDependencies.taskId,
      executor.select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))),
    )), client);
  if (!validIds.length) return;
  // Only depend on tasks in the SAME firm. The depends_on_task_id FK is global
  // (references tasks(id), not a firm-scoped key), so join through the task's
  // law_firm_id (like syncTaskClients) to reject a cross-tenant edge. This also
  // removes the existence oracle: a foreign id simply matches no row and is
  // dropped, instead of raising an FK error that reveals whether the uuid exists.
  // The self-edge guard is preserved by the id filter above plus the DB check.
  await client.insert(taskDependencies)
    .values(validIds.map((dependsOnTaskId) => ({ lawFirmId, taskId, dependsOnTaskId })))
    .onConflictDoNothing();
}

async function syncTaskClients(client: any, lawFirmId: string, taskId: string, clientIds: string[]) {
  const ownerRows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
    .select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))).limit(1), client);
  if (!ownerRows.length) return;
  await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor.delete(taskClients)
    .where(inArray(
      taskClients.taskId,
      executor.select({ id: tasks.id }).from(tasks).where(and(scope, eq(tasks.id, taskId))),
    )), client);
  const ids = [...new Set<string>((clientIds || []).filter(isUuid) as string[])];
  if (!ids.length) return;
  // Only link client ids that actually belong to the task's firm. The task_clients
  // FK is not firm-scoped, so joining through the task's law_firm_id here prevents
  // persisting a link to another firm's client id.
  const validClients = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clients.id }).from(clients).where(and(scope, inArray(clients.id, ids))), client);
  if (!validClients.length) return;
  await client.insert(taskClients)
    .values(validClients.map((clientRow) => ({ lawFirmId, taskId, clientId: clientRow.id })))
    .onConflictDoNothing();
}

const tasksRepository = new TasksRepository();
// Expose the default cap so callers (e.g. the dashboard) can reference the same
// constant rather than re-declaring the number and drifting from the repo.
export = Object.assign(tasksRepository, { UPCOMING_TASKS_DEFAULT_LIMIT });
