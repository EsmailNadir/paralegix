const crypto = require('crypto');
const { auth } = require('../../shared/database/firebase');
const { AppError, ValidationError, ConflictError, NotFoundError, ForbiddenError } = require('../../shared/errors/AppError');
const rolesService = require('../lawfirms/roles/roles.service');
const { sendClientInvitationEmail, sendMemberInvitationEmail } = require('../../shared/services/emailService');
const { enforceCountLimit } = require('../../shared/plans/planEnforcement');
const { canUserJoinMoreFirms } = require('../../shared/plans/userLimits');
const { linkClientIdentityToFirm } = require('../clients/clientIdentityLinking.service');
const messagingRepo = require('../messaging/messaging.repository');
const eventBus = require('../../shared/events/eventBus');
const { MEMBER_ADDED } = require('../../shared/events/eventTypes');
import { withTransactionEffects, type TransactionEffects } from '../../shared/database/transactionEffects';
import type { DrizzleExecutor } from '../../shared/database/queryContext';
const repo = require('./invitations.repository');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

/**
 * Resolve a platform user from an email. Try the local `users` table first. It
 * carries the userType we need and is a single indexed read; the vast majority
 * of invitees who have an account are already there, so this short-circuits
 * before touching Firebase. Only on a local miss do we consult Firebase Auth
 * (the identity source) to catch the rare matter of an auth account that has no
 * users row yet (returns a minimal {uid,email} so callers can still link).
 */
export async function lookupUserByEmail(email: any) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const local = await repo.findUserByEmail(normalizedEmail);
  if (local) return local;

  try {
    const userRecord = await auth.getUserByEmail(normalizedEmail);
    // Auth knows them but no users row exists yet. Re-check by uid (an email
    // dupe edge matter), else return a minimal identity stub for linking.
    const u = await repo.getUserById(userRecord.uid);
    return u || { uid: userRecord.uid, email: normalizedEmail };
  } catch (err: any) {
    if (err.code !== 'auth/user-not-found') {
      console.warn('lookupUserByEmail: Firebase Auth lookup failed for', normalizedEmail, err.code || err.message);
    }
  }
  return null;
}

async function addClientToFirm(lawFirmId: string, user: any, invitedBy: any, matterIds: string[] = [], context?: TransactionEffects) {
  const linked = await linkClientIdentityToFirm({
    lawFirmId, userId: user.uid, email: user.email, name: user.name || null, invitedBy, matterIds, client: context?.executor,
  });
  if (context && linked?.clientRecord?.id) {
    context.defer(async () => {
      try {
        await messagingRepo.reconcilePendingClientRecipients(lawFirmId, linked.clientRecord.id, user.uid);
      } catch (err) {
        console.error('Client invitation message reconciliation failed:', err);
      }
    });
  }
  return linked?.clientRecord || null;
}

/**
 * Run an invite-accept claim+join (by token) as ONE transaction. Thin wrapper
 * over the shared repo.withInviteClaimTxn (the single source of truth for the
 * begin/guarded-claim/join/commit/rollback/release shell). A 0-row claim (stale/
 * consumed invite) throws NotFoundError so nothing is joined.
 *
 * @param {string} token   invite token to claim
 * @param {string} userId  accepting user (becomes accepted_by)
 * @param {(client) => Promise<void>} join  the join step, given the txn client
 */
function withInviteAcceptTxn(token: any, userId: string, join: any, executor?: DrizzleExecutor) {
  return repo.withInviteClaimTxn({ by: 'token', key: token, userId, join, executor });
}

/**
 * Directly associate an existing client-type user with a firm (by email).
 */
export async function associateClientDirect({ lawFirmId, userId, body }: any) {
  const email = (body.email || '').trim().toLowerCase();

  const existing = await repo.findClientByEmail(lawFirmId, email);
  if (existing && existing.user_id) {
    throw new ConflictError('This client is already associated with your law firm');
  }

  const existingUser = await lookupUserByEmail(email);
  if (!existingUser || existingUser.userType !== 'client') {
    throw new ValidationError({ email: ['No client account matches this email. Use "Invite client" to send them an invitation.'] });
  }

  await addClientToFirm(lawFirmId, existingUser, userId);
  return { message: 'Client added successfully', clientId: existingUser.uid };
}

