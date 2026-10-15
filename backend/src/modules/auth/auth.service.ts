import { and, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  invitations,
  members,
  oauthStates,
  userOauthTokens,
  users,
} from '../../shared/database/drizzle/schema';
import { systemQuery, tokenQuery, withDrizzleTransaction, type DrizzleExecutor } from '../../shared/database/queryContext';
import { scopedUpdate } from '../../shared/database/scopedWrite';
import type { TransactionEffects } from '../../shared/database/transactionEffects';
import { withLock } from '../../shared/database/advisoryLock';
import {
  CalendarConnectError,
  GOOGLE_REQUESTED_SCOPES,
  MICROSOFT_REQUESTED_SCOPES,
  accountFromIdToken,
  grantedScopes,
  hasRequiredScope,
  type CalendarConnectErrorCode,
  type CalendarProvider,
  type ProviderAccount,
} from '../calendar/shared/calendarGrant';
const crypto = require('crypto');
// Firebase Auth (auth) is retained as the identity source; Firestore is gone.
// all profile/token/settings data now lives in Postgres.
const { auth } = require('../../shared/database/firebase');
const calendarTokens = require('../calendar/shared/calendarTokens');
const { refreshGrant, withRefreshLock, invalidateUserData } = require('../calendar/shared/calendarHelpers');
const calendarEventsRepo = require('../calendar/calendarEvents.repository');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { canUserJoinMoreFirms } = require('../../shared/plans/userLimits');
const { getEffectiveLimits, UNLIMITED } = require('../../shared/plans/planDefinitions');
const { linkClientIdentityToFirm } = require('../clients/clientIdentityLinking.service');
const messagingRepo = require('../messaging/messaging.repository');
const usersRepository = require('../users/users.repository');
const lawfirmsRepository = require('../lawfirms/lawfirms.repository');
const invitationsRepository = require('../invitations/invitations.repository');
const { recordAudit } = require('../audit/audit.service');
const eventBus = require('../../shared/events/eventBus');
const { MEMBER_ADDED } = require('../../shared/events/eventTypes');
const { lookupLocation } = require('../../shared/utils/geoip');

function normalizeUrl(value: any) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/**
 * Deliberately NOT the shared `shared/utils/normalizeEmail`. That one returns
 * null for a falsy or non-string input; this one returns ''. The three client-side
 * copies were consolidated into the shared helper and this was left alone, because
 * flipping '' to null here changes what a missing email compares equal to inside
 * authentication code for no gain beyond deleting three lines.
 */
function normalizeEmail(value: any) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizeReturnUrl(returnUrl: any) {
  const frontendUrl = normalizeUrl(process.env.FRONTEND_URL || 'http://localhost:3000');
  if (!returnUrl) return null;

  try {
    if (returnUrl.startsWith('/')) {
      return `${frontendUrl}${returnUrl}`;
    }

    const parsed = new URL(returnUrl);
    if (normalizeUrl(parsed.origin) !== frontendUrl) {
      return `${frontendUrl}/dashboard`;
    }

    return parsed.toString();
  } catch {
    return `${frontendUrl}/dashboard`;
  }
}

/**
 * Verify a Firebase ID token. Passes checkRevoked:true (matching the request
 * middleware) so a revoked session ("sign out everywhere") or a disabled account
 * is rejected here too. These service-layer verifies gate body-token endpoints
 * (login, complete-registration, check-user-exists, refresh-microsoft-token) that
 * bypass the middleware; without the flag a leaked-but-revoked token would still
 * mint a fresh Microsoft OAuth token / return the victim's profile until the ID
 * token's own ~1h expiry.
 */
async function verifyIdToken(token: any) {
  return auth.verifyIdToken(token, true);
}

// ── Users table helpers (Postgres) ────────────────────────────────────────

/**
 * Upsert a row in the `users` table (id = Firebase UID). Only the columns that
 * exist on the relational `users` table are persisted: id, email, name,
 * user_type. The old Firestore-only fields (provider, uid, lawFirmIds[],
 * clientLawFirmIds[], created/updated timestamps, OAuth tokens) are gone.
 * memberships live in `members`/`clients`, tokens in `user_oauth_tokens`.
 *
 * Returns the resulting users row in camelCase (usersRepository shape).
 */
async function upsertUserRow({ uid, email, name, userType }: any) {
  const rows = await systemQuery('auth_identity', (executor) => executor.insert(users).values({
    id: uid,
    email: email || null,
    name: name || null,
    userType: userType || 'pending',
  } as any).onConflictDoUpdate({
    target: users.id,
    set: {
      email: sql`coalesce(excluded.email, ${users.email})`,
      name: sql`coalesce(excluded.name, ${users.name})`,
      userType: userType ? userType : sql`${users.userType}`,
      updatedAt: sql`now()`,
    },
  }).returning({ id: users.id }));
  return usersRepository.findById(rows[0].id);
}

// ── Invite processing ────────────────────────────────────────────────────

/**
 * Auto-process accept: claim a pending invite BY ID and run its join in ONE
 * transaction. Thin wrapper over the shared invitationsRepository.withInviteClaimTxn
 * (the single source of truth for the begin/guarded-claim/join/commit/rollback/
 * release shell, shared with the token-based accept path in the invitations
 * service). The guarded pending→accepted claim runs first (0 rows → already
 * consumed by a concurrent accept → onMissing returns false → rollback, no join);
 * on a successful claim, `join(client)` runs on the SAME client and the txn commits.
 *
 * @returns {Promise<boolean>} true if this run claimed + joined, false if the
 *   invite was already consumed (so the caller can `continue`).
 */
function claimAndJoinInviteById(inviteId: any, userId: string, join: any, executor?: DrizzleExecutor) {
  return invitationsRepository.withInviteClaimTxn({
    by: 'id',
    key: inviteId,
    userId,
    join: async (client: any) => { await join(client); return true; },
    onMissing: () => false,
    executor,
  });
}

/**
 * Process pending member invitations for a freshly-registered user, looked up
 * by email across all firms. Replaces the old Firestore full-scan of every
 * firm's `pendingInvites` subcollection. The unified `invitations` table is
 * queried directly by email + invite_type.
 */
