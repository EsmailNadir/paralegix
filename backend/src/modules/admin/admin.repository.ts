/**
 * Admin repository (Postgres). The platform-admin views read across firms/users/
 * members/roles/invitations/clients. This delegates to the ported domain repos
 * and uses explicit privileged Drizzle queries for the few cross-table reads.
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  clientCompanyLinks,
  clients,
  emailVerificationWhitelist,
  invitations,
  lawFirms,
  matterClients,
  matters,
  members,
  users,
} from '../../shared/database/drizzle/schema';
import { adminQuery, systemQuery, tenantQuery } from '../../shared/database/queryContext';
const { isUuid } = require('../../shared/utils/isUuid');
const { resolvePage } = require('../../shared/database/pagination');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const usersRepo = require('../users/users.repository');
const membersRepo = require('../lawfirms/members/members.repository');
const rolesRepo = require('../lawfirms/roles/roles.repository');
const rolesService = require('../lawfirms/roles/roles.service');
const invitationsRepo = require('../invitations/invitations.repository');

const { rowIso: iso } = require('../../shared/utils/dateConversion');

/**
 * Sortable columns for the platform-wide client list, mirrored by the route
 * schema's whitelist. `matter_count` is an output-column alias of the subquery in
 * `listClientsPaged`, so this map belongs to that query alone.
 */
const ADMIN_CLIENT_SORT_COLUMNS: Record<string, SQL> = {
  createdAt: sql`${clients.createdAt}`,
  name: sql`${clients.name}`,
  email: sql`${clients.email}`,
  status: sql`${clients.status}`,
  joinedAt: sql`${clients.joinedAt}`,
  invitedAt: sql`${clients.invitedAt}`,
  lawFirmName: sql`${lawFirms.name}`,
  matterCount: sql`matter_count`,
};

function adminClientOrder(sort: any, sortBy: any, order: any) {
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const ordering: SQL[] = [];
  for (const item of model) {
    const column = ADMIN_CLIENT_SORT_COLUMNS[item?.field];
    if (!column) continue;
    ordering.push(item?.dir === 'asc'
      ? sql`${column} asc nulls last`
      : sql`${column} desc nulls last`);
  }
  if (!ordering.length) ordering.push(sql`${clients.createdAt} desc nulls last`);
  ordering.push(asc(clients.id));
  return ordering;
}

class AdminRepository {
  // ── firms / users ──
  // The unpaged reads. Both are bounded by `LIST_CEILING` and report `truncated`
  // so a capped result is never mistaken for the whole platform.
  async listLawFirms(opts: any) { return lawfirmsRepo.listAllCapped(opts); }
  async listUsers(opts: any) { return usersRepo.findAllCapped(opts); }

  // Windowed + searchable variants for the admin console tables. Both sets grow
  // with the platform rather than with one tenant, so the console pages them
  // server-side instead of downloading everything and filtering in the browser.
  async listLawFirmsPaged(params: any) { return lawfirmsRepo.listAllPaged(params); }
  async countLawFirms() { return lawfirmsRepo.countAll(); }
  async listUsersPaged(params: any) { return usersRepo.findAllPaged(params); }
  async userCountsByType() { return usersRepo.countsByType(); }
  async lawFirmStats() { return lawfirmsRepo.platformStats(); }