/**
 * Send a client invitation (add directly if the user already exists, else pending invite).
 */
export async function sendClientInvite({ lawFirmId, userId, body }: any, context?: TransactionEffects) {
  const email = (body.email || '').trim().toLowerCase();
  const existingUser = await lookupUserByEmail(email);
  return withTransactionEffects(async (transition) => {
    const { executor, defer } = transition;
    const placeholderClient = await repo.findClientByEmail(lawFirmId, email, executor);
    if (placeholderClient && placeholderClient.user_id) {
      throw new ConflictError('This client is already associated with your law firm');
    }

    if (existingUser) {
      if (existingUser.userType !== 'client') {
        throw new ValidationError({ email: ['No client account matches this email. Use "Invite client" to send them an invitation.'] });
      }
      await addClientToFirm(lawFirmId, existingUser, userId, [], transition);
      const stale = await repo.findByEmailType(lawFirmId, email, 'client', executor);
      if (stale) await repo.deleteById(stale.id, executor);
      defer(async () => {
        try {
          const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
          const emailResult = await sendClientInvitationEmail({
            recipientEmail: email, lawFirmName, inviterName, isExistingUser: true,
            portalUrl: `${FRONTEND_URL}/client/dashboard`,
          });
          const c = await repo.findClientByEmail(lawFirmId, email);
          if (c) await repo.updateClientInviteMeta(lawFirmId, c.id, { invitationEmail: email, invitationFailed: !emailResult.sent, portalInvitePending: false });
        } catch (err: any) {
          console.error('[sendClientInvite] Email send failed for existing user:', err.message);
        }
      });
      return { message: 'Client added successfully', email, status: 'added', clientId: existingUser.uid };
    }

    const existingInvite = await repo.findByEmailType(lawFirmId, email, 'client', executor);
    if (existingInvite) throw new ConflictError('An invite has already been sent to this email');
    const token = crypto.randomBytes(32).toString('hex');
    const invite = await repo.create({ lawFirmId, email, inviteType: 'client', token, matterIds: [], invitedBy: userId }, executor);
    if (placeholderClient) {
      await repo.updateClientInviteMeta(lawFirmId, placeholderClient.id, { portalInvitePending: false }, executor);
    }
    defer(async () => {
      try {
        const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
        const inviteUrl = `${FRONTEND_URL}/register/invite?token=${token}`;
        const emailResult = await sendClientInvitationEmail({ recipientEmail: email, lawFirmName, inviterName, isExistingUser: false, inviteUrl });
        await repo.markSent(invite.id, { invitationEmail: email, invitationFailed: !emailResult.sent });
      } catch (err: any) {
        console.error('[sendClientInvite] Email send failed for new user:', err.message);
        await repo.markSent(invite.id, { invitationFailed: true });
      }
    });
    return {
      message: 'Invitation sent to client', email, status: 'invited', token,
      clientId: placeholderClient ? placeholderClient.id : undefined,
    };
  }, context);
}

/**
 * Invite a firm member (add directly if the user exists, else pending invite).
 */