async function checkAndProcessMemberInvites(email: any, userId: string) {
  try {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const invites = await systemQuery('auth_identity', (executor) => executor
      .select()
      .from(invitations)
      .where(and(
        eq(sql`lower(${invitations.email}::text)`, normalizedEmail),
        eq(invitations.inviteType, 'member'),
        eq(invitations.status, 'pending'),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
      )));
    if (!invites.length) return;

    // Batch reads cheaply filter candidates; transactional reads below decide each join.
    let firmIds = await usersRepository.getLawFirmIdsForUser(userId);
    const firmIdSet = new Set(firmIds);

    // ── Batch the per-firm member-count read for the candidate firms (those the
    // user is NOT already in) in ONE query, instead of one count per invite.
    const candidateFirmIds = [
      ...new Set(invites.map((invite: any) => invite.lawFirmId).filter((id: any) => !firmIdSet.has(id))),
    ];
    const memberCounts = new Map();
    if (candidateFirmIds.length) {
      const counts = await systemQuery('auth_identity', (executor) => executor.select({
        lawFirmId: members.lawFirmId,
        total: count(),
      }).from(members).where(inArray(members.lawFirmId, candidateFirmIds)).groupBy(members.lawFirmId));
      for (const row of counts) memberCounts.set(row.lawFirmId, row.total);
    }

    const noSeatAvailable = new Error('Invitation cannot currently be joined');
    for (const invite of invites) {
      try {
        const lawFirmId = invite.lawFirmId;

        // Already a member? Nothing to do. Mark the stale invite accepted
        // (guarded on pending so a concurrent accept can't double-process).
        if (firmIdSet.has(lawFirmId)) {
          await scopedUpdate(invitations, lawFirmId, and(
            eq(invitations.id, invite.id),
            eq(invitations.status, 'pending'),
            or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
          )!, {
            status: 'accepted',
            acceptedAt: sql`now()`,
            acceptedBy: userId,
          });
          continue;
        }

        // Per-user firm membership cap (based on the hoisted firm-id set, which
        // we extend below as joins succeed so multiple invites in one pass still
        // respect the cap).
        if (!canUserJoinMoreFirms({ lawFirmIds: firmIds })) {
          continue; // silently skip: pending invite stays for later
        }

        // Per-firm member capacity. Firm load stays per-firm (no batch findById),
        // but the count is served from the batched map (0 if no members yet).
        const firm = await lawfirmsRepository.findById(lawFirmId);
        if (!firm) continue;
        const limits = getEffectiveLimits(firm);
        if (limits.maxMembers !== UNLIMITED) {
          const memberCount = memberCounts.get(lawFirmId) || 0;
          if (memberCount >= limits.maxMembers) {
            continue; // firm at capacity: skip, invite stays
          }
        }

        // Claim + join must be atomic (see claimAndJoinInviteById): the guarded
        // pending→accepted flip and the membership insert share ONE transaction
        // so a failure rolls the claim back (otherwise the invite is stranded
        // 'accepted' with no membership and idempotency blocks any retry).
        const joined = await withDrizzleTransaction(async (executor) => {
          await usersRepository.lockForMembershipChange(userId, executor);
          const currentFirmIds = await usersRepository.getLawFirmIdsForUser(userId, executor);
          if (currentFirmIds.includes(lawFirmId)) {
            await claimAndJoinInviteById(invite.id, userId, async () => {}, executor);
            return false;
          }
          if (!canUserJoinMoreFirms({ lawFirmIds: currentFirmIds })) return false;
          return claimAndJoinInviteById(invite.id, userId, async (joinExecutor: DrizzleExecutor) => {
            await invitationsRepository.lockFirmForSeatCheck(lawFirmId, joinExecutor);
            const currentFirm = await lawfirmsRepository.findById(lawFirmId, joinExecutor);
            if (!currentFirm || currentFirm.pendingDeletionAt) throw noSeatAvailable;
            const currentLimits = getEffectiveLimits(currentFirm);
            if (currentLimits.maxMembers !== UNLIMITED &&
              await invitationsRepository.countMembers(lawFirmId, joinExecutor) >= currentLimits.maxMembers) {
              throw noSeatAvailable;
            }
            await invitationsRepository.addMember(lawFirmId, {
              userId,
              roleId: invite.roleId || null,
              invitedBy: invite.invitedBy || null,
              invitedAt: invite.invitedAt || null,
            }, joinExecutor);
          }, executor);
        });
        // NOTE: no users.lawFirmIds arrayUnion. Membership is owned by the
        // `members` table now, so that maintenance is obsolete.
        if (!joined) continue; // already consumed by a concurrent accept
        // Emitted after the claim+join transaction has committed, so the
        // listeners (which write outside it) never act on a rolled-back join.
        eventBus.emit(MEMBER_ADDED, { lawFirmId, userId });

        // Keep the hoisted in-memory state consistent so later invites in this
        // same pass still respect the per-user cap and per-firm capacity
        // without re-querying: this firm is now joined (+1 to its count).
        firmIds = [...firmIds, lawFirmId];
        firmIdSet.add(lawFirmId);
        memberCounts.set(lawFirmId, (memberCounts.get(lawFirmId) || 0) + 1);
      } catch (firmErr) {
        if (firmErr === noSeatAvailable) continue;
        console.error(`auth.service: error processing member invite ${invite.id}:`, firmErr);
      }
    }
  } catch (err: any) {
    console.error('auth.service: error processing member invites:', err);
  }
}

/**
 * Process pending client invitations for a freshly-registered client user,
 * looked up by email across all firms. Replaces the old Firestore full-scan of
 * every firm's `pendingClientInvites` subcollection (+ general pendingInvites
 * with inviteType 'client'). The unified `invitations` table is queried by
 * email + invite_type='client'; linking goes through linkClientIdentityToFirm.
 */
