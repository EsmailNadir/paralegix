import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  clients,
  invitations,
  lawFirms,
  members,
  users,
} from '../../shared/database/drizzle/schema';
import {
  firmQuery,
  systemQuery,
  tenantQuery,
  tokenQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsertOnConflictDoNothing,
  scopedUpdate,
  scopedUpsert,
} from '../../shared/database/scopedWrite';
import { NotFoundError } from '../../shared/errors/AppError';
const { isUuid } = require('../../shared/utils/isUuid');

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;

function inviteEntity(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.lawFirmId,
    email: row.email,
    inviteType: row.inviteType,
    roleId: row.roleId,
    token: row.token,
    status: row.status,
    matterIds: row.matterIds || [],
    invitedBy: row.invitedBy,
    invitedAt: iso(row.invitedAt),
    invitationSentAt: iso(row.invitationSentAt),
    invitationEmail: row.invitationEmail,
    invitationFailed: row.invitationFailed,
    invitationResendCount: row.invitationResendCount || 0,
    expiresAt: iso(row.expiresAt),
    acceptedAt: iso(row.acceptedAt),
    acceptedBy: row.acceptedBy,
    clientId: row.clientId || null,
    contactClientId: row.contactClientId || null,
  };
}

const livePending = and(
  eq(invitations.status, 'pending'),
  or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
)!;

export async function findByToken(token: string, executor?: DrizzleExecutor) {
  const rows = await tokenQuery(token, (executor) => executor.select().from(invitations)
    .where(and(eq(invitations.token, token), livePending))
    .limit(1), executor);
  return inviteEntity(rows[0]);
}

export async function findByTokenAnyStatus(token: string, executor?: DrizzleExecutor) {
  const rows = await tokenQuery(token, (executor) => executor.select().from(invitations)
    .where(eq(invitations.token, token))
    .limit(1), executor);
  return inviteEntity(rows[0]);
}

/**
 * Pending, unexpired member invites addressed to this email, across every
 * firm, with the firm name joined in (see acceptMemberInviteByToken).
 */