export async function inviteMember({ lawFirmId, userId, actingMember, body }: any) {
  const { email, roleId } = body;

  if (!(await repo.lawFirmExists(lawFirmId))) {
    throw new ValidationError({ lawFirmId: ['Law firm not found'] });
  }

  await enforceCountLimit(lawFirmId, 'maxMembers', () => repo.countMembersAndPendingMembers(lawFirmId));

  const existingUser = await lookupUserByEmail(email);

  const role = await rolesService.getRole({ lawFirmId, roleId });
  if (!role) {
    throw new ValidationError({ roleId: ['Role not found'] });
  }
  // Only the firm owner may hand out the Owner role, same guard the role-change
  // path enforces. Without this a member with just members.invite could invite an
  // account as Owner (ALL_PERMISSIONS) and escalate.
  if (role.name === 'Owner' && !actingMember?.isOwner) {
    throw new ForbiddenError('Only the firm owner can assign the Owner role');
  }
  // Prevent privilege escalation via invite: a non-owner may not grant a role
  // whose effective permissions exceed their own. The Owner-name check alone let a
  // member holding only members.invite assign the built-in Admin role (nearly
  // ALL_PERMISSIONS) and escalate. Compare the role's effective permission set
  // (baseline ∪ role) against the inviter's resolved permissions; the owner
  // bypasses (they hold everything).
  if (!actingMember?.isOwner) {
    const inviterPerms = new Set(actingMember?.resolvedPermissions || []);
    // Effective permissions the assigned role would grant (baseline ∪ role perms),
    // computed via the canonical resolver with a synthetic member for the target
    // role so owner/RBAC-disabled semantics match the inviter's own resolution.
    const grantedPerms = rolesService.resolveFromRolePermissions(
      { roleId, isOwner: role.name === 'Owner' },
      role.permissions || []
    );
    const excess = grantedPerms.filter((p: any) => !inviterPerms.has(p));
    if (excess.length > 0) {
      throw new ForbiddenError('You cannot invite a member with more permissions than you have');
    }
  }

  // Don't cross the client/member boundary: a client-type account must not be
  // added as a firm member (it would gain firm access via the members table).
  if (existingUser && existingUser.userType === 'client') {
    throw new ValidationError({ email: ['This email cannot be added as a firm member.'] });
  }

  if (existingUser && (await repo.isMember(lawFirmId, existingUser.uid))) {
    throw new ConflictError('This user is already a member of the law firm');
  }

  return withTransactionEffects(async ({ executor, defer }) => {
    if (existingUser) {
      const usersRepo = require('../users/users.repository');
      await usersRepo.lockForMembershipChange(existingUser.uid, executor);
    }
    await repo.lockFirmForSeatCheck(lawFirmId, executor);
    if (existingUser && await repo.isMember(lawFirmId, existingUser.uid, executor)) {
      return { message: 'User invited to law firm', email, status: 'added' };
    }
    const firmData = await require('../lawfirms/lawfirms.repository').findById(lawFirmId, executor);
    if (!firmData || firmData.pendingDeletionAt) throw new NotFoundError('Law firm');
    await enforceCountLimit(lawFirmId, 'maxMembers', () => repo.countMembersAndPendingMembers(lawFirmId, executor), { firmData });
    const atCap = existingUser
      ? !canUserJoinMoreFirms({ lawFirmIds: await repo.getUserFirmIds(existingUser.uid, executor) })
      : false;

    // A capped user receives an invitation so they can explicitly choose to switch firms.
    if (!existingUser || atCap) {
      const existingInvite = await repo.findByEmailType(lawFirmId, email, 'member', executor);
      if (existingInvite) throw new ConflictError('An invite has already been sent to this email');
      const token = crypto.randomBytes(32).toString('hex');
      const invite = await repo.create({ lawFirmId, email, inviteType: 'member', roleId, token, invitedBy: userId }, executor);
      defer(async () => {
        try {
          const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
          const inviteUrl = existingUser
            ? `${FRONTEND_URL}/accept-member-invite?token=${token}`
            : `${FRONTEND_URL}/register/member-invite?token=${token}`;
          const emailResult = await sendMemberInvitationEmail({ recipientEmail: email, lawFirmName, inviterName, isExistingUser: false, inviteUrl });
          await repo.markSent(invite.id, { invitationEmail: email, invitationFailed: !emailResult.sent });
        } catch (err: any) {
          console.error('[inviteMember] Email send failed:', err.message);
          await repo.markSent(invite.id, { invitationFailed: true });
        }
      });
      return { message: 'Invitation sent to new team member', email, status: 'invited', token };
    }

    await enforceCountLimit(lawFirmId, 'maxMembers', () => repo.countMembers(lawFirmId, executor), { firmData });
    await repo.addMember(lawFirmId, { userId: existingUser.uid, roleId, invitedBy: userId }, executor);
    defer(() => { eventBus.emit(MEMBER_ADDED, { lawFirmId, userId: existingUser.uid }); });
    defer(async () => {
      try {
        const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
        await sendMemberInvitationEmail({ recipientEmail: email, lawFirmName, inviterName, isExistingUser: true, dashboardUrl: `${FRONTEND_URL}/dashboard` });
      } catch (err: any) {
        console.error('[inviteMember] Email send failed for existing user:', err.message);
      }
    });
    return { message: 'User invited to law firm', email, status: 'added' };
  });
}