async function checkAndProcessClientInvites(email: any, userId: string) {
  try {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const invites = await systemQuery('auth_identity', (executor) => executor
      .select()
      .from(invitations)
      .where(and(
        eq(sql`lower(${invitations.email}::text)`, normalizedEmail),
        eq(invitations.inviteType, 'client'),
        eq(invitations.status, 'pending'),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
      )));

    for (const invite of invites) {
      try {
        // Claim + join must be atomic (see claimAndJoinInviteById): the guarded
        // pending→accepted flip and the client identity link share ONE
        // transaction so a failure rolls the claim back (otherwise the invite is
        // stranded 'accepted' with no link and idempotency blocks any retry).
        // linkClientIdentityToFirm honors the passed-in client (no nested
        // begin/commit). The unified invitations row IS the token now. No
        // separate inviteTokens collection to clean up (obsolete).
        await claimAndJoinInviteById(invite.id, userId, (client: any) => linkClientIdentityToFirm({
          lawFirmId: invite.lawFirmId,
          userId,
          email: normalizedEmail,
          invitedBy: invite.invitedBy || null,
          matterIds: invite.matterIds || [],
          client,
        }));
      } catch (inviteErr) {
        console.error(`auth.service: error processing client invite ${invite.id}:`, inviteErr);
      }
    }
  } catch (err: any) {
    console.error('auth.service: error processing client invites:', err);
  }
}

// ── Email / Name extraction helpers ──────────────────────────────────────

/**
 * Resolve a real email for the user from the token / Firebase record / provider
 * data. Returns null when NO genuine email can be found. Callers must NOT
 * fabricate a placeholder for invite matching (a synthetic address can never
 * match a real invite, and persisting a fake email is misleading).
 */
function extractEmail(decodedToken: any, userRecord: any) {
  let email = decodedToken.email || userRecord.email;
  if (!email && userRecord.providerData) {
    const ms = userRecord.providerData.find((p: any) => p.providerId === 'microsoft.com');
    const g = userRecord.providerData.find((p: any) => p.providerId === 'google.com');
    if (ms?.email) email = ms.email;
    else if (g?.email) email = g.email;
  }
  return email || null;
}

/**
 * `users.email` is `citext NOT NULL`, so a user with no resolvable provider
 * email still needs SOMETHING persisted. Use a clearly-marked, uid-scoped
 * sentinel (visibly not a real address) ONLY for the row write, never for
 * invite-email matching. Surfaces the situation in the logs instead of silently
 * writing a fake address.
 */
function emailForUserRow(email: any, uid: string) {
  if (email) return email;
  console.warn(`auth.service: no provider email for uid ${uid}; storing sentinel email (no invites will be matched)`);
  return `no-email+${uid}@users.noreply.paralegix`;
}

function extractName(decodedToken: any, userRecord: any, email: any) {
  let name = userRecord.displayName || decodedToken.name;
  if (!name && userRecord.providerData) {
    const ms = userRecord.providerData.find((p: any) => p.providerId === 'microsoft.com');
    const g = userRecord.providerData.find((p: any) => p.providerId === 'google.com');
    if (ms?.displayName) name = ms.displayName;
    else if (g?.displayName) name = g.displayName;
  }
  return name || (email ? email.split('@')[0] : 'Unknown User');
}

// ── Endpoints ────────────────────────────────────────────────────────────

/**
 * Check if an OAuth user exists and needs registration.
 */
export async function checkUserExists({ body }: any) {
  const decoded = await verifyIdToken(body.token);
  const data = await usersRepository.findById(decoded.uid);

  if (!data) {
    return { exists: false, needsRegistration: true, uid: decoded.uid, email: decoded.email };
  }

  if (!data.userType || data.userType === 'pending') {
    return { exists: true, needsRegistration: true, uid: decoded.uid, email: data.email };
  }

  return { exists: true, needsRegistration: false, userType: data.userType, userData: data };
}

/**
 * Complete OAuth registration (set userType, process invites).
 *
 * Provider access tokens a client still posts here are ignored: social sign-in
 * is identity only, and a calendar is connected through the server-side code
 * flow (`connect-google` / `connect-microsoft`) alone.
 */
export async function completeRegistration({ body }: any) {
  const { token, userType } = body;

  const decoded = await verifyIdToken(token);
  const existing = await usersRepository.findById(decoded.uid);
  const userRecord = await auth.getUser(decoded.uid);

  const email = extractEmail(decoded, userRecord);
  const name = extractName(decoded, userRecord, email);

  // userType is immutable identity once set (only 'pending' may be resolved to a
  // real type). Downstream type-gated surfaces (portal, messaging, signing) trust
  // the stored value, so a self-service flip (e.g. client -> firm_member by
  // re-running registration) is rejected, not just logged.
  if (existing && existing.userType && existing.userType !== userType && existing.userType !== 'pending') {
    throw new ValidationError({
      userType: [`Account type is already set to ${existing.userType} and cannot be changed`],
    });
  }

  // Upsert the relational users row. Membership arrays are obsolete. Firm/client
  // associations are owned by the members/clients tables. A sentinel is used for
  // the NOT NULL email column ONLY when no real email exists.
  await upsertUserRow({ uid: decoded.uid, email: emailForUserRow(email, decoded.uid), name, userType });

  // Process pending invites — only for a verified email (proven ownership) so an
  // invite can't be claimed by an account registered for someone else's address.
  if (userRecord.emailVerified) {
    if (userType === 'client') {
      await checkAndProcessClientInvites(email, decoded.uid);
      await messagingRepo.reconcilePendingClientRecipientsForUser(decoded.uid);
    } else {
      await checkAndProcessMemberInvites(email, decoded.uid);
    }
  }

  const updated = await usersRepository.findById(decoded.uid);
  return { message: 'Registration completed successfully', userData: updated };
}

/**
 * Record a successful-login audit event into the shared audit log. Best-effort:
 * mirrors recordAudit's fire-and-forget contract and never throws into the login
 * flow. Emits one event per firm the user belongs to, so each firm's audit log
 * reflects the login; falls back to a single firm-less event for users with no
 * membership yet (new/pending users and client-portal-only users). Location is
 * derived from the source IP via the offline geo database.
 */
