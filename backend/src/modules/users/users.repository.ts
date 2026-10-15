import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lte,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzleRowToEntity } from '../../shared/database/DrizzleRepository';
import {
  clients,
  auditEvents,
  contactClients,
  conversationParticipants,
  conversations,
  digestSends,
  emailVerificationWhitelist,
  fileClientAccess,
  invitations,
  matters,
  notifications,
  taskSubtasks,
  lawFirms,
  matterMembers,
  members,
  oauthStates,
  roles,
  taskAssignees,
  eventAssignees,
  userOauthTokens,
  users,
} from '../../shared/database/drizzle/schema';
import {
  adminQuery,
  systemQuery,
  tenantQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import { toIlikeTerm } from '../../shared/database/searchTerm';
import { applyCeiling, LIST_CEILING, resolvePage } from '../../shared/database/pagination';
import { NotFoundError } from '../../shared/errors/AppError';
const { isUuid } = require('../../shared/utils/isUuid');

const UPDATABLE_USER_COLUMNS = new Set(['name', 'email', 'userType', 'isAdmin', 'photoObjectPath']);

// Domain stamped onto the email of an account erased by `anonymizeAccount`. The
// row is kept deliberately as a tombstone so the ~80 non-cascading foreign keys
// to users(id) stay valid, so anything sweeping the table must leave it alone.
const ERASED_ACCOUNT_EMAIL_DOMAIN = '@deleted.invalid';
const USER_COLUMNS: Record<string, any> = {
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  name: users.name,
  email: users.email,
  userType: users.userType,
  isAdmin: users.isAdmin,
};

function toEntity(row: any) {
  return drizzleRowToEntity(row);
}

function userOrder(sort: any, sortBy: string, order: string, lastLoginAt: any) {
  const columns: Record<string, any> = { ...USER_COLUMNS, lastLoginAt };
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const expressions: SQL[] = [];
  for (const item of model) {
    const column = columns[item?.field];
    if (!column) continue;
    const direction = String(item?.dir).toLowerCase() === 'asc' ? sql.raw('asc') : sql.raw('desc');
    expressions.push(sql`${column} ${direction} nulls last`);
  }
  if (!expressions.length) expressions.push(sql`${users.createdAt} desc nulls last`);
  expressions.push(sql`${users.id} asc`);
  return expressions;
}

class UsersRepository {
  async lockForMembershipChange(userId: string, executor: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update'), executor);
    if (!rows.length) throw new NotFoundError('User');
  }

  async findById(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1), executor);
    return toEntity(rows[0]);
  }

  async findByIdOrFail(userId: string, executor?: DrizzleExecutor) {
    const user = await this.findById(userId, executor);
    if (!user) throw new NotFoundError('User');
    return user;
  }

  async findAllCapped({ ceiling = LIST_CEILING }: any = {}) {
    const rows = await adminQuery('capped platform user export', (executor) => executor
      .select()
      .from(users)
      .orderBy(desc(users.createdAt), asc(users.id))
      .limit(ceiling + 1));
    const capped = applyCeiling(rows, ceiling);
    return {
      users: capped.rows.map((row: any) => toEntity(row)),
      truncated: capped.truncated,
      ceiling: capped.ceiling,
    };
  }

  async findAllPaged(options: any = {}) {
    const {
      limit,
      offset,
      page,
      search,
      sort,
      sortBy,
      order,
      userType,
      isAdmin,
      lawFirmId,
      createdAfter,
      createdBefore,
    } = options;
    const filters: SQL[] = [];
    const term = toIlikeTerm(search);
    if (term) {
      filters.push(or(
        sql`${users.id} ilike ${term} escape '\\'`,
        sql`${users.name} ilike ${term} escape '\\'`,
        sql`${users.email}::text ilike ${term} escape '\\'`,
        sql`${users.userType} ilike ${term} escape '\\'`,
        sql`(${users.isAdmin} and 'admin' ilike ${term} escape '\\')`,
      )!);
    }
    if (userType) filters.push(eq(users.userType, userType));
    if (typeof isAdmin === 'boolean') filters.push(eq(users.isAdmin, isAdmin));
    if (isUuid(lawFirmId)) {
      filters.push(sql`(
        exists (select 1 from ${members} where ${members.userId} = ${users.id}
          and ${members.lawFirmId} = ${lawFirmId})
        or exists (select 1 from ${clients} where ${clients.userId} = ${users.id}
          and ${clients.lawFirmId} = ${lawFirmId})
      )`);
    }
    if (createdAfter) filters.push(gte(users.createdAt, createdAfter));
    if (createdBefore) filters.push(lte(users.createdAt, createdBefore));
    const predicate = filters.length ? and(...filters) : undefined;
    const paging = limit == null ? null : resolvePage({ limit, offset, page });
    const rows = await adminQuery<any[]>('platform user directory', (executor) => {
      const latestLogin = executor.select({
        createdAt: auditEvents.createdAt,
        provider: sql<string | null>`${auditEvents.metadata}->>'provider'`.as('provider'),
      }).from(auditEvents)
        .where(and(eq(auditEvents.actorUid, users.id), eq(auditEvents.action, 'auth.login')))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1)
        .as('latest_login');
      const ordering = userOrder(sort, sortBy, order, latestLogin.createdAt);
      let query: any = executor.select({
        ...getTableColumns(users),
        totalCount: sql<number>`count(*) over()`,
        memberFirms: sql<any>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ${lawFirms.id},
            'name', ${lawFirms.name},
            'isOwner', ${members.isOwner},
            'roleName', ${roles.name},
            'joinedAt', ${members.joinedAt}
          ) order by ${lawFirms.name} asc)
          from ${members}
          join ${lawFirms} on ${lawFirms.id} = ${members.lawFirmId}
          left join ${roles} on ${roles.lawFirmId} = ${members.lawFirmId} and ${roles.id} = ${members.roleId}
          where ${members.userId} = ${users.id}
        ), '[]'::jsonb)`,
        clientFirms: sql<any>`coalesce((
          select jsonb_agg(jsonb_build_object('id', firm_rows.id, 'name', firm_rows.name)
            order by firm_rows.name asc)
          from (
            select distinct ${lawFirms.id} as id, ${lawFirms.name} as name
            from ${clients}
            join ${lawFirms} on ${lawFirms.id} = ${clients.lawFirmId}
            where ${clients.userId} = ${users.id}
          ) firm_rows
        ), '[]'::jsonb)`,
        lastLoginAt: latestLogin.createdAt,
        lastLoginProvider: latestLogin.provider,
      }).from(users)
        .leftJoinLateral(latestLogin, sql`true`)
        .where(predicate)
        .orderBy(...ordering);
      if (paging) query = query.limit(paging.limit).offset(paging.offset);
      return query;
    });

    let totalItems = rows.length ? Number(rows[0].totalCount) : 0;
    if (!rows.length && paging?.offset) {
      const totals = await adminQuery('platform user directory count', (executor) => executor
        .select({ total: count() })
        .from(users)
        .where(predicate));
      totalItems = totals[0]?.total || 0;
    }

    return {
      users: rows.map((row) => {
        const entity: any = toEntity(row);
        delete entity.totalCount;
        entity.lastLoginAt = entity.lastLoginAt || null;
        entity.lastLoginProvider = entity.lastLoginProvider || null;
        return entity;
      }),
      totalItems,
    };
  }

  async countsByType() {
    const [result] = await adminQuery('platform user statistics', (executor) => executor.select({
      total: count(),
      clients: sql<number>`count(*) filter (where ${users.userType} = 'client')::int`,
      firmMembers: sql<number>`count(*) filter (where ${users.userType} = 'firm_member')::int`,
      pending: sql<number>`count(*) filter (where ${users.userType} = 'pending')::int`,
      admins: sql<number>`count(*) filter (where ${users.isAdmin})::int`,
      new24h: sql<number>`count(*) filter (where ${users.createdAt} >= now() - interval '24 hours')::int`,
      new7d: sql<number>`count(*) filter (where ${users.createdAt} >= now() - interval '7 days')::int`,
      new30d: sql<number>`count(*) filter (where ${users.createdAt} >= now() - interval '30 days')::int`,
    }).from(users));
    return result || {
      total: 0, clients: 0, firmMembers: 0, pending: 0, admins: 0, new24h: 0, new7d: 0, new30d: 0,
    };
  }

  async update(userId: string, data: any, executor?: DrizzleExecutor) {
    const values = Object.fromEntries(Object.entries(data || {})
      .filter(([key, value]) => value !== undefined && UPDATABLE_USER_COLUMNS.has(key)));
    if (!Object.keys(values).length) return;
    await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .update(users)
      .set(values)
      .where(eq(users.id, userId)), executor);
  }

  async getLawFirmMembers(lawFirmId: string) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor, scope }) => executor.select({
        userId: members.userId,
        roleId: members.roleId,
        isOwner: members.isOwner,
        defaultHourlyRateCents: members.defaultHourlyRateCents,
        joinedAt: members.joinedAt,
        name: users.name,
        email: users.email,
        userType: users.userType,
        photoObjectPath: users.photoObjectPath,
        roleName: roles.name,
      }).from(members)
        .leftJoin(users, eq(users.id, members.userId))
        .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
        .where(scope),
    );
    return rows.map((row) => ({
      id: row.userId,
      uid: row.userId,
      userId: row.userId,
      name: row.name || '',
      email: row.email || '',
      role: row.roleName || (row.isOwner ? 'owner' : 'member'),
      roleId: row.roleId,
      isOwner: row.isOwner,
      userType: row.userType || 'firm_member',
      photoObjectPath: row.photoObjectPath || null,
      joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
      defaultHourlyRate: row.defaultHourlyRateCents == null ? null : row.defaultHourlyRateCents / 100,
    }));
  }

  async getFirmAdminRecipients(lawFirmId: string) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor, scope }) => executor.select({ email: users.email, name: users.name })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .leftJoin(roles, and(eq(roles.id, members.roleId), eq(roles.lawFirmId, members.lawFirmId)))
        .where(and(
          scope,
          isNotNull(users.email),
          or(eq(members.isOwner, true), inArray(sql`lower(${roles.name})`, ['admin', 'owner', 'partner'])),
        )),
    );
    return rows.map((row) => ({ email: row.email, name: row.name || null }));
  }

  async sharesLawFirm(userIdA: string, userIdB: string) {
    const [result] = await systemQuery('auth_identity', (executor) => executor.select({
      allowed: sql<boolean>`exists (
        select 1 from (
          select law_firm_id from members where user_id = ${userIdA}
          union select law_firm_id from clients where user_id = ${userIdA}
        ) first_user
        join (
          select law_firm_id from members where user_id = ${userIdB}
          union select law_firm_id from clients where user_id = ${userIdB}
        ) second_user using (law_firm_id)
      )`,
    }).from(users).where(eq(users.id, userIdA)).limit(1));
    return Boolean(result?.allowed);
  }

  async canReadProfile(requesterId: string, targetId: string) {
    const [result] = await systemQuery('auth_identity', (executor) => executor.select({
      allowed: sql<boolean>`exists (
        select 1 from (
          select law_firm_id, true as is_member from members where user_id = ${requesterId}
          union all select law_firm_id, false as is_member from clients where user_id = ${requesterId}
        ) requester
        join (
          select law_firm_id, true as is_member from members where user_id = ${targetId}
          union all select law_firm_id, false as is_member from clients where user_id = ${targetId}
        ) target using (law_firm_id)
        where requester.is_member or target.is_member
      )`,
    }).from(users).where(eq(users.id, requesterId)).limit(1));
    return Boolean(result?.allowed);
  }

  async getLawFirmIdsForUser(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ lawFirmId: members.lawFirmId })
      .from(members)
      .where(eq(members.userId, userId)), executor);
    return rows.map((row) => row.lawFirmId);
  }

  async getMemberships(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (executor) => executor.select({
      lawFirmId: members.lawFirmId,
      isOwner: members.isOwner,
      joinedAt: members.joinedAt,
      lawFirmName: lawFirms.name,
      roleName: roles.name,
    }).from(members)
      .leftJoin(lawFirms, eq(lawFirms.id, members.lawFirmId))
      .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
      .where(eq(members.userId, userId))
      .orderBy(sql`${lawFirms.name} nulls last`), executor);
    return rows.map((row) => ({
      ...row,
      lawFirmName: row.lawFirmName || null,
      roleName: row.roleName || null,
      joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
    }));
  }

  /** Migration 0217 dissolved `user_settings`: the timezone and preferences it
   *  held are columns on the user itself. */
  async getSettings(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({ userId: users.id, timezone: users.timezone, preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1), executor);
    return toEntity(rows[0]);
  }

  async recordConsent(
    userId: string,
    { termsAcceptedAt, privacyAcceptedAt, consentVersion, consentIp }: any,
    executor?: DrizzleExecutor,
  ) {
    const asDate = (value: unknown) => value
      ? (value instanceof Date ? value : new Date(String(value)))
      : null;
    await systemQuery('auth_identity', (queryExecutor) => queryExecutor.update(users).set({
      termsAcceptedAt: asDate(termsAcceptedAt),
      privacyAcceptedAt: asDate(privacyAcceptedAt),
      consentVersion: consentVersion || null,
      consentIp: consentIp || null,
    }).where(eq(users.id, userId)), executor);
  }

  /**
   * Candidate rows for the unverified-account sweep: accounts created longer
   * ago than the grace period, oldest first.
   *
   * This is deliberately only an AGE filter. The users table has no
   * email_verified column - verification state lives solely in Firebase Auth -
   * so the caller MUST confirm each candidate against Firebase before deleting
   * anything. Batched via `limit` so a large backlog is worked down over
   * successive cron runs rather than in one long request.
   *
   * Accounts already erased through the privacy flow are excluded. Erasure
   * deletes the Firebase identity but keeps an anonymized tombstone row on
   * purpose, so to a Firebase lookup a tombstone is indistinguishable from an
   * orphan - without this filter the sweep would try to delete one every run
   * and fail against whatever still references it.
   */
  async findOlderThanDays({ days, limit }: { days: number; limit: number }) {
    return systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({
        id: users.id,
        email: users.email,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(
        sql`${users.createdAt} < now() - (${days}::int * interval '1 day')`,
        notLike(users.email, `%${ERASED_ACCOUNT_EMAIL_DOMAIN}`),
      ))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(limit));
  }

  /**
   * The subset of `emails` that are on the DB-managed email-verification
   * whitelist, lower-cased.
   *
   * Read straight from the table rather than through `isWhitelisted`, whose
   * cached set is populated by a fire-and-forget load at module import and
   * refreshed on a 15s timer. That is the right trade on the auth path, where a
   * stale entry only delays a sign-in - but a caller that DELETES accounts must
   * not decide against a set that may not have loaded yet, or that silently kept
   * its last known-good values through a database error.
   */
  async findWhitelistedEmails(emails: string[]) {
    const wanted = emails
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length) return new Set<string>();
    const rows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({ email: emailVerificationWhitelist.email })
      .from(emailVerificationWhitelist)
      .where(inArray(emailVerificationWhitelist.email, wanted)));
    return new Set(rows.map((row: any) => String(row.email || '').trim().toLowerCase()));
  }

  /**
   * The subset of `emails` that a firm already has a record for, split by which
   * kind of record it is, lower-cased.
   *
   * These are matched by EMAIL rather than by uid, so they catch the case a
   * uid-keyed check cannot: a client who was invited or already exists in a
   * firm's books, started an account, and has not verified it yet. Nothing links
   * that half-made account to the firm record until the address is proven
   * (invites are only claimed once `emailVerified` is true), so without this the
   * account looks exactly like an abandoned stranger's.
   *
   * This only ever decides whether to KEEP an account. No invitation is read for
   * deletion here, and none can be deleted by removing a user: `invitations`
   * carries no FK from its address columns, and its `invited_by`/`accepted_by`
   * columns have no delete action, so they abort a user delete rather than
   * cascade from it.
   */
  async findEmailsWithFirmRecords(emails: string[]) {
    const empty = { invited: new Set<string>(), clients: new Set<string>() };
    const wanted = emails
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length) return empty;

    const normalize = (rows: any[]) => new Set(
      rows.map((row: any) => String(row.email || '').trim().toLowerCase()).filter(Boolean),
    );

    // Both address columns count. `email` is who the invite is FOR;
    // `invitation_email` is the address it was actually SENT to, stamped on
    // markSent, and the two can differ. Only `pending` blocks: the housekeeping
    // cron flips a lapsed invite to `expired` in an earlier pass of the same
    // run, so a dead invite stops holding an address within one cycle.
    const invitedRows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({ email: invitations.email, sentTo: invitations.invitationEmail })
      .from(invitations)
      .where(and(
        or(
          inArray(invitations.email, wanted),
          inArray(invitations.invitationEmail, wanted),
        ),
        eq(invitations.status, 'pending'),
      )));
    const clientRows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .select({ email: clients.email })
      .from(clients)
      .where(inArray(clients.email, wanted)));

    const invited = normalize(invitedRows);
    for (const row of invitedRows) {
      const sentTo = String((row as any).sentTo || '').trim().toLowerCase();
      if (sentTo) invited.add(sentTo);
    }

    return { invited, clients: normalize(clientRows) };
  }

  /**
   * The name of the first check that shows this uid is in real use, or null if
   * none do. A non-null result means the account must never be swept; the name
   * is carried into the cron output so a skip says WHY.
   *
   * WHAT BELONGS IN THIS LIST. Of the ~86 foreign keys to users(id), all but a
   * handful have no delete action, so the database itself aborts a delete that
   * would orphan them - `created_by`, `updated_by`, `sender_user_id` and the
   * rest need no check here because they cannot be lost silently.
   *
   * The ones below are the exceptions: every FK to users(id) declared
   * `on delete cascade` or `on delete set null`. Those are the only references
   * Postgres will quietly destroy or unlink, so they are exactly the ones the
   * application has to guard. `members`, `matter_members`, `task_assignees`,
   * `notifications` and friends CASCADE, and `clients.user_id`,
   * `conversations.client_id` and `task_subtasks.assignee_user_id` are SET NULL
   * - an unguarded delete would strip a real person out of their firm, or
   * silently unassign their work, and report success.
   *
   * ADDING A NEW CASCADING OR SET-NULL FK TO users(id) MEANS ADDING IT HERE.
   * `email_verification_whitelist.created_by` is the one deliberate omission:
   * it records who added a whitelist entry, not a relationship to the account.
   *
   * `matters` is checked too, even though both of its columns are no-action and
   * the database would refuse anyway. Someone who created or leads a matter is
   * as real as a user gets, and a named skip reads better in the cron output
   * than a foreign-key error.
   */
  async findAccountActivity(userId: string) {
    const probes: Array<[string, () => Promise<unknown[]>]> = [
      // Firm and matter membership.
      ['members', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: members.userId }).from(members)
        .where(eq(members.userId, userId)).limit(1))],
      ['matterMembers', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: matterMembers.userId }).from(matterMembers)
        .where(eq(matterMembers.userId, userId)).limit(1))],
      ['matterCreated', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: matters.id }).from(matters)
        .where(eq(matters.createdBy, userId)).limit(1))],
      ['matterLead', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: matters.id }).from(matters)
        .where(eq(matters.leadUserId, userId)).limit(1))],
      // Client identity and portal activity.
      ['clients', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: clients.id }).from(clients)
        .where(eq(clients.userId, userId)).limit(1))],
      ['fileClientAccess', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: fileClientAccess.clientUserId }).from(fileClientAccess)
        .where(eq(fileClientAccess.clientUserId, userId)).limit(1))],
      // Assigned work.
      ['taskAssignees', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: taskAssignees.userId }).from(taskAssignees)
        .where(eq(taskAssignees.userId, userId)).limit(1))],
      ['taskSubtasks', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: taskSubtasks.id }).from(taskSubtasks)
        .where(eq(taskSubtasks.assigneeUserId, userId)).limit(1))],

      // Calendar events this person is on. Migration 0218 turned
      // `events.assigned_to` from a jsonb array into `event_assignees` rows with
      // an `on delete cascade` to users, so without this probe deleting an
      // account would silently drop them from every hearing and deadline they
      // were assigned, rather than refusing the delete.
      ['eventAssignees', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: eventAssignees.userId }).from(eventAssignees)
        .where(eq(eventAssignees.userId, userId)).limit(1))],
      // Messaging.
      ['conversationParticipants', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: conversationParticipants.conversationId }).from(conversationParticipants)
        .where(eq(conversationParticipants.participantUserId, userId)).limit(1))],
      ['conversations', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: conversations.id }).from(conversations)
        .where(eq(conversations.clientId, userId)).limit(1))],
      // Account state that only a used account accumulates. There is no
      // `user_settings` probe any more: migration 0217 folded that table onto the
      // user row itself, so there is no separate row whose existence could signal
      // a used account.
      ['userOauthTokens', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: userOauthTokens.userId }).from(userOauthTokens)
        .where(eq(userOauthTokens.userId, userId)).limit(1))],
      ['oauthStates', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: oauthStates.userId }).from(oauthStates)
        .where(eq(oauthStates.userId, userId)).limit(1))],
      ['notifications', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: notifications.id }).from(notifications)
        .where(eq(notifications.userId, userId)).limit(1))],
      ['digestSends', () => systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ v: digestSends.userId }).from(digestSends)
        .where(eq(digestSends.userId, userId)).limit(1))],
    ];

    for (const [name, probe] of probes) {
      // eslint-disable-next-line no-await-in-loop -- short-circuits on the first
      // hit, so a uid that is plainly in use costs one indexed lookup.
      const rows = await probe();
      if (rows.length) return name;
    }
    return null;
  }

  /**
   * Hard-delete a users row and the rows that cascade from it. Only safe once
   * `findAccountActivity` returns null; any surviving reference aborts the delete at
   * the database, which the caller reports rather than swallows.
   */
  async deleteAccount(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('privacy_erasure', (queryExecutor) => queryExecutor
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id }), executor);
    return rows.length > 0;
  }

  async anonymizeAccount(userId: string, executor?: DrizzleExecutor) {
    await withDrizzleTransaction(async (transaction) => {
      await systemQuery('privacy_erasure', (queryExecutor) => queryExecutor
        .delete(members).where(eq(members.userId, userId)), transaction);
      await systemQuery('privacy_erasure', (queryExecutor) => queryExecutor
        .delete(userOauthTokens).where(eq(userOauthTokens.userId, userId)), transaction);
      await systemQuery('privacy_erasure', (queryExecutor) => queryExecutor
        .delete(oauthStates).where(eq(oauthStates.userId, userId)), transaction);
      await systemQuery('privacy_erasure', (queryExecutor) => queryExecutor.update(users).set({
        name: 'Deleted user',
        email: `deleted+${userId}${ERASED_ACCOUNT_EMAIL_DOMAIN}`,
        consentIp: null,
        photoObjectPath: null,
        // The row survives so that every `created_by` and `performed_by` naming
        // it stays resolvable, which migration 0224 turned into real foreign
        // keys. This column is what separates that tombstone from a live
        // account; without it the two are indistinguishable once the name and
        // email are masked.
        deletedAt: new Date(),
      }).where(eq(users.id, userId)), transaction);
    }, executor);
  }

  async markIdentityErased(userId: string) {
    await systemQuery('privacy_erasure', (executor) => executor.update(users)
      .set({ identityErasedAt: new Date() }).where(eq(users.id, userId)));
  }

  async pendingIdentityErasures() {
    return systemQuery('privacy_erasure', (executor) => executor
      .select({ id: users.id }).from(users)
      .where(and(isNotNull(users.deletedAt), sql`${users.identityErasedAt} is null`))
      .orderBy(asc(users.deletedAt)).limit(50));
  }
}

export = new UsersRepository();
