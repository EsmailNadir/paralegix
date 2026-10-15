import { and, eq, inArray, isNotNull, or, sql, isNull} from 'drizzle-orm';
import {
  clientCompanyLinks,
  notes,
  clients,
  contactClients,
  conversations,
  invitations,
  invoices,
  matterClients,
  matters,
  taskClients,
  tasks,
  users,
  legalHolds,
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
} from '../../shared/database/scopedWrite';

import { DrizzleRepository } from '../../shared/database/DrizzleRepository';

import { sqlRowToEntity } from '../../shared/database/rowShape';

const { isUuid } = require('../../shared/utils/isUuid');
const clientEventsRepo = require('./clientEvents.repository');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const { clampLimit, buildOrderBy, buildPageClause, resolveWindowTotal } = require('../../shared/database/pagination');

class ClientsRepository extends DrizzleRepository {
  /**
   * Is this client under a live legal hold?
   *
   * A released hold row is kept as the record of what was held and when
   * (migration 0221), so only an unreleased one blocks a delete.
   */
  async hasLiveLegalHold(lawFirmId: string, clientId: string) {
    if (!isUuid(clientId)) return false;
    const rows = await tenantQuery(legalHolds, lawFirmId, ({ executor, scope }) => executor
      .select({ id: legalHolds.id }).from(legalHolds)
      .where(and(scope, eq(legalHolds.clientId, clientId), isNull(legalHolds.releasedAt)))
      .limit(1));
    return rows.length > 0;
  }

  constructor() {
    // `DrizzleRepository` takes the table OBJECT, so the column mapping and the
    // jsonb handling come from the schema rather than from a `{ jsonb: [] }`
    // option and a snake_case guess. The two custom reads below assemble their
    // own raw rows and shape them with `rowToEntity`, which is the case
    // conversion the old base class applied to everything.
    super(clients as any);
  }

  async findByIdRaw(lawFirmId: string, clientId: string, executor?: DrizzleExecutor) {
    return this.findById(lawFirmId, clientId, executor);
  }

  async findByEmail(lawFirmId: string, email: any) {
    // `email` is a citext column (case-insensitive collation), so a plain `= $2`
    // comparison matches regardless of matter and stays index-usable. No need to
    // pre-lowercase (which is redundant against citext).
    //
    // Person rows only. This serves the portal's person-arm self-heal, and a
    // company holds its contact address in the same column: an unfiltered
    // `limit 1` could return the organization instead of the person placeholder
    // that is actually being looked for.
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select().from(clients)
      .where(and(scope, eq(clients.email, email), eq(clients.clientType, 'person')))
      .limit(1));
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  async findByUserId(lawFirmId: string, userId: string) {
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select().from(clients).where(and(scope, eq(clients.userId, userId))).limit(1));
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  listClients(lawFirmId: string) {
    return this.findAll(lawFirmId);
  }