async function recordLoginEvent({ uid, email, provider, needsRegistration, ip, userAgent }: any) {
  try {
    const location = await lookupLocation(ip);
    const metadata: any = { provider: provider || null, needsRegistration: !!needsRegistration };
    if (location) metadata.location = location;

    let firmIds = [];
    try {
      firmIds = await usersRepository.getLawFirmIdsForUser(uid);
    } catch (err: any) {
      console.error('auth.service recordLoginEvent: failed to resolve firms:', err);
    }

    const base = {
      actorUid: uid,
      actorEmail: email || null,
      action: 'auth.login',
      resourceType: 'auth',
      resourceId: uid,
      method: 'POST',
      path: '/api/auth/login',
      statusCode: 200,
      ip: ip || null,
      userAgent: userAgent || null,
      metadata,
    };

    if (firmIds.length === 0) {
      await recordAudit({ ...base, lawFirmId: null });
      return;
    }
    for (const lawFirmId of firmIds) {
      await recordAudit({ ...base, lawFirmId });
    }
  } catch (err: any) {
    console.error('auth.service recordLoginEvent failed:', err);
  }
}

/**
 * Login: handle OAuth / email login (create pending user if new).
 *
 * Provider access tokens a client still posts here are ignored, for the same
 * reason as in completeRegistration: a sign-in never creates, overwrites or
 * marks a calendar connection.
 */
export async function login({ body, ip, userAgent }: any = {}) {
  const { token } = body;

  const decoded = await verifyIdToken(token);
  const existing = await usersRepository.findById(decoded.uid);

  // Record the successful authentication for the security audit trail. Fire-and-
  // forget: recordLoginEvent is self-contained best-effort and must not add
  // latency to or fail the login. `needsRegistration` mirrors the branches below.
  recordLoginEvent({
    uid: decoded.uid,
    email: decoded.email || (existing && existing.email) || null,
    provider: (decoded.firebase && decoded.firebase.sign_in_provider) || null,
    needsRegistration: !existing || !existing.userType || existing.userType === 'pending',
    ip,
    userAgent,
  });

  if (!existing) {
    // New OAuth user: create with pending status
    const userRecord = await auth.getUser(decoded.uid);
    const email = extractEmail(decoded, userRecord);
    const name = extractName(decoded, userRecord, email);

    const userData = await upsertUserRow({ uid: decoded.uid, email: emailForUserRow(email, decoded.uid), name, userType: 'pending' });
    return { message: 'User created - registration pending', userData, needsRegistration: true };
  }

  // User exists

  if (!existing.userType || existing.userType === 'pending') {
    return {
      message: 'User needs to complete registration',
      userData: existing,
      needsRegistration: true,
    };
  }

  return { message: 'User authenticated successfully', userData: existing, needsRegistration: false };
}

/**
 * Create / update user for email+password registration.
 */
export async function createUser({ userId, authEmail, body }: any) {
  const { email, name, userType } = body;
  const normalizedRequestedEmail = normalizeEmail(email);
  const userRecord = await auth.getUser(userId);
  const normalizedAuthEmail = normalizeEmail(authEmail || userRecord.email);

  if (!normalizedRequestedEmail || normalizedRequestedEmail !== normalizedAuthEmail) {
    throw new ValidationError({
      email: ['Authenticated user does not match requested email'],
    });
  }

  const existing = await usersRepository.findById(userRecord.uid);

  // userType is immutable once set (only 'pending' may be resolved). Reject a
  // self-service type flip rather than logging and overwriting it, mirroring
  // completeRegistration.
  if (existing && existing.userType && existing.userType !== userType && existing.userType !== 'pending') {
    throw new ValidationError({
      userType: [`Account type is already set to ${existing.userType} and cannot be changed`],
    });
  }

  await upsertUserRow({
    uid: userRecord.uid,
    email: normalizedAuthEmail,
    name: name || userRecord.displayName || '',
    userType,
  });

  // Only claim pending invites once the email is verified (proven ownership).
  // Email/password signup does not prove ownership of the address, so consuming
  // an invite here would let anyone who knows an invited email hijack the invite
  // and its plan slot. Unverified users claim via the explicit token-accept flow
  // (which is verified + email-matched) after verifying.
  if (userRecord.emailVerified) {
    if (userType === 'client') {
      await checkAndProcessClientInvites(normalizedAuthEmail, userRecord.uid);
      await messagingRepo.reconcilePendingClientRecipientsForUser(userRecord.uid);
    } else {
      await checkAndProcessMemberInvites(normalizedAuthEmail, userRecord.uid);
    }
  }

  return { message: 'User data stored successfully', userId: userRecord.uid };
}

/**
 * Get user's type and registration status.
 */
export async function getUserType({ userId }: any) {
  const data = await usersRepository.findById(userId);
  if (!data) throw new NotFoundError('User');
  return {
    userType: data.userType || 'pending',
    needsRegistration: !data.userType || data.userType === 'pending',
  };
}

// ── Microsoft / Google token management ──────────────────────────────────

async function getProviderToken(userId: string, provider: any) {
  const rows = await systemQuery('auth_identity', (executor) => executor.select({
    access_token: userOauthTokens.accessToken,
    refresh_token: userOauthTokens.refreshToken,
    token_updated_at: userOauthTokens.tokenUpdatedAt,
  }).from(userOauthTokens).where(and(
    eq(userOauthTokens.userId, userId),
    eq(userOauthTokens.provider, provider),
  )).limit(1));
  return rows[0] || null;
}

export async function checkMicrosoft({ userId }: any) {
  const tok = await getProviderToken(userId, 'microsoft');
  return {
    hasMicrosoftToken: !!tok?.access_token,
    tokenUpdatedAt: tok?.token_updated_at || null,
  };
}

/** The code a failed call carries, for a log line that never echoes its message. */
function errorCode(err: any) {
  return err?.cause?.code ?? err?.code ?? 'unknown';
}

/**
 * End a Google grant at Google, so the person's account stops listing
 * Paralegix as holding calendar access. Revoking the refresh token ends the
 * whole grant. Best-effort: a refusal or an unreachable Google is logged and the
 * disconnect carries on, because the local row is removed either way.
 */