export async function findPendingMemberInvitesByEmail(email: string) {
  const normalized = email.toLowerCase();
  const rows = await systemQuery('auth_identity', (executor) => executor
    .select({
      token: invitations.token,
      lawFirmId: invitations.lawFirmId,
      lawFirmName: lawFirms.name,
      invitedAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(lawFirms, eq(lawFirms.id, invitations.lawFirmId))
    .where(and(
      eq(sql`lower(${invitations.email}::text)`, normalized),
      eq(invitations.inviteType, 'member'),
      eq(invitations.status, 'pending'),
      or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
    )));
  return rows.map((r: any) => ({ ...r, invitedAt: iso(r.invitedAt) }));
}

export async function findByEmailType(lawFirmId: string, email: string, inviteType: string, executor?: DrizzleExecutor) {
  const rows = await tenantQuery(
    invitations,
    lawFirmId,
    ({ executor, scope }) => executor.select().from(invitations).where(and(
      scope,
      eq(sql`lower(${invitations.email}::text)`, email.toLowerCase()),
      eq(invitations.inviteType, inviteType),
      eq(invitations.status, 'pending'),
    )).limit(1),
    executor,
  );
  return inviteEntity(rows[0]);
}


/**
 * The pending invite for one exact target: a person-client invite
 * (clientId set, no roster link) or a company roster invite (clientId +
 * contactClientId both set). Unlike `findByEmailType`, this can't return the
 * wrong company's invite for a shared email, because the target identity is
 * part of the lookup rather than inferred from "the one pending row".
 */
export async function findByEmailTypeForTarget(
  lawFirmId: string,
  email: string,
  inviteType: string,
  { clientId = null, contactClientId = null }: { clientId?: string | null; contactClientId?: string | null } = {},
  executor?: DrizzleExecutor,
) {
  const conditions: SQL[] = [
    eq(sql`lower(${invitations.email}::text)`, email.toLowerCase()),
    eq(invitations.inviteType, inviteType),
    eq(invitations.status, 'pending'),
  ];
  conditions.push(clientId ? eq(invitations.clientId, clientId) : isNull(invitations.clientId));
  conditions.push(contactClientId ? eq(invitations.contactClientId, contactClientId) : isNull(invitations.contactClientId));
  const rows = await tenantQuery(
    invitations,
    lawFirmId,
    ({ executor, scope }) => executor.select().from(invitations).where(and(scope, ...conditions)).limit(1),
    executor,
  );
  return inviteEntity(rows[0]);
}

/**
 * The ON CONFLICT arbiter for `create()`'s upsert. The blanket
 * (law_firm_id, email, invite_type) unique constraint is gone (migration
 * 0170); each invite kind now dedupes against its own partial unique index
 * (status = 'pending'), so the target columns AND the predicate that names
 * the index must both be supplied - Postgres infers the arbiter from an
 * exact match of both.
 *
 * Person-client invites (contactClientId absent) target `client_id`. Today's
 * callers that create a client invite before a clients row is resolved pass
 * no clientId, so that column is null on insert; a null target column never
 * conflicts (Postgres never treats two NULLs as equal), so those inserts
 * always succeed as plain inserts - the application's pre-create existence
 * check remains the operative safeguard until a real clientId is threaded
 * through (targeted invitations, Phase 3 of the organization-clients plan).
 */
function conflictTargetFor(inviteType: string, contactClientId: string | null) {
  if (inviteType === 'member') {
    return {
      target: [invitations.lawFirmId, invitations.email],
      targetWhere: and(eq(invitations.inviteType, 'member'), eq(invitations.status, 'pending'))!,
    };
  }
  if (contactClientId) {
    return {
      target: [invitations.lawFirmId, invitations.contactClientId],
      targetWhere: and(
        eq(invitations.inviteType, 'client'),
        isNotNull(invitations.contactClientId),
        eq(invitations.status, 'pending'),
      )!,
    };
  }
  return {
    target: [invitations.lawFirmId, invitations.clientId],
    targetWhere: and(
      eq(invitations.inviteType, 'client'),
      isNull(invitations.contactClientId),
      eq(invitations.status, 'pending'),
    )!,
  };
}

export async function create(
  { lawFirmId, email, inviteType, roleId, token, matterIds, invitedBy, clientId, contactClientId }: any,
  executor?: DrizzleExecutor,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const resolvedClientId = isUuid(clientId) ? clientId : null;
  const resolvedContactClientId = isUuid(contactClientId) ? contactClientId : null;
  const values = {
    email,
    inviteType,
    roleId: isUuid(roleId) ? roleId : null,
    token,
    status: 'pending',
    matterIds: matterIds || null,
    invitedBy: invitedBy || null,
    invitedAt: now,
    expiresAt,
    acceptedAt: null,
    acceptedBy: null,
    clientId: resolvedClientId,
    contactClientId: resolvedContactClientId,
  };
  const { target, targetWhere } = conflictTargetFor(inviteType, resolvedContactClientId);
  const rows = await scopedUpsert(
    invitations,
    lawFirmId,
    values,
    target,
    // `updatedAt` is not set here: it is an immutable write key that the scoped
    // writer strips, and the `set_updated_at` trigger stamps it on every update.
    values,
    executor,
    targetWhere,
  );
  return inviteEntity(rows[0]);
}

/** Claim and join execute on the same Drizzle transaction/savepoint executor. */
export async function withInviteClaimTxn({ by, key, userId, join, onMissing, executor }: any) {
  return withDrizzleTransaction(async (transaction) => {
    const lookup = by === 'token'
      ? tokenQuery(key, (queryExecutor) => queryExecutor.select().from(invitations)
        .where(eq(invitations.token, key)).limit(1).for('update'), transaction)
      : systemQuery('auth_identity', (queryExecutor) => queryExecutor.select().from(invitations)
        .where(eq(invitations.id, key)).limit(1).for('update'), transaction);
    const [invite] = await lookup;
    const expired = invite?.expiresAt && invite.expiresAt.getTime() <= Date.now();
    if (!invite || invite.status !== 'pending' || expired) {
      if (onMissing) return onMissing();
      throw new NotFoundError('Invitation');
    }
    const claimed = await scopedUpdate(
      invitations,
      invite.lawFirmId,
      and(eq(invitations.id, invite.id), livePending)!,
      { status: 'accepted', acceptedAt: sql`now()`, acceptedBy: userId || null },
      transaction,
    );
    if (!claimed.length) {
      if (onMissing) return onMissing();
      throw new NotFoundError('Invitation');
    }
    return join(transaction);
  }, executor);
}

export async function markSent(id: string, { invitationEmail, invitationFailed }: any) {
  await systemQuery('auth_identity', (executor) => executor.update(invitations).set({
    invitationSentAt: sql`now()`,
    invitationEmail: invitationEmail || null,
    invitationFailed: Boolean(invitationFailed),
    updatedAt: sql`now()`,
  }).where(eq(invitations.id, id)));
}

export async function claimResendSlot(id: string, { maxResends = 10, cooldownHours = 24 } = {}) {
  if (!isUuid(id)) return null;
  const rows = await systemQuery('auth_identity', (executor) => executor.update(invitations).set({
    invitationSentAt: sql`now()`,
    invitationResendCount: sql`${invitations.invitationResendCount} + 1`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(invitations.id, id),
    eq(invitations.status, 'pending'),
    lt(invitations.invitationResendCount, maxResends),
    or(
      isNull(invitations.invitationSentAt),
      lt(invitations.invitationSentAt, sql`now() - (${String(cooldownHours)} || ' hours')::interval`),
    ),
  )).returning());
  return inviteEntity(rows[0]);
}

export async function claimClientResendSlot(
  lawFirmId: string,
  clientId: string,
  { maxResends = 10, cooldownHours = 24 } = {},
) {
  if (!isUuid(clientId) || !isUuid(lawFirmId)) return null;
  const rows = await scopedUpdate(
    clients,
    lawFirmId,
    and(
      eq(clients.id, clientId),
      lt(clients.invitationResendCount, maxResends),
      or(
        isNull(clients.lastResendAt),
        lt(clients.lastResendAt, sql`now() - (${String(cooldownHours)} || ' hours')::interval`),
      ),
    )!,
    {
      lastResendAt: sql`now()`,
      invitationSentAt: sql`now()`,
      invitationResendCount: sql`coalesce(${clients.invitationResendCount}, 0) + 1`,
    },
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    email: row.email,
    invitation_resend_count: row.invitationResendCount,
    invitation_sent_at: row.invitationSentAt,
    last_resend_at: row.lastResendAt,
  } : null;
}

export async function setInviteResendFailed(id: string, invitationFailed: unknown) {
  if (!isUuid(id)) return;
  await systemQuery('auth_identity', (executor) => executor.update(invitations)
    .set({ invitationFailed: Boolean(invitationFailed), updatedAt: sql`now()` })
    .where(eq(invitations.id, id)));
}

export async function setClientResendFailed(lawFirmId: string, clientId: string, invitationFailed: unknown) {
  if (!isUuid(clientId) || !isUuid(lawFirmId)) return;
  await scopedUpdate(clients, lawFirmId, eq(clients.id, clientId), {
    invitationFailed: Boolean(invitationFailed),
  });
}

export async function deleteById(id: string, executor?: DrizzleExecutor) {
  if (!id) return;
  await systemQuery('auth_identity', (executor) => executor.delete(invitations).where(eq(invitations.id, id)), executor);
}

export async function listPending(lawFirmId: string, inviteType: string) {
  const rows = await tenantQuery(
    invitations,
    lawFirmId,
    ({ executor, scope }) => executor.select().from(invitations).where(and(
      scope,
      eq(invitations.inviteType, inviteType),
      livePending,
    )).orderBy(desc(invitations.invitedAt)),
  );
  return rows.map(inviteEntity);
}

export async function findPendingByIdType(lawFirmId: string, id: string, inviteType: string) {
  if (!isUuid(id)) return null;
  const rows = await tenantQuery(
    invitations,
    lawFirmId,
    ({ executor, scope }) => executor.select().from(invitations).where(and(
      scope,
      eq(invitations.id, id),
      eq(invitations.inviteType, inviteType),
      livePending,
    )).limit(1),
  );
  return inviteEntity(rows[0]);
}

export async function expireStaleInvitations() {
  const rows = await systemQuery('scheduler', (executor) => executor.update(invitations)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(and(
      eq(invitations.status, 'pending'),
      isNotNull(invitations.expiresAt),
      lt(invitations.expiresAt, sql`now()`),
    )).returning({ id: invitations.id }));
  return rows.length;
}

export async function countMembersAndPendingMembers(lawFirmId: string, executor?: DrizzleExecutor) {
  const rows = await tenantQuery(
    members,
    lawFirmId,
    ({ executor, scope }) => executor.select({
      // The expiry half matters as much as the status half. A pending row past
      // its expiry is unredeemable (findByToken filters `livePending`, and the
      // claim transaction rejects an expired row), so counting it reserved a
      // seat for a token nobody can ever use. That reservation only cleared when
      // the housekeeping sweep flipped the row, and the sole scheduler job for
      // that sweep is staging-only, so in production the seat was held forever.
      //
      // Dropping it cannot let a firm exceed its paid seats: the cap is checked
      // again against REAL members inside the claim-and-join transaction and on
      // registration auto-accept. This count is a capacity reservation, and
      // reserving for a dead token is loss to the firm with nothing bought.
      total: sql<number>`count(*)::int + (
        select count(*)::int from ${invitations}
        where ${invitations.lawFirmId} = ${lawFirmId}
          and ${invitations.inviteType} = 'member' and ${invitations.status} = 'pending'
          and (${invitations.expiresAt} is null or ${invitations.expiresAt} > now())
      )`,
    }).from(members).where(scope),
    executor,
  );
  return rows[0]?.total || 0;
}

export async function countMembers(lawFirmId: string, executor?: DrizzleExecutor) {
  const rows = await tenantQuery(
    members,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select({ total: count() }).from(members).where(scope),
    executor,
  );
  return rows[0]?.total || 0;
}

/**
 * Serialize concurrent seat-limit checks for one firm's member count.
 *
 * Counting members and inserting the new one are two separate statements
 * inside `acceptMemberInviteByToken`'s join. Without a lock spanning both, two
 * transactions accepting DIFFERENT invitations to the same firm's last open
 * seat can each run their count before either commits its insert; each sees
 * the seat as free, and both succeed, over-provisioning the firm's plan. The
 * per-token row lock in `withInviteClaimTxn` does not help here because it
 * locks each invitation's OWN row, and the two invitations are different rows.
 *
 * Locking the firm's own row gives every concurrent accept for that firm one
 * shared point of contention: the second transaction blocks here until the
 * first commits (or rolls back), and by the time it proceeds, its own count
 * (run on the same executor, so it gets a fresh read-committed snapshot)
 * sees the first transaction's already-committed insert.
 */
export async function lockFirmForSeatCheck(lawFirmId: string, executor: DrizzleExecutor) {
  await firmQuery(
    lawFirms,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor
      .select({ id: lawFirms.id }).from(lawFirms).where(scope).for('update'),
    executor,
  );
}

export async function lawFirmExists(lawFirmId: string) {
  if (!isUuid(lawFirmId)) return false;
  const rows = await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
    .select({ id: lawFirms.id }).from(lawFirms).where(scope).limit(1));
  return rows.length > 0;
}

export async function getLawFirmName(lawFirmId: string) {
  if (!isUuid(lawFirmId)) return 'Your Law Firm';
  const rows = await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
    .select({ name: lawFirms.name }).from(lawFirms).where(scope).limit(1));
  return rows[0]?.name || 'Your Law Firm';
}