// Shared lookup for the public accept-page GETs. Returns the live-invite display
// payload, or when the token is no longer pending but the invitee is ALREADY a
// member/client of that firm, an { alreadyProcessed: true, lawFirmId } payload so
// the frontend can redirect cleanly instead of showing "no longer valid". This is
// what makes the dead FE alreadyProcessed branches live: a typical sequence is the
// auto-process-on-login claiming the invite (status → accepted) before the user
// reaches the accept page, which would otherwise 404 here.
async function lookupInviteOfType(token: any, inviteType: any, alreadyLinked: any) {
  const live = await repo.findByToken(token);
  if (live) {
    if (live.inviteType !== inviteType) throw new NotFoundError('Invitation');
    const lawFirmName = await repo.getLawFirmName(live.lawFirmId);
    return { invitation: { lawFirmId: live.lawFirmId, lawFirmName, email: live.email, invitedAt: live.invitedAt } };
  }

  // No live (pending, non-expired) invite. Distinguish "already processed" from
  // "never existed / wrong type / expired-but-never-joined" using a status-agnostic
  // read plus a membership check by the invited email.
  const anyStatus = await repo.findByTokenAnyStatus(token);
  if (anyStatus && anyStatus.inviteType === inviteType && (await alreadyLinked(anyStatus.lawFirmId, anyStatus.email))) {
    const lawFirmName = await repo.getLawFirmName(anyStatus.lawFirmId);
    return { invitation: { alreadyProcessed: true, lawFirmId: anyStatus.lawFirmId, lawFirmName, email: anyStatus.email } };
  }

  throw new NotFoundError('Invitation');
}

export async function lookupInviteByToken(token: any) {
  // Client-invite lookup: a member-invite token must not leak details here.
  return lookupInviteOfType(token, 'client', (lawFirmId: string, email: any) => repo.isClientLinkedByEmail(lawFirmId, email));
}

export async function lookupMemberInviteByToken(token: any) {
  return lookupInviteOfType(token, 'member', (lawFirmId: string, email: any) => repo.isMemberByEmail(lawFirmId, email));
}

// Shared explicit-accept flow for both invite types. The member and client accept
// endpoints are identical except for (a) the invite_type guard and (b) the join
// step, so they're parameterized here (mirroring lookupInviteOfType). Order of
// checks is preserved exactly: live-invite + type guard → load user → email-match
// gate → atomic claim+join via withInviteAcceptTxn. `join` receives the resolved
// context so each strategy has what it needs without re-fetching.
//
// @param {(ctx: { invite, userId, userData, userEmail, client }) => Promise<void>} join
async function acceptInviteOfType({ userId, token }: any, inviteType: any, join: any, executor?: DrizzleExecutor) {
  const invite = await repo.findByToken(token);
  if (!invite || invite.inviteType !== inviteType) throw new NotFoundError('Invitation');

  const userData = await repo.getUserById(userId);
  if (!userData) throw new NotFoundError('User');

  const userEmail = (userData.email || '').toLowerCase();
  if (userEmail !== invite.email.toLowerCase()) {
    throw new ValidationError({ token: ['This invitation was sent to a different email address.'] });
  }

  // Prevent a dual identity on one firm: a firm member accepting a client invite
  // would hold two conflicting roles (full member access AND limited client-portal
  // access) in the same firm, breaking role enforcement. Block the overlap.
  if (inviteType === 'client' && (await repo.isMember(invite.lawFirmId, userId))) {
    throw new ValidationError({ token: ['You are already a member of this firm and cannot also join as a client.'] });
  }

  // Claim + join atomically (see withInviteAcceptTxn). The join runs on the SAME
  // txn client so a failure rolls the claim back (invite stays pending).
  await withInviteAcceptTxn(token, userId, (client: any) => join({ invite, userId, userData, userEmail, client }), executor);

  return { message: 'Invitation accepted successfully', lawFirmId: invite.lawFirmId };
}