async function revokeGoogleToken(token: string) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) console.warn('auth.service: Google revoke answered', response.status);
  } catch (err: any) {
    console.warn('auth.service: Google revoke failed:', errorCode(err));
  }
}

/** The tokens a stored row holds, in the shape the stop calls read. */
function credentialsOf(provider: CalendarProvider, row: any) {
  return provider === 'google'
    ? { googleAccessToken: row.access_token || null, googleRefreshToken: row.refresh_token || null }
    : { microsoftAccessToken: row.access_token || null, microsoftRefreshToken: row.refresh_token || null };
}

/** True when a row holds a token, as opposed to sync choices made before connecting. */
function holdsToken(row: any) {
  return !!(row?.access_token || row?.refresh_token);
}

/**
 * Hold the refresh lock, run `work` in one transaction, then run what it
 * deferred. The provider calls run after the lock is released, because a stop
 * that meets an expired token refreshes, and that refresh takes the same lock.
 */
async function underConnectionLock<T>(
  provider: CalendarProvider, userId: string, work: (context: TransactionEffects) => Promise<T>,
): Promise<T> {
  const effects: Array<() => Promise<void>> = [];
  const result = await withRefreshLock(provider, userId, () => withDrizzleTransaction((executor) => work({
    executor,
    defer: (effect) => { effects.push(async () => { await effect(); }); },
  })));
  invalidateUserData(userId);
  for (const effect of effects) await effect();
  return result;
}

/**
 * Keep exchanges and revocations ordered across connection changes. This lease
 * is separate from refresh because stopping a subscription can refresh its
 * captured credentials after the connection transaction commits.
 */
function withConnectionLifecycle<T>(provider: CalendarProvider, userId: string, work: () => Promise<T>) {
  return withLock('CALENDAR_CONNECTION', `${provider}:${userId}`, work, {
    lockTimeoutMs: 10_000,
    maxHoldMs: 10 * 60 * 1000,
  });
}

/**
 * Remove what one provider connection left behind, inside the caller's
 * transaction: the token row with its sync cursor, calendar ids and direction
 * flags, the events imported from it, and (Google) the connected address. The
 * provider calls that end it are deferred to after the commit, with the
 * credentials captured from `row` because the row is gone by then: the live
 * watch channel or subscription is stopped, and when `revoke` is set the
 * Google grant is revoked. Microsoft has no per-app revoke for delegated
 * tokens, so deleting the row is all there is.
 *
 * Shared by disconnect and by a reconnect to a different provider account, which
 * must not inherit the old account's cursor, calendars or imports.
 */
async function forgetConnectionRows(
  provider: CalendarProvider, userId: string, row: any, { executor, defer }: TransactionEffects, { revoke }: { revoke: boolean },
) {
  const credentials = row ? credentialsOf(provider, row) : undefined;
  if (provider === 'microsoft') {
    await calendarTokens.deleteTokens(userId, 'microsoft', executor);
    await calendarEventsRepo.forgetProviderImports(userId, 'outlook', executor);
    defer(async () => {
      try {
        const { stopAllSubscriptions } = require('../calendar/outlook/outlook.service');
        await stopAllSubscriptions(userId, { credentials });
      } catch (err: any) {
        console.error('auth.service: failed to stop Outlook subscriptions for a forgotten connection:', errorCode(err));
      }
    });
    return;
  }

  await calendarTokens.deleteTokens(userId, 'google', executor);
  await calendarEventsRepo.forgetProviderImports(userId, 'google', executor);
  await calendarTokens.saveSettings(userId, { googleConnectedEmail: null }, executor);
  defer(async () => {
    try {
      const { stopAllWatchChannels } = require('../calendar/google/google.service');
      await stopAllWatchChannels(userId, { credentials });
    } catch (err: any) {
      console.error('auth.service: failed to stop watch channels for a forgotten connection:', errorCode(err));
    }
  });
  const token = row?.refresh_token || row?.access_token;
  if (revoke && token) defer(() => revokeGoogleToken(token));
}

/** Disconnect one provider: forget the connection and revoke the grant. */
async function forgetProviderConnection(userId: string, provider: CalendarProvider) {
  await underConnectionLock(provider, userId, async (context) => {
    const row = await calendarTokens.getConnectionRow(userId, provider, context.executor);
    await forgetConnectionRows(provider, userId, row, context, { revoke: true });
  });
}

async function removeProviderCopies(userId: string, provider: CalendarProvider) {
  const calendarProvider = provider === 'google' ? 'google' : 'outlook';
  const repo = require('../calendar/shared/calendarSync.repository');
  const resolver = require('../calendar/shared/calendarEntityResolver');
  const { getAdapter } = require('../calendar/shared/calendarAdapters');
  const service = provider === 'google' ? require('../calendar/google/google.service') : require('../calendar/outlook/outlook.service');
  let afterId = '';
  for (;;) {
    const mappings = await repo.listMappingsForUser(calendarProvider, userId, afterId);
    if (!mappings.length) return;
    for (const mapping of mappings) {
      const entity = resolver.resolveFromMapping(mapping);
      const state = entity ? await entity.getState() : null;
      const reference = { lawFirmId: mapping.lawFirmId, id: mapping.entityId,
        matterId: mapping.entityType === 'matterEvent' ? mapping.scopeId : undefined,
        clientId: mapping.entityType === 'clientEvent' ? mapping.scopeId : undefined };
      const removed = await service.deleteEventsFromEntity(getAdapter(mapping.entityType), state || reference, userId, undefined, { strictFailures: true });
      if (!removed) throw new ValidationError('Reconnect calendar access before removing Paralegix events.');
      afterId = mapping.externalEventId;
    }
  }
}

export async function unlinkMicrosoft({ userId, removeParalegixEvents = false }: any) {
  await withConnectionLifecycle('microsoft', userId, async () => {
    if (removeParalegixEvents === true) await removeProviderCopies(userId, 'microsoft');
    await forgetProviderConnection(userId, 'microsoft');
  });
  return { message: 'Microsoft account disconnected', success: true };
}