  /**
   * Resolve multiple clients by id in ONE query (`id = any($2)`), replacing the
   * frontend per-id GET fan-out. Returns full client entities (same columns as
   * findById) in arbitrary order; malformed/foreign ids simply don't match.
   *
   * Linked-user name/email are folded in via `LEFT JOIN users` so the service no
   * longer issues a second `users` round-trip just to backfill missing fields.
   * The joined values surface as `user_name` / `user_email` (only consulted when
   * the client row's own name/email is null).
   */
  async findByIdsRaw(lawFirmId: string, clientIds: string[]) {
    const ids = (clientIds || []).filter(isUuid);
    if (!ids.length) return [];
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select({ client: clients, userName: users.name, userEmail: users.email })
      .from(clients).leftJoin(users, eq(users.id, clients.userId))
      .where(and(scope, inArray(clients.id, ids))));
    return rows.map((row: any) => {
      const entity: any = this.toEntity(row.client);
      entity.userName = row.userName || null;
      entity.userEmail = row.userEmail || null;
      return entity;
    });
  }

  /**
   * The enriched client the list read returns, resolved for a specific set of
   * ids: every client column, `matterIds` aggregated from the `matter_clients`
   * junction, and the linked portal user's name/email as `userName`/`userEmail`.
   *
   * `taskCount` is deliberately absent. It is a per-row count over `tasks` that
   * only the clients grid displays, and the id-resolution callers of this method
   * pay for it on every keystroke without ever showing it.
   */
  async findByIdsEnriched(lawFirmId: string, clientIds: string[]) {
    const ids = (clientIds || []).filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await tenantParameterizedQuery(clients, lawFirmId,
      `select c.*,
              coalesce(cc.matter_ids, '{}') as matter_ids,
              u.name as user_name, u.email as user_email
         from clients c
         left join users u on u.id = c.user_id
         left join lateral (
           select array_agg(matter_id) as matter_ids
             from matter_clients
            where law_firm_id = c.law_firm_id and client_id = c.id
         ) cc on true
        where c.law_firm_id = $1 and c.id = any($2::uuid[])`,
      [lawFirmId, ids],
      'c',
    );
    return rows.map((r: any) => {
      const { matter_ids: matterIds, user_name: userName, user_email: userEmail, ...rest } = r;
      const entity: any = sqlRowToEntity(rest);
      entity.matterIds = (matterIds || []).filter(Boolean);
      entity.userName = userName || null;
      entity.userEmail = userEmail || null;
      return entity;
    });
  }

  /**
   * The single enriched clients-list read: optional filters, free-text
   * search, sorting, and optional windowing, all pushed into SQL. Each client
   * carries its associated `matterIds`, aggregated from the `matter_clients`
   * junction by a lateral subquery (no N+1; empty array when a client has no
   * matters), a `taskCount` of the tasks on those matters, plus the linked portal
   * user's name/email surfaced as `userName` / `userEmail` so the service needs no
   * second `users` round-trip.
   *
   * FILTERS. `matterId` narrows to the clients linked to that matter through
   * `matter_clients`, `status` to one client status, and `portalOnly` to those
   * with a portal account attached. They are additive and all optional, so
   * callers passing none see the whole firm.
   *
   * VISIBILITY. Clients carry no ethical wall: `clients.view` alone gates them,
   * so every client of the firm is in scope. There is deliberately no
   * membership predicate here (unlike the matters list).
   *
   * SHAPE. The query is page-then-enrich, and that ordering is the whole point:
   *
   *   with page as (select c.id, count(*) over() from clients c where ... limit ...)
   *   select <enriched columns> from page p join clients c on c.id = p.id <joins>
   *
   * `count(*) over()` is a window function, so Postgres must materialize every
   * matching row before LIMIT applies. Putting that window anywhere in the
   * enriched select therefore runs the `matter_ids` lateral aggregate once per
   * MATCHING row (thousands) to display one page (tens). That is a property of
   * windowing over an enriched select, not of where the count column sits in the
   * select list. The only fix is to compute the count somewhere the enrichment is
   * absent, hence the CTE over the bare `clients` table, which keeps the count
   * exact while the aggregate joins only the ids that survived the window.
   *
   * `page` must also LEAD the FROM. Appending `join page p on p.id = c.id` after
   * the existing join chain is valid SQL and looks equivalent, but it lets the
   * planner pick a merge join that enriches the full match set anyway.
   *
   * The CTE carries its own `left join users u` because the search predicate
   * reaches into the linked portal user's name and email; a client created from
   * an invite may have neither of its own.
   *
   * WINDOWING. Optional and off by default: with `limit` null the LIMIT/OFFSET
   * clause is omitted and every client comes back (the unpaginated list contract
   * the firm-side grid and the portal-client pickers depend on), with
   * `totalItems` still exact. `offset` wins over `page` when both are supplied.
   *
   * SORTING. `sort` is an ordered array of `{ field, dir }` over the SORT_COLUMNS
   * whitelist; unknown fields are skipped. It falls back to the single
   * `sortBy`/`order`, then to `createdAt desc`. `c.id asc` is always appended as a
   * stable tiebreaker so paging over equal sort keys is deterministic. The same
   * ORDER BY is applied inside the CTE (to choose the page) and again outside (the
   * join does not preserve CTE order); every expression resolves against `c` in
   * both positions.
   *
   * @returns {Promise<{ clients: object[], totalItems: number }>}
   */
  async listClientsPaged(lawFirmId: string, {
    portalOnly = false,
    matterId,
    status,
    clientType,
    page = 1,
    limit = null,
    offset = null,
    search,
    sort,
    sortBy = 'createdAt',
    order = 'desc',
  }: any = {}) {
    const where = ['c.law_firm_id = $1'];
    const params: unknown[] = [lawFirmId];

    if (portalOnly) where.push('c.user_id is not null');

    if (status) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }

    if (clientType === 'person' || clientType === 'company') {
      params.push(clientType);
      where.push(`c.client_type = $${params.length}`);
    }

    // The clients linked to one matter. A malformed id yields an empty result
    // rather than a cast error: answering "this matter's clients" with the whole
    // firm would be worse than answering with nothing.
    if (matterId !== undefined && matterId !== null && matterId !== '') {
      if (!isUuid(matterId)) return { clients: [], totalItems: 0 };
      params.push(matterId);
      where.push(`exists (select 1 from matter_clients mc
                           where mc.law_firm_id = c.law_firm_id
                             and mc.client_id = c.id
                             and mc.matter_id = $${params.length})`);
    }

    // Free-text search over the client's own text columns, the linked portal
    // user's name/email, and, for a company client, its roster contacts'
    // names. Parameterized ILIKE with an escaped term, so a user typing `%`
    // searches for a literal percent sign instead of matching everything.
    // `clients.email` and `users.email` are citext, which has no ilike
    // operator of its own, so both are cast to text first.
    const term = toIlikeTerm(search);
    if (term) {
      params.push(term);
      const p = params.length;
      // A UNION of index-friendly arms rather than one OR across the joined
      // tables. An OR that reaches another table cannot use an index on either
      // side — Postgres has to form the join and filter afterwards — so the
      // trigram indexes were useless in the original shape. Each arm here
      // carries its predicate against a single table, so each one seeks its own
      // index, and UNION dedupes. Same rows, measured 10.8ms -> 1.4ms at 60k
      // clients; see migration 0141's header for the full benchmark.
      //
      // The roster arm resolves a matching CONTACT back to its company's own
      // `clients.id` (never a separate row), so a contact-name match still
      // surfaces exactly one row in the paginated list, the company, not a
      // duplicate per contact.
      where.push(`c.id in (
                     select id from clients where law_firm_id = $1 and name ilike $${p} escape '\\'
               union select id from clients where law_firm_id = $1 and email::text ilike $${p} escape '\\'
               union select id from clients where law_firm_id = $1 and organization ilike $${p} escape '\\'
               union select c2.id from clients c2 join users u2 on u2.id = c2.user_id
                      where c2.law_firm_id = $1 and u2.name ilike $${p} escape '\\'
               union select c3.id from clients c3 join users u3 on u3.id = c3.user_id
                      where c3.law_firm_id = $1 and u3.email::text ilike $${p} escape '\\'
               union select cc.client_id as id from contact_clients cc
                      join contacts ct on ct.id = cc.contact_id and ct.law_firm_id = cc.law_firm_id
                      where cc.law_firm_id = $1 and ct.name ilike $${p} escape '\\'
                   )`);
    }
    const whereSql = where.join(' and ');

    // Whitelist sortable fields -> real ORDER BY expressions. Caller input is only
    // ever used as a key into this map, never interpolated.
    const SORT_COLUMNS = {
      name: 'c.name',
      email: 'c.email',
      organization: 'c.organization',
      createdAt: 'c.created_at',
    };
    const orderSql = buildOrderBy({
      sort, sortBy, order,
      columns: SORT_COLUMNS,
      fallback: { field: 'createdAt', dir: 'desc' },
      tiebreaker: 'c.id asc',
    });

    // Snapshot the filter params before the paging params are appended, so the
    // out-of-range count below can reuse `whereSql` with identical $N numbering.
    const filterParams = params.slice();
    // `max` matches the ceiling the list endpoint's schema accepts, so a request
    // at that ceiling is served in full rather than silently truncated.
    const { pageClause, pageOffset } = buildPageClause({
      limit, offset, page, params, max: 500, optional: true,
    });

    const { rows } = await tenantParameterizedQuery(clients, lawFirmId,
      `with page as (
         select c.id, count(*) over() as total_count
           from clients c
           left join users u on u.id = c.user_id
          where ${whereSql}
          order by ${orderSql}${pageClause}
       )
       select c.*,
              coalesce(cc.matter_ids, '{}') as matter_ids,
              coalesce(tc.task_count, 0) as task_count,
              coalesce(rc.contact_count, 0) as contact_count,
              coalesce(cr.company_names, '{}') as company_names,
              u.name as user_name, u.email as user_email,
              p.total_count
         from page p
         join clients c on c.id = p.id and c.law_firm_id = $1
         left join users u on u.id = c.user_id
         left join lateral (
           select array_agg(matter_id) as matter_ids
             from matter_clients
            where law_firm_id = c.law_firm_id and client_id = c.id
         ) cc on true
         -- Tasks belonging to any of this client's matters. Sits in the OUTER
         -- select so it runs once per RETURNED row rather than once per match,
         -- the same reason the matter_ids aggregate lives here.
         left join lateral (
           select count(*)::int as task_count
             from tasks t
            where t.law_firm_id = c.law_firm_id
              and t.matter_id is not null
              and exists (select 1 from matter_clients mc
                           where mc.law_firm_id = c.law_firm_id
                             and mc.client_id = c.id
                             and mc.matter_id = t.matter_id)
         ) tc on true
         -- Roster contact count (client_company_links migration 0174):
         -- meaningful for a company client, whose people are linked Person
         -- clients rather than a single linked user. Same "runs once per
         -- returned row" reasoning.
         left join lateral (
           select count(*)::int as contact_count
             from client_company_links
            where law_firm_id = c.law_firm_id and company_client_id = c.id
         ) rc on true
         -- A Person client's company memberships are link records, not the
         -- free-text organization field. Include their display names so the
         -- firm list can identify linked people without extra requests.
         left join lateral (
           select array_agg(company.name order by company.name) as company_names
             from client_company_links link
             join clients company on company.id = link.company_client_id
                                and company.law_firm_id = link.law_firm_id
            where link.law_firm_id = c.law_firm_id
              and link.person_client_id = c.id
         ) cr on true
        order by ${orderSql}`,
      params,
      'c',
    );

    const clientEntities = rows.map((r: any) => {
      const {
        matter_ids: matterIds, task_count: taskCount, contact_count: contactCount, company_names: companyNames,
        user_name: userName, user_email: userEmail, ...rest
      } = r;
      // The window count rides on every row but is not a client field; drop it so
      // the entity shape matches the un-windowed read exactly.
      delete rest.total_count;
      const entity: any = sqlRowToEntity(rest);
      entity.matterIds = (matterIds || []).filter(Boolean);
      entity.taskCount = Number(taskCount) || 0;
      entity.contactCount = Number(contactCount) || 0;
      entity.companyNames = (companyNames || []).filter(Boolean);
      entity.userName = userName || null;
      entity.userEmail = userEmail || null;
      return entity;
    });

    // The `users` join is repeated in the fallback count because the search
    // predicate reaches into the linked portal user.
    const totalItems = await resolveWindowTotal({
      rows,
      pageOffset,
      countSql: `select count(*)::int as total
                   from clients c
                   left join users u on u.id = c.user_id
                  where ${whereSql}`,
      filterParams,
      countQuery: async () => {
        const result = await tenantParameterizedQuery(
          clients,
          lawFirmId,
          `select count(*)::int as total
             from clients c
             left join users u on u.id = c.user_id
            where ${whereSql}`,
          filterParams,
          'c',
        );
        return result.rows;
      },
    });

    return { clients: clientEntities, totalItems };
  }

  /**
   * Store the Stripe Customer id on a client, keyed by its `clients.id` uuid.
   * One Firebase uid can own several client rows in a firm, so the uuid is the
   * only unambiguous key. No-op when no client row matches that id.
   */
  async setStripeCustomerIdById(lawFirmId: string, clientId: string, stripeCustomerId: any) {
    if (!isUuid(clientId)) return;
    await scopedUpdate(clients, lawFirmId, eq(clients.id, clientId), { stripeCustomerId });
  }

  async listPortalClients(lawFirmId: string) {
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select().from(clients).where(and(scope, isNotNull(clients.userId))));
    return rows.map((r: any) => this.toEntity(r));
  }

  /**
   * Slim typeahead source for client pickers. Searches name, email, and
   * organization, and falls back to the linked portal user's name/email for
   * clients created from an invite whose own name was never filled in.
   *
   * `matterId` narrows the result to the clients linked to that matter via
   * `matter_clients`, for pickers whose choice must stay inside one matter (a
   * firm-wide list there would let a document or billing record be attributed to
   * a client with no connection to the matter). It is an ADDITIONAL predicate,
   * ANDed with everything else.
   *
   * `excludeArchived` drops clients whose status is 'archived' from the browsable
   * result. Archived means "no longer transacted with", so pickers that attach a
   * client to new work (trust deposits and withdrawals, minimum-balance rules,
   * deposit requests) must not offer them. It excludes ONLY 'archived': 'inactive'
   * clients stay selectable, matching the `status !== 'archived'` filter those
   * screens applied client-side before this existed.
   *
   * It deliberately does NOT apply in either resolution mode. Those modes exist
   * to label a selection that is already saved, and a record written before the
   * client was archived still has to render its client's name rather than a
   * blank. Callers that need to tell the two apart can read `status`, which every
   * slim row carries.
   *
   * `userIds` is the second spelling of that resolution mode, keyed on the linked
   * portal account's Firebase UID instead of the `clients` row id. Some pickers
   * select a PERSON rather than a client record (a messaging participant is
   * addressed by UID, and that UID is what the conversation stores), so a
   * selection they already hold cannot be resolved through `ids` at all. The two
   * are mutually exclusive; the route rejects a request carrying both.
   *
   * `full` swaps the slim row for the enriched client, for the one picker that
   * feeds its selection into template placeholder auto-fill and needs the whole
   * record (phone, address, organization, preferred contact method, status)
   * rather than a label. The enrichment runs as a second pass over ONLY the ids
   * the slim query already returned, so it cannot reach a client the filters
   * excluded. Enriched items keep `label`/`sublabel` alongside the client fields
   * so the same picker component renders either shape.
   *
   * Fetches limit+1 rows so the caller can report `hasMore` without a count.
   */
  async lookupClients(lawFirmId: string, {
    search, exactName, exactOrganization, excludeId, ids, userIds, portalOnly = false, matterId, clientType, excludeArchived = false, excludeLinkedToClientId, limit = 20, full = false,
  }: any = {}) {
    const where = [`c.law_firm_id = $1`];
    const params: unknown[] = [lawFirmId];

    if (portalOnly) where.push(`c.user_id is not null`);

    if (clientType === 'person' || clientType === 'company') {
      params.push(clientType);
      where.push(`c.client_type = $${params.length}`);
    }

    if (excludeId && isUuid(excludeId)) {
      params.push(excludeId);
      where.push(`c.id <> $${params.length}`);
    }

    if (matterId !== undefined && matterId !== null && matterId !== '') {
      // A scoped request whose scope cannot be resolved must return nothing.
      // Ignoring an unusable matterId would answer "this matter's clients" with
      // the firm's entire client roster.
      if (!isUuid(matterId)) return { items: [], hasMore: false };
      params.push(matterId);
      where.push(`exists (select 1 from matter_clients mc
                           where mc.client_id = c.id
                             and mc.law_firm_id = c.law_firm_id
                             and mc.matter_id = $${params.length})`);
    }

    const wantsIdResolution = Array.isArray(ids) && ids.length > 0;
    const wantsUserIdResolution = !wantsIdResolution && Array.isArray(userIds) && userIds.length > 0;
    if (wantsIdResolution) {
      // An id-resolution request that matches nothing must return nothing,
      // never a fallback list, or a picker would mislabel a stale selection.
      const idList = ids.filter(isUuid);
      if (!idList.length) return { items: [], hasMore: false };
      params.push(idList);
      where.push(`c.id = any($${params.length}::uuid[])`);
    } else if (wantsUserIdResolution) {
      // Firebase UIDs are opaque text, not uuids, so they are screened only for
      // emptiness. Passing them through isUuid would discard every one of them
      // and turn every resolution request into an empty result.
      //
      // Same contract as the `ids` branch: nothing resolvable means an empty
      // result, never a fall-through to the browse branch, which would answer
      // "label these specific people" with a page of unrelated ones.
      const uidList = userIds.filter((u) => typeof u === 'string' && u.trim() !== '');
      if (!uidList.length) return { items: [], hasMore: false };
      params.push(uidList);
      where.push(`c.user_id = any($${params.length}::text[])`);
    } else if (typeof exactName === 'string' && exactName.trim()) {
      params.push(exactName.trim());
      where.push(`lower(btrim(coalesce(nullif(btrim(c.name), ''), (select u4.name from users u4 where u4.id = c.user_id)))) = lower($${params.length})`);
    } else if (typeof exactOrganization === 'string' && exactOrganization.trim()) {
      // Powers the "colleagues at this organization" link on the client detail
      // page. Uses clients_firm_lower_org_idx (schema.sql), the same index the
      // conflict-of-interest check relies on.
      params.push(exactOrganization.trim());
      where.push(`lower(btrim(c.organization)) = lower($${params.length})`);
    } else {
      // Scoped to the browse/search branch: see the note on `excludeArchived`
      // above for why an id-resolution request keeps archived clients.
      // `is distinct from` rather than `<>` so a legacy row with a null status is
      // treated as not-archived instead of dropping out of every picker.
      if (excludeArchived) where.push(`c.status is distinct from 'archived'`);

      // Drops person clients already linked to this company, for the "add an
      // existing client" picker on a company's Related Clients tab, so it
      // cannot offer a duplicate the link endpoint would then reject. A
      // malformed value is ignored rather than emptying the whole browse
      // result (unlike `matterId`): this is a courtesy narrowing, not a scope
      // the request depends on to mean anything.
      if (excludeLinkedToClientId && isUuid(excludeLinkedToClientId)) {
        params.push(excludeLinkedToClientId);
        where.push(`not exists (select 1 from client_company_links l
                                  where l.law_firm_id = $1
                                    and l.company_client_id = $${params.length}
                                    and l.person_client_id = c.id)`);
      }

      const term = toIlikeTerm(search);
      if (term) {
        params.push(term);
        const p = params.length;
        // `email` is citext, so it is cast to text before ILIKE (citext has no
        // ilike operator of its own).
      // A UNION of index-friendly arms rather than one OR across the users
        // join. An OR that reaches another table cannot use an index on either
        // side — Postgres has to form the join and filter afterwards — so the
        // trigram indexes were useless in the original shape. Each arm here
        // carries its predicate against a single table, so each one seeks its own
        // index, and UNION dedupes. Same rows, measured 10.8ms -> 1.4ms at 60k
        // clients; see migration 0141's header for the full benchmark.
        where.push(`c.id in (
                       select id from clients where law_firm_id = $1 and name ilike $${p} escape '\\'
                 union select id from clients where law_firm_id = $1 and email::text ilike $${p} escape '\\'
                 union select id from clients where law_firm_id = $1 and organization ilike $${p} escape '\\'
                 union select c2.id from clients c2 join users u2 on u2.id = c2.user_id
                        where c2.law_firm_id = $1 and u2.name ilike $${p} escape '\\'
                 union select c3.id from clients c3 join users u3 on u3.id = c3.user_id
                        where c3.law_firm_id = $1 and u3.email::text ilike $${p} escape '\\'
                     )`);
      }
    }

    const lim = clampLimit(limit, { fallback: 20, max: 200 });
    params.push(lim + 1);

    const { rows } = await tenantParameterizedQuery(clients, lawFirmId,
      `select c.id, c.name, c.email, c.organization, c.status, c.user_id, c.client_type,
              u.name as user_name, u.email as user_email,
              coalesce(rc.contact_count, 0) as contact_count
         from clients c
         left join users u on u.id = c.user_id
         -- Roster contact count (client_company_links migration 0174):
         -- meaningful for a company client, whose people are linked Person
         -- clients rather than a single linked user. Cheap per-row lateral
         -- over the already-limited page, same as the list endpoint's
         -- equivalent join.
         left join lateral (
           select count(*)::int as contact_count
             from client_company_links
            where law_firm_id = c.law_firm_id and company_client_id = c.id
         ) rc on true
        where ${where.join(' and ')}
        order by coalesce(c.name, u.name) asc nulls last, c.created_at desc
        limit $${params.length}`,
      params,
      'c',
    );

    const hasMore = rows.length > lim;
    const pageRows = rows.slice(0, lim);

    const labelsFor = (r: any) => {
      const name = r.name || r.user_name || null;
      const email = r.email || r.user_email || null;
      return {
        label: name || email || 'Client',
        sublabel: r.organization || (name ? email : null),
      };
    };

    if (full) {
      const enriched = await this.findByIdsEnriched(lawFirmId, pageRows.map((r: any) => r.id));
      const byId = new Map(enriched.map((client: any) => [client.id, client]));
      return {
        items: pageRows
          .map((r: any) => {
            const client = byId.get(r.id);
            if (!client) return null;
            return { ...client, ...labelsFor(r) };
          })
          .filter(Boolean),
        hasMore,
      };
    }

    // `status` rides along so a picker can mark a resolved-by-id selection that
    // has since been archived, which `excludeArchived` deliberately still returns.
    //
    // `userId` is the linked portal user's Firebase UID (null for a client with no
    // portal account). Pickers whose value must identify the PERSON rather than the
    // client record need it: an e-signature recipient, for instance, is addressed by
    // UID, so a picker that only knew the client-row id would ask the wrong party to
    // sign. It comes off the row already being read, so no extra query or join.
    return {
      items: pageRows.map((r: any) => ({
        id: r.id, ...labelsFor(r), status: r.status || null, userId: r.user_id || null,
        clientType: r.client_type || 'person',
        // Meaningful for a company row (a person's is always 0); rides along
        // unconditionally, the same as `clientType`, rather than only under the
        // `clientType=company` filter, so a picker resolving an already-picked
        // company by id still gets a roster size to display.
        contactCount: Number(r.contact_count) || 0,
      })),
      hasMore,
    };
  }

  // ---- matter associations (client.matterIds -> matter_clients junction) ----

  async listMatterIds(lawFirmId: string, clientId: string) {
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterClients.matterId }).from(matterClients)
      .where(and(scope, eq(matterClients.clientId, clientId))));
    return rows.map((row) => row.matterId);
  }

  // Standalone (firm-scoped) tasks this client is linked to via task_clients.
  // Matter-scoped tasks clear their task_clients rows (clients derive from the
  // matter), so this returns only tasks not already covered by matter access.
  async listTaskIds(lawFirmId: string, clientId: string) {
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ taskId: taskClients.taskId }).from(tasks)
      .innerJoin(taskClients, eq(taskClients.taskId, tasks.id))
      .where(and(scope, eq(taskClients.clientId, clientId))));
    return rows.map((row) => row.taskId);
  }

  async linkMatter(lawFirmId: string, matterId: string, clientId: string) {
    await scopedInsertManyOnConflictDoNothing(
      matterClients,
      lawFirmId,
      [{ matterId, clientId }],
      [matterClients.matterId, matterClients.clientId],
    );
  }

  async unlinkMatter(lawFirmId: string, matterId: string, clientId: string) {
    await scopedDelete(matterClients, lawFirmId, and(
      eq(matterClients.matterId, matterId), eq(matterClients.clientId, clientId),
    )!);
  }

  /**
   * Upsert a client row inside ONE transaction: update when `existingId` is
   * provided, otherwise insert. Uses the same column mapping (toRow) as the base
   * create/update so the persisted columns are identical. Only the atomicity
   * boundary changes. Returns the resolved client id.
   */
  async upsertTxn(lawFirmId: string, existingId: any, data: any, executor?: DrizzleExecutor) {
    return withDrizzleTransaction(async (dbClient: any) => {
      let resolvedId;
      if (existingId) {
        await scopedUpdate(clients, lawFirmId, eq(clients.id, existingId), data, dbClient);
        resolvedId = existingId;
      } else {
        const rows = await scopedInsert(clients, lawFirmId, data, dbClient);
        resolvedId = rows[0].id;
      }
      return resolvedId;
    }, executor);
  }

  /**
   * Atomically validate + link a set of matterIds to a client in ONE transaction
   * (mirrors linkClientIdentityToFirm's pool.connect/begin/commit pattern). A
   * mid-way failure rolls back every link so the client is never left with a
   * partial set of matter associations. Returns { added, failed } using the same
   * shape addClientMatters produced, so the caller can emit MATTER_CLIENTS_UPDATED
   * for each added matter AFTER the commit.
   */
  async linkMattersTxn(lawFirmId: string, clientId: string, matterIds: string[], executor?: DrizzleExecutor) {
    const added: any[] = [];
    const failed: any[] = [];
    return withDrizzleTransaction(async (client: any) => {
      // Resolve which of the supplied matterIds actually exist for this firm in ONE
      // round-trip (`= any($2)`) instead of a per-matter existence query, then link
      // only the valid ones. Malformed (non-uuid) ids can't match a uuid column,
      // so they're filtered out up-front and reported as not-found.
      const candidateIds = matterIds.filter(isUuid);
      const existingIds = new Set();
      if (candidateIds.length) {
        const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
          .select({ id: matters.id }).from(matters)
          .where(and(scope, inArray(matters.id, candidateIds))), client);
        for (const r of rows) existingIds.add(r.id);
      }

      const validToLink = [];
      for (const matterId of matterIds) {
        if (!isUuid(matterId) || !existingIds.has(matterId)) {
          failed.push({ matterId, error: 'Matter not found' });
          continue;
        }
        validToLink.push(matterId);
      }
      const inserted = await scopedInsertManyOnConflictDoNothing(
        matterClients,
        lawFirmId,
        validToLink.map((matterId) => ({ matterId, clientId })),
        [matterClients.matterId, matterClients.clientId],
        undefined,
        client,
      );
      added.push(...inserted.map((row) => row.matterId));
      return { added, failed };
    }, executor);
  }

  async matterExists(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return false;
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matters.id }).from(matters).where(and(scope, eq(matters.id, matterId))).limit(1));
    return rows.length > 0;
  }

  // ---- delete cascade ----
  // Migration 0049 re-added ON DELETE CASCADE FKs from matter_clients/task_clients
  // to clients (notes/contacts already had theirs from 0038), so the DB now cleans
  // these junctions on a clients-row delete. This explicit cascade is kept as
  // belt-and-suspenders (the FKs are NOT VALID, and it documents the full delete
  // contract); it remains the single sanctioned delete path for a client row.

  /**
   * Count financial records that a client delete would CASCADE-destroy:
   * client-context invoices (+ their payments/credit notes), and client-scoped
   * time entries, flat fees, and expenses. Used to block deletion so recorded
   * financial history isn't silently wiped.
   */
  /**
   * Every billing row whose foreign key to `clients` is `restrict` (migration
   * 0225). The constraint is the guarantee; this is what turns it into a
   * sentence a firm can act on. A table added to that restrict set and not to
   * this query surfaces as a raw 500 from inside `deleteClientCascade`.
   *
   * `invoices.client_id` is deliberately absent: it is the bill-to pointer and
   * is `set null`, so an invoice raised on a matter and addressed to this
   * client survives the delete. `client_context_id` is the one that makes the
   * invoice the client's own.
   */
  async countBillingRecords(lawFirmId: string, clientId: string) {
    const { rows } = await tenantParameterizedQuery(invoices, lawFirmId,
      `select
         (select count(*) from invoices inv where inv.law_firm_id = $1 and inv.client_context_id = $2)
       + (select count(*) from activities a where a.law_firm_id = $1 and a.client_id = $2)
       + (select count(*) from billing_plans bp where bp.law_firm_id = $1 and bp.client_id = $2) as n`,
      [lawFirmId, clientId],
      'inv',
    );
    return Number(rows[0]?.n || 0);
  }

  /** Remove targeted invitations before the client's foreign keys are cleared. */
  async deleteClientCascade(lawFirmId: string, clientId: string) {
    // Run the full cascade in one transaction so a mid-sequence failure can't
    // leave the client partially deleted (e.g. junctions gone but the row kept).
    await withDrizzleTransaction(async (client) => {
      const existing = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
        .select({ id: clients.id }).from(clients).where(and(scope, eq(clients.id, clientId))).limit(1), client);
      if (!existing.length) return;
      await scopedDelete(invitations, lawFirmId, eq(invitations.clientId, clientId), client);
      await scopedDelete(matterClients, lawFirmId, eq(matterClients.clientId, clientId), client);
      await client.delete(taskClients).where(eq(taskClients.clientId, clientId));
      await scopedDelete(notes, lawFirmId, eq(notes.clientId, clientId), client);
      // A person client's own related contacts (contact_clients, unchanged by
      // the client_company_links migration - see clients.service.ts's person-
      // contact dispatch). Only the LINK goes; the directory contact itself
      // (e.g. opposing counsel who is also this client's guardian) survives.
      await scopedDelete(contactClients, lawFirmId, eq(contactClients.clientId, clientId), client);
      // Only the LINK goes, in both directions - the client row on the other
      // side of a link is a real, independent `clients` row now and must
      // survive. Deleting a company must not delete the real people linked to
      // it (they may have their own matters/billing), and deleting a person
      // must not delete a company that other people are still linked to. Both
      // FKs already cascade at the DB level (migration 0174), but this stays
      // explicit and inside the same transaction rather than relying on that.
      await scopedDelete(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.companyClientId, clientId), client);
      await scopedDelete(clientCompanyLinks, lawFirmId, eq(clientCompanyLinks.personClientId, clientId), client);
      // A company's canonical conversation (conversations.client_record_id,
      // migration 0172) has a RESTRICT FK to clients with no ON DELETE action,
      // so even an already-archived thread would still block the delete below.
      // Sever the link on ARCHIVED rows only, never live ones: both callers
      // (clients.service.ts's removeClient and privacy.service.ts's eraseClient)
      // already block the whole delete with a clear error while a live canonical
      // conversation exists, matching the migration's "a client delete must not
      // silently destroy message history" contract. Nulling only
      // client_record_id here preserves the conversation row and its messages -
      // it just stops naming the client being removed. The attachment bytes are
      // NOT preserved: both callers separately sweep them via
      // messagingRepo.sweepArchivedCompanyConversationAttachments (collected
      // before this transaction runs, since this is the last point the rows can
      // still be found by client_record_id), mirroring how a person client's
      // direct-thread attachments are already swept on CLIENT_DELETED
      // (files.events.ts) even though that conversation row also survives.
      await scopedUpdate(conversations, lawFirmId, and(
        eq(conversations.clientRecordId, clientId),
        isNotNull(conversations.archivedAt),
      )!, { clientRecordId: null }, client);
      // events.client_id lost its hard FK to clients (the WHOLE-SCHEMA
      // SOFT-REFERENCE sweep in schema.sql strips every FK pointing at
      // users/clients on every fresh apply), so nothing cascades these rows
      // away on their own - see clientEvents.repository#deleteAllForClient's
      // own comment for why an orphan left behind is worse than it looks.
      await clientEventsRepo.deleteAllForClient(lawFirmId, clientId, client);
      await scopedDelete(clients, lawFirmId, eq(clients.id, clientId), client);
    });
  }
}

export = new ClientsRepository();