export async function acceptInviteByToken({ userId, token }: any) {
  // `invite.contactClientId` targeted the old company-roster invite shape
  // (`contact_clients` links, organization-clients plan Phase 3). That
  // send/resend/revoke lifecycle is retired (client_company_links migration):
  // a company-linked person is invited to the portal exactly like any other
  // Person client now, so every NEW client invite has `contactClientId` null
  // and goes through the ordinary `linkClientIdentityToFirm` join below. A
  // stray still-pending invite from before the cutover (none exist as of the
  // migration) can no longer be bound - surface that clearly rather than
  // reaching for the deleted roster-invite binder.
  const result = await acceptInviteOfType({ userId, token }, 'client', ({ invite, userId: uid, userData, userEmail, client }: any) => {
    if (invite.contactClientId) {
      throw new ValidationError({ token: ['This invitation type is no longer supported. Please ask the firm to send a new invitation.'] });
    }
    return linkClientIdentityToFirm({
      lawFirmId: invite.lawFirmId,
      userId: uid,
      email: userEmail,
      name: userData.name || null,
      invitedBy: invite.invitedBy,
      matterIds: invite.matterIds || [],
      client,
    });
  });

  // The identity link ran inside the invite transaction, so reconcile only
  // after that transaction has committed.
  await messagingRepo.reconcilePendingClientRecipientsForUser(userId);

  return result;
}

export async function acceptMemberInviteByToken({ userId, token, confirmSwitch }: any) {
  // The join runs inside the accept transaction, so the MEMBER_ADDED listeners
  // (which write outside it) can only be told once it has committed. Captured
  // here and emitted after the await below; an idempotent re-accept by someone
  // who is already a member joins nothing and emits nothing.
  let joinedFirmId: string | null = null;

  // Member join: insert the membership on the txn client; an already-member
  // (idempotent re-accept) just commits the claim with no insert.
  const result = await withTransactionEffects(async (transition) => {
    const { executor } = transition;
    const usersRepo = require('../users/users.repository');
    const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
    await usersRepo.lockForMembershipChange(userId, executor);
    return acceptInviteOfType({ userId, token }, 'member', async ({ invite, userId: uid, client }: any) => {
      if (!(await repo.isMember(invite.lawFirmId, uid, client))) {
        const allFirmIds = await repo.getUserFirmIds(uid, client);
        // User-row locking makes these membership reads authoritative across join paths.
        const firmIds = allFirmIds.filter((id: string) => id !== invite.lawFirmId);
        if (!canUserJoinMoreFirms({ lawFirmIds: firmIds })) {
          if (!confirmSwitch) {
            // Never auto-reject: report the firm(s) in the way so the caller
            // can ask "leave X and join Y?" and retry with confirmSwitch.
            const membersRepo = require('../lawfirms/members/members.repository');
            const currentFirms = await Promise.all(
              firmIds.map(async (id: string) => {
                const [name, member, allMembers] = await Promise.all([
                  repo.getLawFirmName(id),
                  membersRepo.findByUserId(id, uid),
                  membersRepo.listMembers(id),
                ]);
                return { lawFirmId: id, name, willBeDeleted: !!member?.isOwner && allMembers.length <= 1 };
              })
            );
            const err = new AppError(
              `You're already part of ${currentFirms[0]?.name || 'another firm'}. Leaving it is required to join this one.`,
              409,
              'FIRM_SWITCH_REQUIRED',
            );
            err.details = { currentFirms };
            throw err;
          }

          // Lock both sides in a stable order before leaving and joining.
          for (const id of [...new Set([...firmIds, invite.lawFirmId])].sort()) {
            await lawfirmsRepo.lockForUpdate(id, client);
          }
          const membersService = require('../lawfirms/members/members.service');
          for (const id of firmIds) {
            // eslint-disable-next-line no-await-in-loop -- sequential leave-then-join, not a fan-out
            await membersService.leaveFirm({ lawFirmId: id, userId: uid, confirmDeletion: true }, { ...transition, executor: client });
          }
        }

        // Serialize concurrent accepts of DIFFERENT invitations to this same
        // firm before counting: without this, two acceptances racing for the
        // last open seat can each count it as free and both succeed. See
        // `lockFirmForSeatCheck` for why the invite's own row lock (above,
        // in `withInviteClaimTxn`) does not already cover this.
        await repo.lockFirmForSeatCheck(invite.lawFirmId, client);
        const destination = await lawfirmsRepo.findById(invite.lawFirmId, client);
        if (!destination || destination.pendingDeletionAt) throw new NotFoundError('Law firm');

        // Count only current members (not pending invites): the acceptor is one
        // of those pending slots, so counting pending would double-count them.
        // If the firm downgraded or filled up since the invite was sent, this
        // throws PLAN_LIMIT_REACHED and rolls the txn back (invite stays pending).
        // Counted on the same transaction client as the lock above, so it sees
        // whatever the previous lock holder committed.
        await enforceCountLimit(invite.lawFirmId, 'maxMembers', () => repo.countMembers(invite.lawFirmId, client));
        await repo.addMember(invite.lawFirmId, { userId: uid, roleId: invite.roleId, invitedBy: invite.invitedBy }, client);
        joinedFirmId = invite.lawFirmId;
      }
    }, executor);
  });

  if (joinedFirmId) eventBus.emit(MEMBER_ADDED, { lawFirmId: joinedFirmId, userId });

  return result;
}