export async function unlinkGoogle({ userId, removeParalegixEvents = false }: any) {
  await withConnectionLifecycle('google', userId, async () => {
    if (removeParalegixEvents === true) await removeProviderCopies(userId, 'google');
    await forgetProviderConnection(userId, 'google');
  });
  return { message: 'Google account disconnected', success: true };
}

export async function checkCalendarAccess({ userId }: any) {
  const tok = await getProviderToken(userId, 'microsoft');
  const hasToken = !!tok?.access_token;
  const tokenAge = tok?.token_updated_at
    ? Date.now() - new Date(tok.token_updated_at).getTime()
    : null;
  const tokenLikelyValid = hasToken && tokenAge != null && tokenAge < 3600000;
  return {
    hasCalendarAccess: hasToken,
    tokenLikelyValid,
    needsReauth: hasToken && !tokenLikelyValid,
    // authProvider was a Firestore-only user field; no relational equivalent.
    authProvider: undefined,
  };
}

/**
 * Refresh the caller's Microsoft token on the server. The new access token is
 * stored and never returned: the browser only needs to know it worked. The
 * refresh goes through the same locked path as background sync, so a rotated
 * refresh token is never redeemed twice and a refused grant is recorded.
 */
export async function refreshMicrosoftToken({ body }: any) {
  const decoded = await verifyIdToken(body.token);
  const user = await usersRepository.findById(decoded.uid);
  if (!user) throw new NotFoundError('User');

  const tok = await getProviderToken(decoded.uid, 'microsoft');
  const refreshToken = tok?.refresh_token;
  if (!refreshToken) {
    throw new ValidationError({ token: ['No Microsoft refresh token available'] });
  }

  const newAccessToken = await refreshGrant('microsoft', decoded.uid, refreshToken);
  if (!newAccessToken) throw new Error('Failed to refresh Microsoft token');
  return true;
}

function resolveGoogleRedirectUri(baseUrl: any) {
  const configuredRedirectUri = normalizeUrl(process.env.GOOGLE_REDIRECT_URI);
  if (configuredRedirectUri) return configuredRedirectUri;

  const normalizedBaseUrl = normalizeUrl(baseUrl);
  if (normalizedBaseUrl) {
    return `${normalizedBaseUrl}/api/auth/google-callback`;
  }

  return '';
}

async function getStoredGoogleConnectedEmail(userId: string) {
  const rows = await systemQuery('auth_identity', (executor) => executor
    .select({ email: sql<string | null>`${users.preferences}->>'googleConnectedEmail'` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1));
  return normalizeEmail(rows[0]?.email) || null;
}

async function persistGoogleConnectedEmail(userId: string, email: any, executor?: DrizzleExecutor) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  await calendarTokens.saveSettings(userId, { googleConnectedEmail: normalizedEmail }, executor);
  return normalizedEmail;
}


// ── OAuth2 Authorization Code Flow (shared by Google and Microsoft) ──────

/** How long a minted state may wait for its callback. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Read and spend one OAuth state in a single statement.
 *
 * Delete-returning means two concurrent callbacks carrying the same state can
 * never both pass, and the provider predicate means a state minted for one
 * provider cannot complete the other provider's callback.
 */
async function consumeOAuthState(state: string, provider: CalendarProvider) {
  if (!state) throw new CalendarConnectError('invalid_state', null);
  const rows = await tokenQuery(state, (executor) => executor
    .delete(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, provider)))
    .returning());
  const row = rows[0];
  if (!row || !row.userId) throw new CalendarConnectError('invalid_state', null);
  const returnUrl = row.returnUrl || null;
  if (Date.now() - row.createdAt.getTime() > OAUTH_STATE_TTL_MS) {
    throw new CalendarConnectError('expired_state', returnUrl);
  }
  return { userId: row.userId, returnUrl, redirectUri: row.redirectUri || null };
}

/** Constant-time comparison of the query state with the starting browser's cookie. */
function statesMatch(state: string, browserState: string | null | undefined) {
  if (!state || !browserState) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(browserState);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Map a provider's `error` redirect to one fixed code. The description is
 * never forwarded: Microsoft's carries trace and correlation ids.
 */
function providerErrorCode(error: string, description: string): CalendarConnectErrorCode {
  if (error === 'consent_required' || /AADSTS(65001|90094)/.test(description || '')) {
    return 'admin_consent_required';
  }
  return 'access_denied';
}

/**
 * Everything a callback checks before it may talk to the provider: a provider
 * error, the code, the browser binding and the state itself. Returns the spent
 * state row, or throws a CalendarConnectError carrying the page to return to.
 */
async function openCallback(provider: CalendarProvider, {
  code, state, browserState, providerError, providerErrorDescription,
}: any) {
  const bound = statesMatch(state, browserState);
  if (providerError) {
    // A denial still spends the state, so the person lands back on the page
    // that started the connection.
    let returnUrl: string | null = null;
    if (bound) {
      try {
        returnUrl = (await consumeOAuthState(state, provider)).returnUrl;
      } catch (err: any) {
        if (!(err instanceof CalendarConnectError)) throw err;
        returnUrl = err.returnUrl;
      }
    }
    throw new CalendarConnectError(providerErrorCode(providerError, providerErrorDescription), returnUrl);
  }
  if (!code || !bound) throw new CalendarConnectError('invalid_state', null);
  return consumeOAuthState(state, provider);
}

/** POST a code exchange; any failure, network included, is `exchange_failed`. */
async function exchangeCode(provider: CalendarProvider, url: string, params: Record<string, string>, returnUrl: string | null) {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch (err: any) {
    console.error(`auth.service: ${provider} code exchange request failed:`, err.message);
    throw new CalendarConnectError('exchange_failed', returnUrl);
  }

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error(`auth.service: ${provider} code exchange failed:`, tokenResponse.status, errorText);
    throw new CalendarConnectError('exchange_failed', returnUrl);
  }

  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenData?.access_token) throw new CalendarConnectError('exchange_failed', returnUrl);
  return tokenData;
}