export async function getInviterName(userId: string) {
  const rows = await systemQuery('auth_identity', (executor) => executor
    .select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1));
  return rows[0]?.name || null;
}

export async function findUserByEmail(email: string) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return null;
  const rows = await systemQuery('auth_identity', (executor) => executor.select({
    uid: users.id, name: users.name, email: users.email, userType: users.userType,
  }).from(users).where(eq(sql`lower(${users.email}::text)`, normalized)).limit(1));
  return rows[0] || null;
}

export async function getUserById(userId: string) {
  const rows = await systemQuery('auth_identity', (executor) => executor.select({
    uid: users.id, name: users.name, email: users.email, userType: users.userType,
  }).from(users).where(eq(users.id, userId)).limit(1));
  return rows[0] || null;
}

export async function getUserFirmIds(userId: string, executor?: DrizzleExecutor) {
  const rows = await systemQuery('auth_identity', (queryExecutor) => queryExecutor
    .select({ lawFirmId: members.lawFirmId }).from(members).where(eq(members.userId, userId)), executor);
  return rows.map((row) => row.lawFirmId);
}

export async function isMember(lawFirmId: string, userId: string, executor?: DrizzleExecutor) {
  const rows = await tenantQuery(
    members,
    lawFirmId,
    ({ executor: queryExecutor, scope }) => queryExecutor.select({ userId: members.userId })
      .from(members).where(and(scope, eq(members.userId, userId))).limit(1),
    executor,
  );
  return rows.length > 0;
}