/**
 * Pending member invites waiting on the current user's email, across every
 * firm (see acceptMemberInviteByToken for why these can't auto-join).
 */
export async function listMyPendingMemberInvites({ email }: any) {
  const invites = await repo.findPendingMemberInvitesByEmail(email);
  return { invites: invites.map(stripToken) };
}

// Build the standard resend response envelope from an email-send result.
function resendResult(emailResult: any, resendCount: any) {
  return {
    message: emailResult.sent ? 'Invitation resent successfully' : 'Email delivery failed: SMTP may not be configured',
    sent: emailResult.sent,
    resendCount,
  };
}

// Shared resend flow for a PENDING invite row (member or client). Atomically
// claims a resend slot (cap + 24h cooldown in ONE UPDATE so concurrent resends
// can't both pass); 0 rows back ⇒ throttled, distinguishing cap-reached from
// cooldown using the pre-claim count. Then sends the email via the provided
// strategy and records the delivery outcome. `errorField` keys the ValidationError
// details so each endpoint keeps its original field name (clientId vs inviteId).
//
// @param {(args:{ email, lawFirmName, inviterName, invite }) => Promise<{sent:boolean}>} sendEmail
async function resendPendingInvite({ lawFirmId, userId, invite, errorField, sendEmail }: any) {
  const email = invite.email;
  if (!email) throw new ValidationError({ [errorField]: ['No email address associated with this invitation.'] });

  const priorCount = invite.invitationResendCount || 0;
  const claimed = await repo.claimResendSlot(invite.id);
  if (!claimed) {
    if (priorCount >= 10) {
      throw new ValidationError({ [errorField]: ['Maximum number of resends (10) reached for this invitation.'] });
    }
    throw new ValidationError({ [errorField]: ['Please wait up to 24 hours before resending this invitation.'] });
  }

  const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
  const emailResult = await sendEmail({ email, lawFirmName, inviterName, invite });
  await repo.setInviteResendFailed(invite.id, !emailResult.sent);

  return resendResult(emailResult, claimed.invitationResendCount || priorCount + 1);
}

export async function resendClientInvite({ lawFirmId, userId, body }: any) {
  // The request carries one opaque identifier whose meaning depends on
  // whether a `clients` row exists yet: a real clients.id uuid once the
  // client has been created (joined or placeholder), or - before one ever
  // exists - the pending invite's raw email address (`invitations` has no
  // `client_id` column yet; that lands with targeted invitations). Resolve
  // which case this is up front instead of letting one `clientId` binding
  // carry both meanings through the rest of the function.
  const { clientId: clientIdOrPendingInviteEmail } = body;

  // Case 1: a `clients` row already exists for this id (joined or placeholder).
  const target = await repo.findClientById(lawFirmId, clientIdOrPendingInviteEmail);
  if (!target) {
    // Case 2: no client row yet - the identifier is the pending invite's email.
    const pendingInviteEmail = clientIdOrPendingInviteEmail;
    const invite = await repo.findByEmailType(lawFirmId, pendingInviteEmail, 'client');
    if (!invite) throw new NotFoundError('Client');
    // Pending-invite resend shares the common flow with member resend.
    return resendPendingInvite({
      lawFirmId, userId, invite, errorField: 'clientId',
      sendEmail: ({ email, lawFirmName, inviterName, invite: inv }: any) => sendClientInvitationEmail({
        recipientEmail: email, lawFirmName, inviterName, isExistingUser: false,
        inviteUrl: inv.token ? `${FRONTEND_URL}/register/invite?token=${inv.token}` : `${FRONTEND_URL}/register`,
      }),
    });
  }

  // Case 1 continued (joined-client resend): no invite row, resend metadata
  // lives on the clients table (claimClientResendSlot), so this branch is
  // client-specific and not shared with the member path.
  const clientId = target.id;
  const email = target.email;
  if (!email) throw new ValidationError({ clientId: ['No email address associated with this client.'] });

  const priorCount = target.invitation_resend_count || 0;
  const claimed = await repo.claimClientResendSlot(lawFirmId, clientId);
  if (!claimed) {
    if (priorCount >= 10) {
      throw new ValidationError({ clientId: ['Maximum number of resends (10) reached for this invitation.'] });
    }
    throw new ValidationError({ clientId: ['Please wait up to 24 hours before resending this invitation.'] });
  }

  const [lawFirmName, inviterName] = await Promise.all([repo.getLawFirmName(lawFirmId), repo.getInviterName(userId)]);
  const emailResult = await sendClientInvitationEmail({ recipientEmail: email, lawFirmName, inviterName, isExistingUser: true, portalUrl: `${FRONTEND_URL}/client/dashboard` });
  await repo.setClientResendFailed(lawFirmId, clientId, !emailResult.sent);

  return resendResult(emailResult, claimed.invitation_resend_count || priorCount + 1);
}