/** What a reconnect does with the row already on file. */
interface PriorConnection {
  /** The row belongs to the account the new grant names. */
  same: boolean;
  /** The row's connection must be forgotten before the new one is saved. */
  forget: boolean;
  /** The old Google grant is live and belongs to another account, so it is revoked. */
  revoke: boolean;
}

const KEEP: PriorConnection = { same: true, forget: false, revoke: false };
const NOTHING_ON_FILE: PriorConnection = { same: false, forget: false, revoke: false };
const ANOTHER_ACCOUNT: PriorConnection = { same: false, forget: true, revoke: true };
/** Forgotten, but never revoked: the grant is dead, or whose it is is unknown. */
const UNPROVEN: PriorConnection = { same: false, forget: true, revoke: false };

const accountVerdict = (storedId: string, account: ProviderAccount) => (storedId === account.accountId ? KEEP : ANOTHER_ACCOUNT);

/**
 * Decide whether the row on file belongs to the account the new grant names.
 *
 * A row with no token holds only sync choices and is kept. A recorded account
 * id decides it. A Google row connected before identity was recorded is
 * matched on the address it kept in preferences. Otherwise a row holding a
 * refresh token is resolved by redeeming that token once: the response carries
 * an ID token (openid was granted), which the refresh records on the row. A
 * refused refresh means the old grant is dead, so it is forgotten without a
 * revoke; one that cannot be completed at all refuses the reconnect rather than
 * guessing, and nothing has been written. A row that cannot be resolved (no
 * refresh token, or no ID token in the response) is forgotten without a revoke,
 * because revoking at Google ends the grant for the person and the app, which
 * would take the new token with it if the account were the same.
 */
async function resolvePriorConnection(
  provider: CalendarProvider, userId: string, existing: any, account: ProviderAccount, returnUrl: string | null,
): Promise<PriorConnection> {
  if (!holdsToken(existing)) return NOTHING_ON_FILE;
  if (existing.meta?.accountId) return accountVerdict(existing.meta.accountId, account);
  if (provider === 'google' && account.accountEmail
    && (await getStoredGoogleConnectedEmail(userId)) === account.accountEmail) return KEEP;
  if (!existing.refresh_token || existing.meta?.grantState === 'reconnect_required') return UNPROVEN;

  const refreshed = await refreshGrant(provider, userId, existing.refresh_token);
  const after = await calendarTokens.getConnectionRow(userId, provider);
  if (after?.meta?.accountId) return accountVerdict(after.meta.accountId, account);
  if (!refreshed && after?.meta?.grantState !== 'reconnect_required') {
    throw new CalendarConnectError('exchange_failed', returnUrl);
  }
  return UNPROVEN;
}

/**
 * Validate a token response and only then write it.
 *
 * Every refusal happens before the first write, so a failed reconnect leaves the
 * prior row, scope, identity and sync settings exactly as they were. Tokens from
 * two provider accounts are never combined: a different account is treated as a
 * disconnect followed by a fresh connection. The forget and the save are one
 * transaction under the refresh lock, and the provider calls that end the old
 * connection run only after it commits, so a failed save leaves the old
 * connection whole and its grant unrevoked.
 */
async function completeConnection(provider: CalendarProvider, userId: string, tokenData: any, returnUrl: string | null) {
  const scopes = grantedScopes(provider, tokenData);
  if (!scopes || !hasRequiredScope(provider, scopes)) {
    throw new CalendarConnectError('permission_required', returnUrl);
  }

  const account = accountFromIdToken(provider, tokenData.id_token);
  if (!account) throw new CalendarConnectError('identity_unverified', returnUrl);

  const existing = await calendarTokens.getConnectionRow(userId, provider);
  const prior = await resolvePriorConnection(provider, userId, existing, account, returnUrl);
  if (!tokenData.refresh_token && !(prior.same && existing?.refresh_token)) {
    throw new CalendarConnectError('missing_refresh_token', returnUrl);
  }

  await underConnectionLock(provider, userId, async (context) => {
    const { executor } = context;
    // Re-read under the lock: a refresh may have rotated the token, or another
    // callback may have connected a different account since the initial read.
    const current = await calendarTokens.getConnectionRow(userId, provider, executor);
    let lockedPrior = prior;
    if (!holdsToken(current)) lockedPrior = NOTHING_ON_FILE;
    else if (current.meta?.accountId) lockedPrior = accountVerdict(current.meta.accountId, account);
    else if (current.refresh_token !== existing?.refresh_token || current.access_token !== existing?.access_token) {
      // An unknown replacement cannot be resolved by refreshing while this
      // lock is held. Require a new refresh token and reset without revoking a
      // grant that may belong to the account being connected.
      lockedPrior = UNPROVEN;
    }
    const refreshToken = tokenData.refresh_token || (lockedPrior.same ? current?.refresh_token : null);
    if (!refreshToken) throw new CalendarConnectError('missing_refresh_token', returnUrl);
    if (lockedPrior.forget && holdsToken(current)) {
      await forgetConnectionRows(provider, userId, current, context, { revoke: lockedPrior.revoke });
    }

    await calendarTokens.saveTokens(userId, provider, {
      accessToken: tokenData.access_token,
      refreshToken,
      scope: scopes.join(' '),
    }, executor);
    await calendarTokens.updateTokenMeta(userId, provider, {
      accountId: account.accountId,
      accountEmail: account.accountEmail,
      tenantId: account.tenantId,
      grantState: null,
    }, { executor });
    if (provider === 'google') await persistGoogleConnectedEmail(userId, account.accountEmail, executor);
  });
}

/**
 * Run a callback body after the state is spent. A refusal keeps its code; any
 * other failure is logged and reported as `exchange_failed`, still returning
 * the person to the page that started the connection.
 */
async function withReturnUrl<T>(returnUrl: string | null, provider: CalendarProvider, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof CalendarConnectError) throw err;
    // Never the error itself: a database error's message carries the query
    // parameters, which here are the tokens.
    console.error(`auth.service: ${provider} callback failed:`, errorCode(err));
    throw new CalendarConnectError('exchange_failed', returnUrl);
  }
}