  /**
   * Slim typeahead source for the platform-admin firm picker. This is the only
   * cross-tenant lookup in the codebase, so it is deliberately minimal: id, name,
   * plan and member count, never firm contents.
   *
   * Two strictly exclusive modes, matching the firm-scoped lookups:
   *  - `ids` given: resolve exactly those firms, so an already-saved selection can
   *    be labelled even when it falls outside the current search results.
   *  - otherwise: substring search over the firm name.
   *
   * Fetches limit+1 rows so the caller can report `hasMore` without a count query.
   */
  async lookupLawFirms({ search, ids, limit = 20 }: any = {}) {
    const wantsIdResolution = Array.isArray(ids) && ids.length > 0;
    const idList = wantsIdResolution ? ids.filter(isUuid) : [];
    let predicate: SQL | undefined;
    if (wantsIdResolution) {
      // An id-resolution request that matches nothing must return nothing.
      // Falling through to the search branch would answer "label these specific
      // firms" with an arbitrary page of unrelated ones, so a picker holding a
      // stale id would display the wrong firm as its selection.
      if (!idList.length) return { items: [], hasMore: false };
      predicate = inArray(lawFirms.id, idList);
    } else {
      const term = toIlikeTerm(search);
      if (term) predicate = sql`${lawFirms.name} ilike ${term} escape '\\'`;
    }

    const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
    const rows = await adminQuery('platform firm picker', (executor) => executor.select({
      id: lawFirms.id,
      name: lawFirms.name,
      planId: lawFirms.planId,
      memberCount: sql<number>`(select count(*) from ${members} where ${members.lawFirmId} = ${lawFirms.id})`,
    }).from(lawFirms).where(predicate)
      .orderBy(asc(lawFirms.name), desc(lawFirms.createdAt)).limit(lim + 1));

    const hasMore = rows.length > lim;
    return {
      items: rows.slice(0, lim).map((r: any) => ({
        id: r.id,
        label: r.name || 'Unnamed Firm',
        sublabel: `${r.planId || 'no plan'} - ${Number(r.memberCount) || 0} member${Number(r.memberCount) === 1 ? '' : 's'}`,
      })),
      hasMore,
    };
  }
  async findUserById(userId: string) { return usersRepo.findById(userId); }

  /** Count platform admins (for the last-admin lockout guard). */
  async countAdmins() {
    const [row] = await adminQuery('platform administrator count', (executor) => executor
      .select({ total: count() }).from(users).where(eq(users.isAdmin, true)));
    return row?.total || 0;
  }