// The raw invite token is the bearer secret for redeeming an invite. The pending
// listings are gated by members.view / clients.view (broad, default permissions),
// so returning the token would broadcast every pending invite's secret to every
// firm member (and into their logs/browser history). Strip it here; callers that
// need to re-notify the invitee use the resend endpoint (by invite id), which is
// gated by the invite permission.
function stripToken(invite: any) {
  if (!invite || typeof invite !== 'object') return invite;
  const { token, ...rest } = invite;
  return rest;
}

export async function listPendingClientInvites({ lawFirmId }: any) {
  const invites = await repo.listPending(lawFirmId, 'client');
  return { invites: invites.map(stripToken) };
}

export async function listPendingMemberInvites({ lawFirmId }: any) {
  const invites = await repo.listPending(lawFirmId, 'member');
  return { invites: invites.map(stripToken) };
}

/**
 * Resend a pending member invitation email (mirrors resendClientInvite: same
 * 24h throttle + 10-resend cap). Member invites previously had no resend, so a
 * failed invite email was stuck. Identified by the invite id surfaced in the
 * pending-member-invites listing.
 */
export async function resendMemberInvite({ lawFirmId, userId, body }: any) {
  const { inviteId } = body;

  const invite = await repo.findPendingByIdType(lawFirmId, inviteId, 'member');
  if (!invite) throw new NotFoundError('Invitation');

  // Pending-invite resend shares the common flow with the client pending path,
  // differing only in the email-send strategy and the error field key.
  return resendPendingInvite({
    lawFirmId, userId, invite, errorField: 'inviteId',
    sendEmail: ({ email, lawFirmName, inviterName, invite: inv }: any) => sendMemberInvitationEmail({
      recipientEmail: email, lawFirmName, inviterName, isExistingUser: false,
      inviteUrl: inv.token ? `${FRONTEND_URL}/register/member-invite?token=${inv.token}` : `${FRONTEND_URL}/register`,
    }),
  });
}

/**
 * Revoke (cancel) a pending invitation before it is accepted or expires. Flips
 * status pending→'revoked' (a value the CHECK constraint already allows but that
 * was never written). Firm + type scoped so a caller can only cancel its own
 * firm's invites. A no-op (already accepted/revoked/expired or unknown id) 404s.
 * Listings already filter status='pending', so a revoked invite drops out.
 */
export async function revokeInvite({ lawFirmId, inviteId, inviteType }: any) {
  const revoked = await repo.revokePendingById(lawFirmId, inviteId, inviteType);
  if (!revoked) throw new NotFoundError('Invitation');
  return { message: 'Invitation revoked successfully', inviteId };
}

/**
 * Sweep stale invitations: flip every still-pending invite past its expires_at
 * to 'expired'. Expiry was filter-only, so expired rows stayed 'pending' forever
 * and the partial pending index never shed them. Scheduled periodically from the
 * invitations route module (and safe to call opportunistically).
 */
export async function expireStaleInvitations() {
  return repo.expireStaleInvitations();
}