/**
 * Run the calendar writes this person's connection owed while it was unusable.
 *
 * An edit or delete made while the grant waited on a reconnect is parked rather
 * than spending its retry budget, so a working connection is the moment to run
 * it. Not awaited: the callback is a browser navigation and those writes are
 * provider round trips. The release itself is one statement; a dispatch that
 * fails is rescheduled and the calendar-watch sweep retries it.
 */
function releaseOwedCalendarWrites(userId: string, provider: 'google' | 'outlook') {
  const { releaseOutboundWorkAfterReconnect } = require('../calendar/shared/calendarOutboundRetry');
  releaseOutboundWorkAfterReconnect(userId, provider).catch((err: any) => {
    console.error(`auth.service: releasing owed ${provider} calendar writes failed:`, errorCode(err));
  });
}

// ── Google OAuth2 Authorization Code Flow ──────────────────────────────

export async function initGoogleConnect({ userId, returnUrl, baseUrl }: any) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('Google OAuth2 not configured (missing GOOGLE_CLIENT_ID)');
  }

  const redirectUri = resolveGoogleRedirectUri(baseUrl);
  if (!redirectUri) {
    throw new Error('Google OAuth2 not configured (cannot determine redirect URI)');
  }

  const googleConnectedEmail = await getStoredGoogleConnectedEmail(userId);
  const state = crypto.randomBytes(32).toString('hex');

  await systemQuery('oauth_state', (executor) => executor.insert(oauthStates).values({
    state,
    userId,
    provider: 'google',
    redirectUri,
    returnUrl: sanitizeReturnUrl(returnUrl),
  }));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_REQUESTED_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent select_account',
  });
  if (googleConnectedEmail) {
    params.set('login_hint', googleConnectedEmail);
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return { authUrl, redirectUri, state };
}

export async function handleGoogleCallback(input: any) {
  const stateData = await openCallback('google', input);
  const { userId, returnUrl } = stateData;

  await withReturnUrl(returnUrl, 'google', () => withConnectionLifecycle('google', userId, async () => {
    const tokenData = await exchangeCode('google', 'https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      code: input.code,
      redirect_uri: stateData.redirectUri || process.env.GOOGLE_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    }, returnUrl);

    await completeConnection('google', userId, tokenData, returnUrl);
  }));

  releaseOwedCalendarWrites(userId, 'google');

  // Auto-create watch channel if Google→Paralegix sync is enabled
  try {
    const settings = await calendarTokens.getSettings(userId);
    if (settings?.allowGoogleToParalegixSync) {
      const lawFirmIds = await usersRepository.getLawFirmIdsForUser(userId);
      if (lawFirmIds.length > 0) {
        await require('../calendar/shared/calendarSync.repository').recordWebhookFailure({ provider: 'google', userId, lawFirmId: lawFirmIds[0], changeType: 'catch_up', eventId: 'reconnect', pending: true });
        const { createWatchChannel } = require('../calendar/google/google.service');
        createWatchChannel({ userId, lawFirmId: lawFirmIds[0] }).catch((err: any) => {
          console.error('auth.service: auto-create watch channel after Google connect failed:', err.message);
        });
      }
    }
  } catch (err: any) {
    console.error('auth.service: error checking watch channel on Google connect:', errorCode(err));
  }

  return { returnUrl };
}

// ── Microsoft OAuth2 Authorization Code Flow ─────────────────────────────

export async function initMicrosoftConnect({ userId, returnUrl, baseUrl }: any) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    throw new Error('Microsoft OAuth2 not configured (missing MICROSOFT_CLIENT_ID)');
  }

  const redirectUri = baseUrl
    ? `${baseUrl}/api/auth/microsoft-callback`
    : process.env.MICROSOFT_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error('Microsoft OAuth2 not configured (cannot determine redirect URI)');
  }

  const state = crypto.randomBytes(32).toString('hex');

  await systemQuery('oauth_state', (executor) => executor.insert(oauthStates).values({
    state,
    userId,
    provider: 'microsoft',
    redirectUri,
    returnUrl: sanitizeReturnUrl(returnUrl),
  }));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: MICROSOFT_REQUESTED_SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });

  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  return { authUrl, state };
}

export async function handleMicrosoftCallback(input: any) {
  const stateData = await openCallback('microsoft', input);
  const { userId, returnUrl } = stateData;

  await withReturnUrl(returnUrl, 'microsoft', () => withConnectionLifecycle('microsoft', userId, async () => {
    const tokenData = await exchangeCode('microsoft', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      client_id: process.env.MICROSOFT_CLIENT_ID || '',
      scope: MICROSOFT_REQUESTED_SCOPES.join(' '),
      code: input.code,
      redirect_uri: stateData.redirectUri || process.env.MICROSOFT_REDIRECT_URI || '',
      grant_type: 'authorization_code',
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || '',
    }, returnUrl);

    await completeConnection('microsoft', userId, tokenData, returnUrl);
  }));

  releaseOwedCalendarWrites(userId, 'outlook');

  // Auto-create Outlook subscription if Outlook→Paralegix sync is enabled
  try {
    const settings = await calendarTokens.getSettings(userId);
    if (settings?.allowOutlookToParalegixSync) {
      const lawFirmIds = await usersRepository.getLawFirmIdsForUser(userId);
      if (lawFirmIds.length > 0) {
        await require('../calendar/shared/calendarSync.repository').recordWebhookFailure({ provider: 'outlook', userId, lawFirmId: lawFirmIds[0], changeType: 'catch_up', eventId: 'reconnect', pending: true });
        const { createSubscription } = require('../calendar/outlook/outlook.service');
        createSubscription({ userId, lawFirmId: lawFirmIds[0] }).catch((err: any) => {
          console.error('auth.service: auto-create Outlook subscription after connect failed:', err.message);
        });
      }
    }
  } catch (err: any) {
    console.error('auth.service: error checking Outlook subscription on connect:', errorCode(err));
  }

  return { returnUrl };
}