export async function addMember(
  lawFirmId: string,
  { userId, roleId, invitedBy, invitedAt }: any,
  executor?: DrizzleExecutor,
) {
  await scopedInsertOnConflictDoNothing(
    members,
    lawFirmId,
    {
      userId,
      roleId: isUuid(roleId) ? roleId : null,
      invitedAt: invitedAt
        ? (invitedAt instanceof Date ? invitedAt : new Date(invitedAt))
        : (sql`now()` as any),
      invitedBy: invitedBy || null,
      joinedAt: sql`now()` as any,
    },
    [members.lawFirmId, members.userId],
    executor,
  );
}

export async function isMemberByEmail(lawFirmId: string, email: string) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !isUuid(lawFirmId)) return false;
  const rows = await tenantQuery(
    members,
    lawFirmId,
    ({ executor, scope }) => executor.select({ userId: members.userId }).from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(scope, eq(sql`lower(${users.email}::text)`, normalized))).limit(1),
  );
  return rows.length > 0;
}

export async function isClientLinkedByEmail(lawFirmId: string, email: string) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !isUuid(lawFirmId)) return false;
  const rows = await tenantQuery(
    clients,
    lawFirmId,
    ({ executor, scope }) => executor.select({ id: clients.id }).from(clients).where(and(
      scope,
      eq(sql`lower(${clients.email}::text)`, normalized),
      isNotNull(clients.userId),
    )).limit(1),
  );
  return rows.length > 0;
}