  /**
   * Batch user-profile lookup by id (one round trip) for enriching member rows
   * that are missing name/email. Replaces an N+1 findUserById-per-member loop.
   * Returns only the fields the admin views need.
   */
  async findUsersByIds(userIds: string[]) {
    const ids = [...new Set<string>((userIds || []).filter(Boolean))];
    if (!ids.length) return [];
    return adminQuery('platform user profile batch', (executor) => executor
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users).where(inArray(users.id, ids)));
  }
  async findLawFirmById(lawFirmId: string) { return lawfirmsRepo.findById(lawFirmId); }

  /**
   * Scalar profile fields only. Storage quota/limits live in typed `storage_*`
   * columns and are written through `updateStorageConfig`, not here.
   */
  async updateLawFirm(lawFirmId: string, updateData: any) {
    if (Object.keys(updateData).length) await lawfirmsRepo.update(lawFirmId, updateData);
  }

  async updateUser(userId: string, updateData: any) { return usersRepo.update(userId, updateData); }

  // ── members / roles ──
  async listLawFirmMembers(lawFirmId: string) {
    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor.select({
      userId: members.userId,
      roleId: members.roleId,
      isOwner: members.isOwner,
      joinedAt: members.joinedAt,
      name: users.name,
      email: users.email,
    }).from(members).leftJoin(users, eq(users.id, members.userId)).where(scope));
    return rows.map((r: any) => ({
      id: r.userId, userId: r.userId,
      name: r.name || '', email: r.email || '',
      isOwner: r.isOwner === true, roleId: r.roleId || null,
      joinedAt: iso(r.joinedAt),
    }));
  }

  async listLawFirmRoles(lawFirmId: string) {
    const { roles } = await rolesService.listRoles({ lawFirmId });
    return roles;
  }
  async findLawFirmRole(lawFirmId: string, roleId: any) { return rolesRepo.findById(lawFirmId, roleId); }
  async updateLawFirmRole(lawFirmId: string, roleId: any, updateData: any) { return rolesRepo.update(lawFirmId, roleId, updateData); }

  async findLawFirmMember(lawFirmId: string, memberId: any) { return membersRepo.findByUserId(lawFirmId, memberId); }
  async updateLawFirmMember(lawFirmId: string, memberId: any, updateData: any) {
    return membersRepo.updateMember(lawFirmId, memberId, { roleId: updateData.roleId });
  }
  async deleteLawFirmMember(lawFirmId: string, memberId: any) { return membersRepo.removeMember(lawFirmId, memberId); }


  // ── invitations (unified table replaces pendingInvites/pendingClientInvites/inviteTokens) ──
  async listLawFirmPendingInvites(lawFirmId: string) { return invitationsRepo.listPending(lawFirmId, 'member'); }
  async listLawFirmPendingClientInvites(lawFirmId: string) { return invitationsRepo.listPending(lawFirmId, 'client'); }

  async _findInvite(lawFirmId: string, inviteId: any, inviteType: any) {
    const rows = await tenantQuery(invitations, lawFirmId, ({ executor, scope }) => executor.select({
      id: invitations.id,
      email: invitations.email,
      roleId: invitations.roleId,
      token: invitations.token,
      invitedAt: invitations.invitedAt,
      invitedBy: invitations.invitedBy,
    }).from(invitations).where(and(
      scope,
      eq(invitations.id, inviteId),
      eq(invitations.inviteType, inviteType),
    )).limit(1));
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, email: r.email, roleId: r.roleId || null, token: r.token, invitedAt: iso(r.invitedAt), invitedBy: r.invitedBy || null };
  }
  async findLawFirmPendingInvite(lawFirmId: string, inviteId: any) { return this._findInvite(lawFirmId, inviteId, 'member'); }
  async findLawFirmPendingClientInvite(lawFirmId: string, inviteId: any) { return this._findInvite(lawFirmId, inviteId, 'client'); }
  async _deleteInvite(lawFirmId: string, inviteId: any, inviteType: any) {
    await tenantQuery(invitations, lawFirmId, ({ executor, scope }) => executor
      .delete(invitations).where(and(scope, eq(invitations.id, inviteId), eq(invitations.inviteType, inviteType))));
  }
  async deleteLawFirmPendingInvite(lawFirmId: string, inviteId: any) { return this._deleteInvite(lawFirmId, inviteId, 'member'); }
  async deleteLawFirmPendingClientInvite(lawFirmId: string, inviteId: any) { return this._deleteInvite(lawFirmId, inviteId, 'client'); }


  // ── clients ──

  /**
   * One window of the platform-wide client list.
   *
   * This is a cross-tenant read, so it lives here rather than in
   * `clients.repository`: every method there is scoped by `law_firm_id` by
   * contract, and a query that deliberately spans firms does not belong behind
   * that contract. Authorization is the admin router's `requireIsAdmin`.
   *
   * Each row names its firm and reports the client's portal state, because the
   * two questions an admin actually arrives with are "which firm does this
   * person belong to" and "did they ever get into the portal".
   */
  async listClientsPaged({
    limit, offset, page, search, sort, sortBy, order,
    lawFirmId, status, portal, clientType, createdAfter, createdBefore,
  }: any = {}) {
    const filters: SQL[] = [];

    const term = toIlikeTerm(search);
    if (term) {
      filters.push(or(
        sql`${clients.name} ilike ${term} escape '\\'`,
        sql`${clients.email}::text ilike ${term} escape '\\'`,
        sql`${clients.organization} ilike ${term} escape '\\'`,
        sql`${clients.phone} ilike ${term} escape '\\'`,
        sql`${lawFirms.name} ilike ${term} escape '\\'`,
      )!);
    }

    if (isUuid(lawFirmId)) filters.push(eq(clients.lawFirmId, lawFirmId));
    if (status) filters.push(eq(clients.status, status));
    if (clientType === 'person' || clientType === 'company') filters.push(eq(clients.clientType, clientType));

    // Portal state is derived, not a column: `user_id` is set once the invite is
    // accepted and the account linked, and `portal_invite_pending` covers the gap
    // between sending the invite and that happening.
    if (portal === 'linked') filters.push(isNotNull(clients.userId));
    else if (portal === 'pending') filters.push(and(isNull(clients.userId), eq(clients.portalInvitePending, true))!);
    else if (portal === 'none') filters.push(and(isNull(clients.userId), eq(clients.portalInvitePending, false))!);

    if (createdAfter) filters.push(sql`${clients.createdAt} >= ${createdAfter}`);
    if (createdBefore) filters.push(sql`${clients.createdAt} <= ${createdBefore}`);

    const predicate = filters.length ? and(...filters) : undefined;
    const paging = limit == null ? null : resolvePage({ limit, offset, page });
    const rows = await adminQuery<any[]>('platform client directory', (executor) => {
      let query: any = executor.select({
        id: clients.id,
        lawFirmId: clients.lawFirmId,
        userId: clients.userId,
        clientType: clients.clientType,
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
        organization: clients.organization,
        status: clients.status,
        portalInvitePending: clients.portalInvitePending,
        invitedAt: clients.invitedAt,
        joinedAt: clients.joinedAt,
        invitationSentAt: clients.invitationSentAt,
        invitationFailed: clients.invitationFailed,
        createdAt: clients.createdAt,
        lawFirmName: lawFirms.name,
        portalEmail: users.email,
        portalCreatedAt: users.createdAt,
        totalCount: sql<number>`count(*) over()`,
        matterCount: sql<number>`(select count(*)::int from ${matterClients} where ${matterClients.clientId} = ${clients.id})`.as('matter_count'),
        // Portal-enabled people linked via client_company_links (their own
        // clients.user_id is not null), meaningful only for a company client -
        // a person client's own portal link is `clients.user_id`/`portalStatus`
        // above, never this. Always 0 for a person row since nothing links to it.
        rosterPortalCount: sql<number>`(
          select count(*)::int
            from ${clientCompanyLinks} l
            join clients p on p.id = l.person_client_id and p.law_firm_id = l.law_firm_id
           where l.law_firm_id = ${clients.lawFirmId}
             and l.company_client_id = ${clients.id}
             and p.user_id is not null
        )`.as('roster_portal_count'),
      }).from(clients)
        .innerJoin(lawFirms, eq(lawFirms.id, clients.lawFirmId))
        .leftJoin(users, eq(users.id, clients.userId))
        .where(predicate)
        .orderBy(...adminClientOrder(sort, sortBy, order));
      if (paging) query = query.limit(paging.limit).offset(paging.offset);
      return query;
    });

    let totalItems = rows.length ? Number(rows[0].totalCount) : 0;
    if (!rows.length && paging?.offset) {
      const [total] = await adminQuery('platform client directory count', (executor) => executor
        .select({ total: count() }).from(clients)
        .innerJoin(lawFirms, eq(lawFirms.id, clients.lawFirmId)).where(predicate));
      totalItems = total?.total || 0;
    }

    return {
      clients: rows.map((r: any) => ({
        id: r.id,
        lawFirmId: r.lawFirmId,
        lawFirmName: r.lawFirmName || 'Unnamed Firm',
        clientType: r.clientType === 'company' ? 'company' : 'person',
        userId: r.userId || null,
        name: r.name || '',
        email: r.email || '',
        phone: r.phone || null,
        organization: r.organization || null,
        status: r.status || 'active',
        // Three mutually exclusive states, resolved here so the console renders a
        // label rather than re-deriving the same precedence from three fields.
        // Only meaningful for a person client (`clients.user_id`); a company's
        // portal reach is `rosterPortalCount` below, never this.
        portalStatus: r.userId ? 'linked' : (r.portalInvitePending ? 'pending' : 'none'),
        portalEmail: r.portalEmail || null,
        portalAccountCreatedAt: iso(r.portalCreatedAt),
        // Portal-enabled roster contact count. Always 0 for a person client.
        rosterPortalCount: Number(r.rosterPortalCount) || 0,
        invitationFailed: r.invitationFailed === true,
        invitedAt: iso(r.invitedAt),
        invitationSentAt: iso(r.invitationSentAt),
        joinedAt: iso(r.joinedAt),
        createdAt: iso(r.createdAt),
        matterCount: Number(r.matterCount) || 0,
      })),
      totalItems,
    };
  }

  /**
   * Platform-wide client counts for the console's stat cards. Unfiltered on
   * purpose, the same way `userCountsByType` is: the cards report the platform,
   * not the current search.
   *
   * `total`/`personCount`/`companyCount` count `clients` ROWS - a company is one
   * row no matter how large its roster. `peopleTotal` counts actual PEOPLE
   * instead: every person client plus every person linked to a company client
   * via `client_company_links` (`rosterContactTotal`), since a company's linked
   * people add real people the record count alone would hide. Keep these two
   * kinds of "clients" labeled distinctly wherever they're displayed.
   */
  async clientCounts() {
    const rows = await adminQuery('platform client statistics', (executor) => executor.select({
      total: count(),
      withPortal: sql<number>`count(*) filter (where ${clients.userId} is not null)::int`,
      invitesPending: sql<number>`count(*) filter (where ${clients.userId} is null and ${clients.portalInvitePending})::int`,
      new7d: sql<number>`count(*) filter (where ${clients.createdAt} >= now() - interval '7 days')::int`,
      new30d: sql<number>`count(*) filter (where ${clients.createdAt} >= now() - interval '30 days')::int`,
      personCount: sql<number>`count(*) filter (where ${clients.clientType} = 'person')::int`,
      companyCount: sql<number>`count(*) filter (where ${clients.clientType} = 'company')::int`,
    }).from(clients));
    const r = rows[0] || {};

    // Every person linked to a company client via client_company_links,
    // platform-wide. A second query rather than a join above because joining
    // client_company_links onto the first aggregate would multiply the
    // per-client filtered counts by the linkage fan-out.
    const rosterPersonClients = alias(clients, 'roster_person_clients');
    const [rosterRow] = await adminQuery('platform company roster statistics', (executor) => executor
      .select({
        rosterContactTotal: count(),
        rosterPortalTotal: sql<number>`count(*) filter (where ${rosterPersonClients.userId} is not null)::int`,
      })
      .from(clientCompanyLinks)
      .innerJoin(clients, and(
        eq(clients.id, clientCompanyLinks.companyClientId),
        eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
      ))
      .innerJoin(rosterPersonClients, and(
        eq(rosterPersonClients.id, clientCompanyLinks.personClientId),
        eq(rosterPersonClients.lawFirmId, clientCompanyLinks.lawFirmId),
      ))
      .where(eq(clients.clientType, 'company')));
    const rr = rosterRow || {};

    const personCount = Number(r.personCount) || 0;
    const rosterContactTotal = Number(rr.rosterContactTotal) || 0;

    return {
      total: Number(r.total) || 0,
      withPortal: Number(r.withPortal) || 0,
      invitesPending: Number(r.invitesPending) || 0,
      new7d: Number(r.new7d) || 0,
      new30d: Number(r.new30d) || 0,
      personCount,
      companyCount: Number(r.companyCount) || 0,
      rosterContactTotal,
      rosterPortalTotal: Number(rr.rosterPortalTotal) || 0,
      // Real people, not client records: person clients plus every roster
      // contact on a company client (portal-enabled or not).
      peopleTotal: personCount + rosterContactTotal,
    };
  }

  async listLawFirmClients(lawFirmId: string) {
    const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor.select({
      id: clients.id,
      userId: clients.userId,
      clientType: clients.clientType,
      name: clients.name,
      email: clients.email,
      createdAt: clients.createdAt,
      matterIds: sql<string[]>`coalesce(array_agg(${matterClients.matterId}) filter (where ${matterClients.matterId} is not null), '{}')`,
      rosterPortalCount: sql<number>`(
        select count(*)::int
          from ${clientCompanyLinks} l
          join clients p on p.id = l.person_client_id and p.law_firm_id = l.law_firm_id
         where l.law_firm_id = ${clients.lawFirmId}
           and l.company_client_id = ${clients.id}
           and p.user_id is not null
      )`,
    }).from(clients).leftJoin(matterClients, and(
      eq(matterClients.clientId, clients.id),
      eq(matterClients.lawFirmId, clients.lawFirmId),
    )).where(scope).groupBy(clients.id));
    return rows.map((r: any) => ({
      // userId is the client's linked Firebase uid (null when they have no
      // portal account) - it must never fall back to `id` (the clients.id
      // uuid), which would silently pass a uuid off as a portal identity.
      id: r.id, userId: r.userId || null,
      clientType: r.clientType === 'company' ? 'company' : 'person',
      name: r.name || '', email: r.email || '',
      // Portal-enabled roster contacts, meaningful only for a company client.
      rosterPortalCount: Number(r.rosterPortalCount) || 0,
      joinedAt: iso(r.createdAt), matterIds: r.matterIds || [],
    }));
  }

  // ── usage counts ──
  async countMatters(lawFirmId: string) {
    const [row] = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ total: count() }).from(matters).where(scope));
    return row?.total || 0;
  }
  async countMembers(lawFirmId: string) {
    const [row] = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .select({ total: count() }).from(members).where(scope));
    return row?.total || 0;
  }

  /**
   * Batch matter counts grouped by firm in ONE query. Returns a
   * `Map<lawFirmId, count>` (firms with zero matters are absent). Replaces the
   * per-firm count(*) loop in listPlanUsage.
   */
  async countMattersByFirm(lawFirmIds: any) {
    const ids = [...new Set<string>((lawFirmIds || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const rows = await adminQuery('matter counts for selected firms', (executor) => executor.select({
      lawFirmId: matters.lawFirmId,
      total: count(),
    }).from(matters).where(inArray(matters.lawFirmId, ids)).groupBy(matters.lawFirmId));
    rows.forEach((r: any) => out.set(r.lawFirmId, r.total));
    return out;
  }

  /** Batch member counts grouped by firm in ONE query (see countMattersByFirm). */
  async countMembersByFirm(lawFirmIds: any) {
    const ids = [...new Set<string>((lawFirmIds || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const rows = await adminQuery('member counts for selected firms', (executor) => executor.select({
      lawFirmId: members.lawFirmId,
      total: count(),
    }).from(members).where(inArray(members.lawFirmId, ids)).groupBy(members.lawFirmId));
    rows.forEach((r: any) => out.set(r.lawFirmId, r.total));
    return out;
  }

  // ── email-verification whitelist (test accounts) ──
  async listWhitelist() {
    const rows = await adminQuery('email verification whitelist', (executor) => executor.select({
      email: emailVerificationWhitelist.email,
      note: emailVerificationWhitelist.note,
      createdBy: emailVerificationWhitelist.createdBy,
      createdAt: emailVerificationWhitelist.createdAt,
      createdByEmail: users.email,
    }).from(emailVerificationWhitelist)
      .leftJoin(users, eq(users.id, emailVerificationWhitelist.createdBy))
      .orderBy(desc(emailVerificationWhitelist.createdAt)));
    return rows.map((r: any) => ({
      email: r.email,
      note: r.note || null,
      createdBy: r.createdBy || null,
      createdByEmail: r.createdByEmail || null,
      createdAt: iso(r.createdAt),
    }));
  }

  async addWhitelist({ email, note, createdBy }: any) {
    // email is citext so uniqueness is case-insensitive; upsert keeps the note fresh.
    await adminQuery('email verification whitelist upsert', (executor) => executor
      .insert(emailVerificationWhitelist).values({ email, note: note || null, createdBy: createdBy || null })
      .onConflictDoUpdate({ target: emailVerificationWhitelist.email, set: { note: note || null } }));
  }

  async removeWhitelist(email: any) {
    const rows = await adminQuery('email verification whitelist delete', (executor) => executor
      .delete(emailVerificationWhitelist).where(eq(emailVerificationWhitelist.email, email))
      .returning({ email: emailVerificationWhitelist.email }));
    return rows.length > 0;
  }

  // ── account creation (admin test tooling) ──
  /** Find a Postgres users row by email (citext, case-insensitive). */
  async findUserByEmail(email: any) {
    const rows = await systemQuery('auth_identity', (executor) => executor.select({
      id: users.id,
      email: users.email,
      name: users.name,
      user_type: users.userType,
    }).from(users).where(eq(users.email, email)).limit(1));
    return rows[0] || null;
  }

  /** Insert (or upsert) a users row keyed by the Firebase UID. */
  async insertUserRow({ uid, email, name, userType }: any) {
    const insertType = userType || 'pending';
    await systemQuery('auth_identity', (executor) => executor.insert(users).values({
      id: uid,
      email: email || null,
      name: name || null,
      userType: insertType,
    }).onConflictDoUpdate({
      target: users.id,
      set: {
        email: email || null,
        name: name || null,
        userType: userType || sql`${users.userType}`,
        updatedAt: sql`now()`,
      },
    }));
  }

  /**
   * Remove a users row by Firebase UID, for the rollback in adminCreateAccount.
   *
   * Only ever called against a uid this process inserted moments earlier in a
   * request that then failed, so it is undoing its own partial write rather than
   * deleting a real person. The account-deletion path a real person goes through
   * is `privacy`, which checks activity first.
   */
  async deleteUserRow(uid: string) {
    await systemQuery('auth_identity', (executor) => executor
      .delete(users).where(eq(users.id, uid)));
  }
}

export = new AdminRepository();