export async function revokePendingById(lawFirmId: string, id: string, inviteType: string, executor?: DrizzleExecutor) {
  if (!isUuid(id) || !isUuid(lawFirmId)) return null;
  const rows = await scopedUpdate(invitations, lawFirmId, and(
    eq(invitations.id, id),
    eq(invitations.inviteType, inviteType),
    eq(invitations.status, 'pending'),
  )!, { status: 'revoked' }, executor);
  return inviteEntity(rows[0]);
}

const clientInviteSelection = {
  id: clients.id,
  user_id: clients.userId,
  email: clients.email,
  name: clients.name,
  invitation_sent_at: clients.invitationSentAt,
  invitation_resend_count: clients.invitationResendCount,
};

/**
 * The PERSON client row carrying this email, for the portal-invite paths.
 *
 * Person rows only. A company holds its contact address in the same column, but
 * a company has no portal identity of its own (its people do), so it is never a
 * valid invite target: matching one here wrote invite metadata onto the
 * organization's record and stood in for the invitee's own placeholder.
 */
export async function findClientByEmail(lawFirmId: string, email: string, executor?: DrizzleExecutor) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return null;
  const rows = await tenantQuery(
    clients,
    lawFirmId,
    ({ executor, scope }) => executor.select(clientInviteSelection).from(clients)
      .where(and(
        scope,
        eq(sql`lower(${clients.email}::text)`, normalized),
        eq(clients.clientType, 'person'),
      )).limit(1),
    executor,
  );
  return rows[0] || null;
}

export async function findClientById(lawFirmId: string, clientId: string) {
  if (!isUuid(clientId)) return null;
  const rows = await tenantQuery(
    clients,
    lawFirmId,
    ({ executor, scope }) => executor.select(clientInviteSelection).from(clients)
      .where(and(scope, eq(clients.id, clientId))).limit(1),
  );
  return rows[0] || null;
}

export async function updateClientInviteMeta(lawFirmId: string, clientId: string, patch: any, executor?: DrizzleExecutor) {
  const values: Record<string, unknown> = { invitationSentAt: sql`now()` };
  if (patch.invitationEmail !== undefined) values.invitationEmail = patch.invitationEmail;
  if (patch.invitationFailed !== undefined) values.invitationFailed = Boolean(patch.invitationFailed);
  if (patch.portalInvitePending !== undefined) values.portalInvitePending = Boolean(patch.portalInvitePending);
  if (patch.bumpResend) values.invitationResendCount = sql`${clients.invitationResendCount} + 1`;
  await scopedUpdate(clients, lawFirmId, eq(clients.id, clientId), values, executor);
}
