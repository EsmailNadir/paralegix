const adminRepo = require('./admin.repository');
const filesRepo = require('../files/files.repository');
const { admin, auth } = require('../../shared/database/firebase');
const { AppError, NotFoundError, ValidationError, ForbiddenError } = require('../../shared/errors/AppError');
const { normalizeStorageSettings } = require('../../shared/plans/storageQuota');
const { updateStorageConfig, setStorageUsageBytes } = require('../../shared/utils/storageUsage');
const { forEachObjectPage, NO_CEILING } = require('../../shared/storage/listObjects');
const { isSystemObjectPath } = require('../../shared/storage/recordArchive');
const { getAllPlans, getPlanById, getEffectiveLimits, getEffectiveFeatures, UNLIMITED } = require('../../shared/plans/planDefinitions');
const { getPriceId, planFromPriceId, PRICE_MAP } = require('../../shared/plans/stripePrices');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const lawfirmsService = require('../lawfirms/lawfirms.service');
const membersRepo = require('../lawfirms/members/members.repository');
const { linkClientIdentityToFirm } = require('../clients/clientIdentityLinking.service');
const { refresh: refreshWhitelist } = require('../../shared/utils/emailWhitelist');
const stripe = require('../stripe/stripe.config');
const eventBus = require('../../shared/events/eventBus');
const { MEMBER_ADDED, MEMBER_ROLE_CHANGED, MEMBER_REMOVED, ROLE_PERMISSIONS_CHANGED } = require('../../shared/events/eventTypes');

const LAWFIRM_PROFILE_FIELDS = [
  'name',
  'description',
  'address',
  'city',
  'state',
  'zip',
  'phone',
  'email',
];

function timestampToISO(value: any) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * What a firm's plan costs per billing period, in cents, so the admin console can
 * tell a monthly subscriber apart from an annual one without a Stripe round trip.
 * Null when no interval is stored: a comped firm, or one that never subscribed.
 *
 * This is the tier's list price for the interval the firm is actually on, not the
 * settled amount: a coupon, proration, or tax makes the charge differ. `lastPayment`
 * is what Stripe really collected.
 */
function planListPriceCents(plan: any) {
  const interval = plan?.billingInterval;
  if (!interval) return null;
  const pricing: Record<string, number> = getPlanById(plan.planId)?.pricing || {};
  return typeof pricing[interval] === 'number' ? pricing[interval] : null;
}

function toAdminLawFirm(rawLawFirm: any) {
  const settings = rawLawFirm.settings || {};

  const profile: Record<string, any> = {};
  LAWFIRM_PROFILE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(rawLawFirm, field)) {
      profile[field] = rawLawFirm[field];
    }
  });

  const plan = rawLawFirm.plan || {};

  return {
    id: rawLawFirm.id,
    lawFirmId: rawLawFirm.lawFirmId || rawLawFirm.id,
    ...profile,
    createdAt: timestampToISO(rawLawFirm.createdAt),
    updatedAt: timestampToISO(rawLawFirm.updatedAt),
    settings,
    storage: normalizeStorageSettings({
      quotaBytes: rawLawFirm.storageQuotaBytes,
      usedBytes: rawLawFirm.storageUsedBytes,
      hardLimit: rawLawFirm.storageHardLimit,
      warnAtPercent: rawLawFirm.storageWarnAtPercent,
    }),
    plan: {
      planId: plan.planId || 'starter',
      billingStatus: plan.billingStatus || 'incomplete',
      billingInterval: plan.billingInterval || null,
      planPriceCents: planListPriceCents(plan),
      stripePriceId: plan.stripePriceId || null,
      comped: plan.comped || false,
      compedReason: plan.compedReason || null,
      unlimitedOverride: plan.unlimitedOverride || false,
      limitOverrides: plan.limitOverrides || {},
      featureOverrides: plan.featureOverrides || {},
      cancelAtPeriodEnd: plan.cancelAtPeriodEnd || false,
      stripeCustomerId: plan.stripeCustomerId || null,
      stripeSubscriptionId: plan.stripeSubscriptionId || null,
      currentPeriodEnd: timestampToISO(plan.currentPeriodEnd),
      currentPeriodStart: timestampToISO(plan.currentPeriodStart),
      trialEndsAt: timestampToISO(plan.trialEndsAt),
      lastPaymentAt: timestampToISO(plan.lastPaymentAt),
      lastPaymentAmount: plan.lastPaymentAmount || null,
      assignedAt: timestampToISO(plan.assignedAt),
      assignedBy: plan.assignedBy || null,
    },
  };
}

/**
 * Normalize the firm affiliations a paged user row carries.
 *
 * Both come out of `jsonb_agg` as already-parsed arrays, but `listUsers` (the
 * unpaged path) does a plain `select *` and has neither, so the shape is fixed
 * here rather than assumed.
 */
function toUserFirms(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f) => f && f.id)
    .map((f) => ({
      id: f.id,
      name: f.name || 'Unnamed Firm',
      ...(f.isOwner !== undefined ? { isOwner: f.isOwner === true } : {}),
      ...(f.roleName !== undefined ? { roleName: f.roleName || null } : {}),
      ...(f.joinedAt !== undefined ? { joinedAt: timestampToISO(f.joinedAt) } : {}),
    }));
}

function toAdminUser(rawUser: any) {
  const memberFirms = toUserFirms(rawUser.memberFirms);
  const clientFirms = toUserFirms(rawUser.clientFirms);
  return {
    uid: rawUser.uid || rawUser.id,
    email: rawUser.email || '',
    name: rawUser.name || '',
    userType: rawUser.userType || 'pending',
    isAdmin: rawUser.isAdmin === true,
    role: rawUser.role,
    // Firm affiliation, resolved from the members/clients junctions. The id-only
    // arrays are kept alongside the named ones because callers that only need to
    // ask "is this user attached to anything" still read them.
    memberFirms,
    clientFirms,
    lawFirmIds: memberFirms.map((f) => f.id),
    clientLawFirmIds: clientFirms.map((f) => f.id),
    provider: rawUser.provider,
    // Newest recorded sign-in. Null means no `auth.login` event was ever audited
    // for the account, which for an old account can also mean it predates the
    // audit log rather than that it was never used.
    lastLoginAt: timestampToISO(rawUser.lastLoginAt),
    lastLoginProvider: rawUser.lastLoginProvider || null,
    createdAt: timestampToISO(rawUser.createdAt),
    updatedAt: timestampToISO(rawUser.updatedAt),
  };
}

/** One client record as the platform-admin console renders it. */
function toAdminClient(row: any) {
  return {
    id: row.id,
    lawFirmId: row.lawFirmId,
    lawFirmName: row.lawFirmName,
    clientType: row.clientType,
    userId: row.userId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    organization: row.organization,
    status: row.status,
    portalStatus: row.portalStatus,
    portalEmail: row.portalEmail,
    portalAccountCreatedAt: timestampToISO(row.portalAccountCreatedAt),
    // Portal-enabled roster contacts. Always 0 for a person client; a company
    // has no `portalStatus` of its own, so this is its portal-reach signal.
    rosterPortalCount: row.rosterPortalCount,
    invitationFailed: row.invitationFailed,
    invitedAt: timestampToISO(row.invitedAt),
    invitationSentAt: timestampToISO(row.invitationSentAt),
    joinedAt: timestampToISO(row.joinedAt),
    createdAt: timestampToISO(row.createdAt),
    matterCount: row.matterCount,
  };
}

/**
 * The whole firm list, for the callers that ask for it unpaged.
 *
 * `truncated` says the ceiling cut the list short, and `ceiling` says where. Both
 * ride in the response: an admin looking at a capped list has no other way to
 * tell it apart from a complete one. Anything rendering a table should use
 * `listLawFirmsPaged` instead.
 */
export async function listLawFirms() {
  const { lawFirms, truncated, ceiling } = await adminRepo.listLawFirms();
  return { lawFirms: lawFirms.map(toAdminLawFirm), truncated, ceiling };
}

/** The whole user list, unpaged and bounded. Same contract as `listLawFirms`. */
export async function listUsers() {
  const { users, truncated, ceiling } = await adminRepo.listUsers();
  return { users: users.map(toAdminUser), truncated, ceiling };
}

/**
 * One window of the firm list, plus the platform-wide firm stats.
 *
 * `totalItems` is the count matching the search (what the pager walks); `stats`
 * is unfiltered, so the console's cards keep reporting the platform rather than
 * shrinking to the current search. `totalFirms` is `stats.total` under its older
 * name, kept so the existing console keeps rendering through the deploy.
 */
export async function listLawFirmsPaged(params: any = {}) {
  const [{ lawFirms, totalItems }, stats] = await Promise.all([
    adminRepo.listLawFirmsPaged(params),
    adminRepo.lawFirmStats(),
  ]);
  return {
    lawFirms: lawFirms.map((f: any) => ({
      ...toAdminLawFirm(f),
      memberCount: f.memberCount || 0,
      matterCount: f.matterCount || 0,
      clientCount: f.clientCount || 0,
    })),
    totalItems,
    stats,
    totalFirms: stats.total,
  };
}

/**
 * One window of the user list, plus the unfiltered platform user counts the
 * console's stat cards report.
 */
export async function listUsersPaged(params: any = {}) {
  const [{ users, totalItems }, stats] = await Promise.all([
    adminRepo.listUsersPaged(params),
    adminRepo.userCountsByType(),
  ]);
  return { users: users.map(toAdminUser), totalItems, stats };
}

/**
 * One window of the platform-wide client list, plus the unfiltered client stats.
 *
 * The console's other "clients" view lists *user accounts*; this one lists the
 * client RECORDS firms actually create, which is where firm ownership, portal
 * state and matter involvement live.
 */
export async function listClientsPaged(params: any = {}) {
  const [{ clients, totalItems }, stats] = await Promise.all([
    adminRepo.listClientsPaged(params),
    adminRepo.clientCounts(),
  ]);
  return { clients: clients.map(toAdminClient), totalItems, stats };
}

/**
 * Typeahead over every firm on the platform, for admin screens that would
 * otherwise render an unbounded firm dropdown. Authorization is the router's
 * `requireIsAdmin`; there is no firm scope to assert here because the endpoint is
 * platform-scoped by design.
 */
export async function lookupLawFirms({ search, ids, limit }: any) {
  return adminRepo.lookupLawFirms({ search, ids, limit });
}

export async function getLawFirmDetail(lawFirmId: string) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const [members, roles, pendingInvites, pendingClientInvites, clients] = await Promise.all([
    adminRepo.listLawFirmMembers(lawFirmId),
    adminRepo.listLawFirmRoles(lawFirmId),
    adminRepo.listLawFirmPendingInvites(lawFirmId),
    adminRepo.listLawFirmPendingClientInvites(lawFirmId),
    adminRepo.listLawFirmClients(lawFirmId),
  ]);

  // Build a role lookup map for enriching members
  const roleMap: Record<string, any> = {};
  for (const role of roles) {
    roleMap[role.id] = role.name || role.id;
  }

  // Enrich members with user profile data for members missing name/email.
  // Batch the lookup into a single `id = any($1)` query instead of one
  // findUserById round trip per member (the N+1 pattern members.service avoids).
  const memberUserIds = members
    .filter((m: any) => !m.name || !m.email)
    .map((m: any) => m.userId || m.id);
  const userProfileMap: Record<string, any> = {};
  const profiles = await adminRepo.findUsersByIds(memberUserIds);
  profiles.forEach((u: any) => { userProfileMap[u.id] = u; });

  const enrichedMembers = members.map((m: any) => {
    const uid = m.userId || m.id;
    const profile = userProfileMap[uid];
    return {
      id: m.id,
      userId: uid,
      name: m.name || (profile && profile.name) || '',
      email: m.email || (profile && profile.email) || '',
      isOwner: m.isOwner === true,
      roleId: m.roleId || null,
      roleName: m.roleId ? (roleMap[m.roleId] || 'Unknown') : (m.isOwner ? 'Owner' : 'Unknown'),
      joinedAt: timestampToISO(m.joinedAt || m.createdAt || null),
    };
  });

  const enrichedRoles = roles.map((r: any) => ({
    id: r.id,
    name: r.name || '',
    isBuiltIn: r.isBuiltIn === true,
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    createdAt: timestampToISO(r.createdAt || null),
  }));

  const enrichedPendingInvites = pendingInvites.map((inv: any) => ({
    id: inv.id,
    email: inv.email || inv.id,
    roleId: inv.roleId || null,
    roleName: inv.roleId ? (roleMap[inv.roleId] || 'Unknown') : null,
    invitedAt: timestampToISO(inv.invitedAt || null),
    invitedBy: inv.invitedBy || null,
  }));

  const enrichedPendingClientInvites = pendingClientInvites.map((inv: any) => ({
    id: inv.id,
    email: inv.email || inv.id,
    invitedAt: timestampToISO(inv.invitedAt || null),
    invitedBy: inv.invitedBy || null,
  }));

  const enrichedClients = clients.map((c: any) => ({
    id: c.id,
    // userId is the client's linked Firebase uid (null when unlinked) - must
    // never fall back to c.id (the clients.id uuid); see the matching fix in
    // adminRepo.listLawFirmClients.
    userId: c.userId || null,
    clientType: c.clientType === 'company' ? 'company' : 'person',
    name: c.name || '',
    email: c.email || '',
    // Portal-enabled roster contact count; 0 for a person client.
    rosterPortalCount: Number(c.rosterPortalCount) || 0,
    joinedAt: timestampToISO(c.joinedAt || null),
    matterIds: Array.isArray(c.matterIds) ? c.matterIds : [],
  }));

  return {
    lawFirm: toAdminLawFirm(lawFirm),
    members: enrichedMembers,
    roles: enrichedRoles,
    pendingInvites: enrichedPendingInvites,
    pendingClientInvites: enrichedPendingClientInvites,
    clients: enrichedClients,
  };
}

export async function updateLawFirmRole({ lawFirmId, roleId, name, permissions }: any) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const role = await adminRepo.findLawFirmRole(lawFirmId, roleId);
  if (!role) {
    throw new NotFoundError('Role');
  }

  if (role.isBuiltIn && name && name !== role.name) {
    throw new ValidationError({
      fieldErrors: { name: ['Cannot rename built-in roles'] },
      formErrors: [],
    });
  }

  const updateData: Record<string, any> = {};
  if (name !== undefined) updateData.name = name;
  if (permissions !== undefined) updateData.permissions = permissions;

  if (Object.keys(updateData).length === 0) {
    return { message: 'No changes to apply', role };
  }

  await adminRepo.updateLawFirmRole(lawFirmId, roleId, updateData);

  // A super-admin edit to a role's permission array changes the effective set of
  // every member holding it. Emit so the per-firm permission cache is dropped.
  // otherwise the change is invisible until the cache TTL expires (mirrors
  // roles.service.updateRole, which emits the same event for firm-level edits).
  if (permissions !== undefined) {
    eventBus.emit(ROLE_PERMISSIONS_CHANGED, { lawFirmId, roleId });
  }

  const updated = await adminRepo.findLawFirmRole(lawFirmId, roleId);
  return {
    message: 'Role updated successfully',
    role: updated || { ...role, ...updateData },
  };
}

export async function updateLawFirm({ lawFirmId, payload }: any) {
  const existing = await adminRepo.findLawFirmById(lawFirmId);
  if (!existing) {
    throw new NotFoundError('Law firm');
  }

  const updateData: Record<string, any> = {};
  const lawFirmPatch = payload.lawFirm || {};

  LAWFIRM_PROFILE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(lawFirmPatch, field)) {
      const rawValue = lawFirmPatch[field];
      updateData[field] = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    }
  });

  // Storage config (quota / hard-limit / warn-percent) is written to the typed
  // `storage_*` columns through `updateStorageConfig` below, which is what upload
  // enforcement reads.
  let storageConfigPatch: any = null;
  if (payload.storage && Object.keys(payload.storage).length > 0) {
    const currentStorage = normalizeStorageSettings({
      quotaBytes: existing.storageQuotaBytes,
      usedBytes: existing.storageUsedBytes,
      hardLimit: existing.storageHardLimit,
      warnAtPercent: existing.storageWarnAtPercent,
    });
    storageConfigPatch = {};

    if (Object.prototype.hasOwnProperty.call(payload.storage, 'quotaBytes')) {
      const quotaBytes = Math.trunc(payload.storage.quotaBytes);
      if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
        throw new ValidationError({
          fieldErrors: { quotaBytes: ['quotaBytes must be a positive integer'] },
          formErrors: [],
        });
      }
      if (quotaBytes < currentStorage.usedBytes) {
        throw new ValidationError({
          fieldErrors: { quotaBytes: ['quotaBytes cannot be lower than current used storage'] },
          formErrors: [],
        });
      }
      storageConfigPatch.quotaBytes = quotaBytes;
    }
    if (Object.prototype.hasOwnProperty.call(payload.storage, 'hardLimit')) {
      storageConfigPatch.hardLimit = payload.storage.hardLimit;
    }
    if (Object.prototype.hasOwnProperty.call(payload.storage, 'warnAtPercent')) {
      storageConfigPatch.warnAtPercent = payload.storage.warnAtPercent;
    }
  }

  if (Object.keys(updateData).length === 0 && !storageConfigPatch) {
    return {
      message: 'No changes to apply',
      lawFirm: toAdminLawFirm(existing),
    };
  }

  if (storageConfigPatch) {
    await updateStorageConfig(lawFirmId, storageConfigPatch);
  }
  if (Object.keys(updateData).length > 0) {
    await adminRepo.updateLawFirm(lawFirmId, updateData);
  }

  const updated = await adminRepo.findLawFirmById(lawFirmId);
  return {
    message: 'Law firm updated successfully',
    lawFirm: toAdminLawFirm(updated || existing),
  };
}

export async function updateMemberRole({ lawFirmId, memberId, roleId }: any) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const member = await adminRepo.findLawFirmMember(lawFirmId, memberId);
  if (!member) {
    throw new NotFoundError('Member');
  }

  if (member.isOwner) {
    throw new ValidationError({
      fieldErrors: { roleId: ['Cannot change the firm owner\'s role'] },
      formErrors: [],
    });
  }

  const role = await adminRepo.findLawFirmRole(lawFirmId, roleId);
  if (!role) {
    throw new NotFoundError('Role');
  }

  await adminRepo.updateLawFirmMember(lawFirmId, memberId, { roleId });

  // A super-admin role change alters this member's effective permission set.
  // Emit so their cached entry is invalidated immediately (members are keyed by
  // user_id, so member.userId is the cache's userId component). memberId is the
  // member row's PK, NOT the Firebase user_id the cache keys on. Never fall back
  // to it, or we'd invalidate a non-existent key and leave the real entry stale
  // until TTL. If userId is somehow missing, log and skip rather than emit wrong.
  if (member.userId) {
    eventBus.emit(MEMBER_ROLE_CHANGED, { lawFirmId, userId: member.userId });
  } else {
    console.error(
      `admin.service.updateMemberRole: member ${memberId} in firm ${lawFirmId} has no userId; ` +
        'skipping MEMBER_ROLE_CHANGED: permission cache may stay stale until TTL.',
    );
  }

  return {
    message: 'Member role updated successfully',
    memberId,
    roleId,
    roleName: role.name,
  };
}

export async function removeMember({ lawFirmId, memberId }: any) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const member = await adminRepo.findLawFirmMember(lawFirmId, memberId);
  if (!member) {
    throw new NotFoundError('Member');
  }

  if (member.isOwner) {
    throw new ValidationError({
      fieldErrors: { memberId: ['Cannot remove the firm owner'] },
      formErrors: [],
    });
  }

  const userId = member.userId || member.id;

  await adminRepo.deleteLawFirmMember(lawFirmId, memberId);

  // Super-admin removed the member. Drop their cached permission entry so a
  // stale "still a member" resolution can't linger past the cache TTL.
  eventBus.emit(MEMBER_REMOVED, { lawFirmId, userId });

  return { message: 'Member removed successfully' };
}

export async function deletePendingInvite({ lawFirmId, inviteId }: any) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const invite = await adminRepo.findLawFirmPendingInvite(lawFirmId, inviteId);
  if (!invite) {
    throw new NotFoundError('Pending invite');
  }

  await adminRepo.deleteLawFirmPendingInvite(lawFirmId, inviteId);

  return { message: 'Pending member invite deleted successfully' };
}

export async function deletePendingClientInvite({ lawFirmId, inviteId }: any) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) {
    throw new NotFoundError('Law firm');
  }

  const invite = await adminRepo.findLawFirmPendingClientInvite(lawFirmId, inviteId);
  if (!invite) {
    throw new NotFoundError('Pending client invite');
  }

  await adminRepo.deleteLawFirmPendingClientInvite(lawFirmId, inviteId);

  return { message: 'Pending client invite deleted successfully' };
}

export async function updateUserAdmin({ userId, isAdmin }: any) {
  const existing = await adminRepo.findUserById(userId);
  if (!existing) {
    throw new NotFoundError('User');
  }

  if (existing.isAdmin === isAdmin) {
    return {
      message: isAdmin ? 'User is already an admin' : 'User is already not an admin',
      user: toAdminUser(existing),
    };
  }

  // Never remove the last platform admin: a lockout is only recoverable via
  // direct DB access.
  if (isAdmin === false && await adminRepo.countAdmins() <= 1) {
    throw new ForbiddenError('Cannot remove the last platform admin.');
  }

  await adminRepo.updateUser(userId, { isAdmin });
  const updated = await adminRepo.findUserById(userId);

  return {
    message: isAdmin ? 'User granted admin access' : 'User admin access removed',
    user: toAdminUser(updated || { ...existing, isAdmin }),
  };
}

// ── Plan Management ─────────────────────────────────────────────────────

export async function listPlanTiers() {
  return getAllPlans();
}

export async function getLawFirmPlan(lawFirmId: string) {
  const lawFirm = await adminRepo.findLawFirmById(lawFirmId);
  if (!lawFirm) throw new NotFoundError('Law firm');

  const limits = getEffectiveLimits(lawFirm);
  const features = getEffectiveFeatures(lawFirm);

  const [matters, members] = await Promise.all([
    adminRepo.countMatters(lawFirmId),
    adminRepo.countMembers(lawFirmId),
  ]);

  return {
    lawFirm: toAdminLawFirm(lawFirm),
    limits,
    features,
    usage: {
      matters,
      members,
      storageBytes: Number(lawFirm.storageUsedBytes || 0),
    },
  };
}

// Stripe subscription statuses that are over for good: nothing more will be
// billed on them. Every other status can still charge the customer.
const FINISHED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

// Whether Stripe still has this subscription in a state that can bill. A 404
// (deleted, or an id from another account) is not live. Any other failure is
// rethrown: an admin action must not proceed on a guess about billing.
async function isSubscriptionLiveAtStripe(subscriptionId: string) {
  if (!stripe) return true;
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return !!subscription && !FINISHED_SUBSCRIPTION_STATUSES.has(subscription.status);
  } catch (err: any) {
    if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return false;
    throw err;
  }
}

export async function updateLawFirmPlan({ lawFirmId, payload, adminUserId }: any) {
  const existing = await adminRepo.findLawFirmById(lawFirmId);
  if (!existing) throw new NotFoundError('Law firm');

  // Comping here only flips the flag: it leaves a live subscription billing a
  // firm marked free, and that subscription's next renewal webhook writes
  // comped back to false. The comp action cancels the subscription first.
  const storedSubscriptionId = existing.plan?.stripeSubscriptionId;
  if (payload.comped === true && storedSubscriptionId && await isSubscriptionLiveAtStripe(storedSubscriptionId)) {
    throw new ValidationError(
      'This firm has a live Stripe subscription that would keep billing it. Use the comp action (Give Free Access), which cancels the subscription before comping the firm.',
    );
  }

  const planPatch: Record<string, any> = {};
  if (payload.planId !== undefined) planPatch.planId = payload.planId;
  if (payload.billingStatus !== undefined) planPatch.billingStatus = payload.billingStatus;
  if (payload.comped !== undefined) planPatch.comped = payload.comped;
  if (payload.compedReason !== undefined) planPatch.compedReason = payload.compedReason;
  if (payload.unlimitedOverride !== undefined) planPatch.unlimitedOverride = payload.unlimitedOverride;
  if (payload.trialEndsAt !== undefined) {
    planPatch.trialEndsAt = payload.trialEndsAt ? new Date(payload.trialEndsAt).toISOString() : null;
  }
  if (payload.limitOverrides !== undefined) planPatch.limitOverrides = payload.limitOverrides;
  if (payload.featureOverrides !== undefined) planPatch.featureOverrides = payload.featureOverrides;

  // Track who/when on comp; clear the comp metadata when un-comping so stale
  // compedBy/compedAt/compedReason don't linger on a firm that is no longer comped.
  if (payload.comped === true) {
    planPatch.compedBy = adminUserId;
    planPatch.compedAt = new Date().toISOString();
  } else if (payload.comped === false) {
    planPatch.compedBy = null;
    planPatch.compedAt = null;
    planPatch.compedReason = null;
  }

  planPatch.assignedAt = new Date().toISOString();
  planPatch.assignedBy = adminUserId;

  await lawfirmsRepo.mergePlan(lawFirmId, planPatch);

  // Sync the typed storage-quota column (the enforcement source of truth) whenever
  // anything that changes the effective quota was touched: plan tier, unlimited
  // override, or an explicit storage-quota limit override. `getEffectiveLimits`
  // resolves all three (incl. the unlimited cap), so we write exactly what
  // enforcement will read.
  // Any limitOverrides change (not just when storageQuotaBytes is PRESENT) must
  // re-sync: `mergePlan` replaces the whole jsonb key, so CLEARING the storage
  // override omits the field, which previously skipped the re-sync and left the
  // typed enforcement column stuck on the old override.
  const quotaTouched = payload.planId !== undefined
    || payload.unlimitedOverride !== undefined
    || payload.limitOverrides !== undefined;
  if (quotaTouched) {
    const merged = await adminRepo.findLawFirmById(lawFirmId);
    const effectiveQuota = getEffectiveLimits(merged).storageQuotaBytes;
    await updateStorageConfig(lawFirmId, { quotaBytes: effectiveQuota });
  }

  const updated = await adminRepo.findLawFirmById(lawFirmId);
  return {
    message: 'Plan updated successfully',
    lawFirm: toAdminLawFirm(updated),
  };
}

/**
 * Recompute a firm's stored-bytes usage from its file rows and write it back.
 *
 * The rows ARE the usage: `/usage` sums them live, and this exists only to
 * repair the running column the upload quota gate reads, which can drift if a
 * charge is lost (a process that died between stamping a row and charging it).
 * Uploads in flight are not in that column at all: they hold
 * `storage_reservations` rows, and this purges the lapsed ones and leaves the
 * live ones to their uploads.
 *
 * It used to page the firm's whole storage prefix and add up the objects. That
 * counted things nobody could see: an object left behind by an interrupted
 * upload inflated a firm's figure permanently, and the walk had to know which
 * prefixes were the system's own so it did not bill a firm for our safety net.
 * A row is only counted when it is finalized and live, so none of that arises.
 */
export async function recomputeStorageUsage(lawFirmId: string) {
  const existing = await adminRepo.findLawFirmById(lawFirmId);
  if (!existing) throw new NotFoundError('Law firm');

  const { bytes, count } = await filesRepo.sumFinalizedBytes(lawFirmId);
  await setStorageUsageBytes(lawFirmId, bytes, count);

  const updated = await adminRepo.findLawFirmById(lawFirmId);
  return {
    message: 'Storage usage recounted',
    usedBytes: bytes,
    fileCount: count,
    lawFirm: toAdminLawFirm(updated || existing),
  };
}

/**
 * Per-firm plan limits and current usage, for the admin console's over-limit
 * sweep. Reads the whole firm list because the question is "which firms are over
 * their plan", which no filter narrows in advance.
 *
 * Bounded by the same ceiling as every other unpaged firm read, and reports
 * `truncated` — a partial sweep that looked complete would report "no firms over
 * limit" for firms it never examined.
 */
export async function listPlanUsage() {
  const { lawFirms: firms, truncated, ceiling } = await adminRepo.listLawFirms();
  const results = [];

  // Batch the per-firm counts into two grouped aggregates instead of issuing a
  // count(*) pair per firm in the loop (was O(firms) sequential round trips).
  const firmIds = firms.map((f: any) => f.id);
  const [mattersByFirm, membersByFirm] = await Promise.all([
    adminRepo.countMattersByFirm(firmIds),
    adminRepo.countMembersByFirm(firmIds),
  ]);

  for (const data of firms) {
    const limits = getEffectiveLimits(data);
    const plan = data.plan || {};

    const mattersCount = mattersByFirm.get(data.id) || 0;
    const membersCount = membersByFirm.get(data.id) || 0;

    const storageUsed = Number(data.storageUsedBytes || 0);

    const overLimit =
      (limits.maxMatters !== UNLIMITED && mattersCount >= limits.maxMatters) ||
      (limits.maxMembers !== UNLIMITED && membersCount >= limits.maxMembers) ||
      storageUsed >= limits.storageQuotaBytes;

    results.push({
      lawFirmId: data.id,
      name: data.name || '',
      planId: plan.planId || 'starter',
      billingStatus: plan.billingStatus || 'incomplete',
      billingInterval: plan.billingInterval || null,
      comped: plan.comped || false,
      unlimitedOverride: plan.unlimitedOverride || false,
      cancelAtPeriodEnd: plan.cancelAtPeriodEnd || false,
      stripeSubscriptionId: plan.stripeSubscriptionId || null,
      usage: {
        matters: { current: mattersCount, limit: limits.maxMatters },
        members: { current: membersCount, limit: limits.maxMembers },
        storage: { currentBytes: storageUsed, limitBytes: limits.storageQuotaBytes },
      },
      overLimit,
    });
  }

  return { firms: results, truncated, ceiling };
}

// ── Admin Subscription Management ───────────────────────────────────────

export async function adminCreateSubscription({ lawFirmId, planId, interval, skipTrial, coupon, adminUserId }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  // Resolve the price BEFORE opening a Stripe customer. This lookup used to sit
  // below the customer creation, so an unconfigured plan/interval pair (an
  // interval whose STRIPE_*_PRICE_ID env var is unset) answered 400 only after a
  // real Stripe customer had been created and its id persisted to the firm row.
  // The retry reused that customer, so the cost was an orphan rather than a wrong
  // charge, but the write happened on a request that failed validation.
  const priceId = getPriceId(planId, interval);
  if (!priceId) throw new ValidationError('Invalid plan or billing interval');

  let customerId = firmData?.plan?.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { lawFirmId, createdBy: adminUserId },
      name: firmData.name,
      email: firmData.email,
    });
    customerId = customer.id;
    await lawfirmsRepo.mergePlan(lawFirmId, { stripeCustomerId: customerId });
  }

  const subParams: any = {
    customer: customerId,
    items: [{ price: priceId }],
    metadata: { lawFirmId, createdBy: adminUserId },
  };
  if (skipTrial) subParams.trial_period_days = 0;
  if (coupon) subParams.coupon = coupon;

  const subscription = await stripe.subscriptions.create(subParams);

  return { message: 'Subscription created', stripeSubscriptionId: subscription.id };
}

export async function adminCancelSubscription({ lawFirmId, immediate, reason }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new NotFoundError('No active subscription');

  if (immediate) {
    await stripe.subscriptions.cancel(subscriptionId, { prorate: true });
  } else {
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      metadata: { cancelReason: reason || 'Admin cancelled' },
    });
    await lawfirmsRepo.mergePlan(lawFirmId, { cancelAtPeriodEnd: true });
  }

  return {
    message: immediate
      ? 'Subscription cancelled immediately'
      : 'Subscription will cancel at period end',
  };
}

export async function adminExtendTrial({ lawFirmId, days }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new NotFoundError('No active subscription');

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.status !== 'trialing') {
    throw new ValidationError('Firm is not on a trial');
  }

  const newTrialEnd = subscription.trial_end + (days * 86400);
  await stripe.subscriptions.update(subscriptionId, { trial_end: newTrialEnd });

  return {
    message: `Trial extended by ${days} days`,
    newTrialEnd: new Date(newTrialEnd * 1000).toISOString(),
  };
}

export async function adminApplyCoupon({ lawFirmId, couponId }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new NotFoundError('No active subscription');

  await stripe.subscriptions.update(subscriptionId, { coupon: couponId });

  return { message: `Coupon ${couponId} applied to subscription` };
}

/**
 * The PaymentIntent that settled an invoice, or null when there is no refundable
 * card payment on it (paid out of band, or fully covered by credit).
 *
 * `Invoice.payment_intent` was removed from the Stripe API (2025-03-31.basil) in
 * favour of an invoice-payments sublist that a plain invoice read does not include,
 * so the payment is fetched separately when the old field is absent. Webhook and
 * older-pinned payloads still carry the field, hence both paths.
 */
async function paymentIntentForInvoice(invoice: any) {
  const direct = invoice?.payment_intent;
  if (direct) return typeof direct === 'string' ? direct : direct.id || null;

  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 10 });
  for (const payment of payments.data || []) {
    if (payment?.status && payment.status !== 'paid') continue;
    const ref = payment?.payment?.payment_intent;
    if (ref) return typeof ref === 'string' ? ref : ref.id || null;
  }
  return null;
}

export async function adminRefund({ lawFirmId, amount, full, reason }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  const customerId = firmData?.plan?.stripeCustomerId;
  if (!customerId) throw new NotFoundError('No billing account');

  const invoices = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 1 });
  if (!invoices.data.length) throw new NotFoundError('No paid invoices to refund');

  const latestInvoice = invoices.data[0];
  const paymentIntentId = await paymentIntentForInvoice(latestInvoice);
  if (!paymentIntentId) {
    throw new ValidationError('The most recent paid invoice has no card payment to refund');
  }

  const refundParams: any = { payment_intent: paymentIntentId };
  if (!full && amount) {
    refundParams.amount = Math.round(amount * 100); // dollars to cents
  }
  if (reason) {
    refundParams.reason = 'requested_by_customer';
    refundParams.metadata = { adminReason: reason };
  }

  const refund = await stripe.refunds.create(refundParams);

  return {
    message: 'Refund issued',
    refundId: refund.id,
    amountRefunded: refund.amount / 100,
  };
}

export async function adminCompFirm({ lawFirmId, planId, reason, adminUserId }: any) {
  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  // The subscription must be gone before the firm is comped and its pointer
  // cleared, or the firm is charged on a subscription nothing tracks any more.
  // A cancel that fails is only acceptable when Stripe confirms there is nothing
  // left to cancel (already ended, or no such subscription).
  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (subscriptionId && stripe) {
    try {
      await stripe.subscriptions.cancel(subscriptionId, { prorate: true });
    } catch (err: any) {
      if (await isSubscriptionLiveAtStripe(subscriptionId)) {
        console.error('adminCompFirm: Stripe subscription cancel failed; firm left uncomped', {
          lawFirmId, subscriptionId, error: err?.message,
        });
        throw new AppError(
          'Could not cancel the firm\'s Stripe subscription, so the firm was not comped and is still billed. Try again, or cancel the subscription in Stripe first.',
          502,
          'STRIPE_CANCEL_FAILED',
        );
      }
    }
  }

  const resolvedPlanId = planId || firmData?.plan?.planId || 'professional';
  const planDef = getPlanById(resolvedPlanId);
  const nowIso = new Date().toISOString();

  await lawfirmsRepo.mergePlan(lawFirmId, {
    planId: resolvedPlanId,
    billingStatus: 'comped',
    comped: true,
    compedBy: adminUserId,
    compedAt: nowIso,
    compedReason: reason,
    stripeSubscriptionId: null,
    stripePriceId: null,
    billingInterval: null,
    cancelAtPeriodEnd: false,
    assignedAt: nowIso,
    assignedBy: adminUserId,
    // Mark the cancelled subscription (if there was one) stale, the same
    // marker handleSubscriptionDeleted writes for an ordinary cancellation.
    // Stripe's own webhook delivery is asynchronous from the cancel call
    // above, so an `updated`/`deleted` event for THIS
    // subscription can still arrive after this write, still naming this firm
    // in its metadata. Without this marker, handleSubscriptionChange's and
    // handleSubscriptionDeleted's staleness guards have nothing to compare
    // against once stripeSubscriptionId is cleared above, and a stray event
    // silently reverts the comp this action just granted.
    ...(subscriptionId ? { canceledSubscriptionId: subscriptionId } : {}),
  });
  await updateStorageConfig(lawFirmId, { quotaBytes: planDef.limits.storageQuotaBytes });

  return { message: `Firm comped on ${resolvedPlanId} plan` };
}

export async function adminListSubscriptionInvoices({ lawFirmId }: any) {
  if (!stripe) throw new ValidationError('Stripe is not configured');

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  const customerId = firmData?.plan?.stripeCustomerId;
  if (!customerId) return { invoices: [] };

  const invoices = await stripe.invoices.list({ customer: customerId, limit: 50 });

  return {
    invoices: invoices.data.map((inv: any) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountDue: inv.amount_due / 100,
      amountPaid: inv.amount_paid / 100,
      currency: inv.currency,
      created: new Date(inv.created * 1000).toISOString(),
      periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
      periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
    })),
  };
}

// ── Email-verification whitelist (test accounts) ────────────────────────

export async function listWhitelist() {
  const entries = await adminRepo.listWhitelist();
  return { entries };
}

export async function addToWhitelist({ email, note, adminUserId }: any) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) throw new ValidationError({ email: ['Email is required'] });

  await adminRepo.addWhitelist({ email: normalized, note, createdBy: adminUserId });
  // Refresh the in-memory set so the address is honored on the next request.
  await refreshWhitelist();

  return { message: 'Email added to verification whitelist', email: normalized };
}

export async function removeFromWhitelist({ email }: any) {
  const normalized = (email || '').trim().toLowerCase();
  const removed = await adminRepo.removeWhitelist(normalized);
  if (!removed) throw new NotFoundError('Whitelist entry');
  await refreshWhitelist();

  return { message: 'Email removed from verification whitelist', email: normalized };
}

// ── Test account / firm creation ────────────────────────────────────────

// Comped + unlimited plan for admin-created test firms: fully usable immediately,
// bypasses plan limits, and (with billingStatus 'comped') passes any future
// billing gate without going through Stripe checkout.
function testFirmPlan(adminUserId: any) {
  const nowIso = new Date().toISOString();
  return {
    planId: 'professional',
    billingStatus: 'comped',
    comped: true,
    compedReason: 'Admin-created test firm',
    unlimitedOverride: true,
    assignedAt: nowIso,
    assignedBy: adminUserId || 'admin',
  };
}

// Resolve the firm's built-in "member" role (fallback: any non-owner role) so a
// created test member gets a sane default when no explicit roleId is supplied.
async function resolveMemberRoleId(lawFirmId: string) {
  const roles = await adminRepo.listLawFirmRoles(lawFirmId);
  const pick =
    roles.find((r: any) => (r.name || '').toLowerCase() === 'member') ||
    roles.find((r: any) => (r.name || '').toLowerCase() !== 'owner') ||
    roles[0];
  if (!pick) throw new ValidationError({ roleId: ['This firm has no assignable role'] });
  return pick.id;
}

/**
 * Create a test account (and optionally a law firm) from the admin panel.
 *
 * `kind`:
 *  - 'firm_owner' → a firm_member account + a new comped/unlimited law firm they own.
 *  - 'member'     → a firm_member account added to an existing firm (needs lawFirmId).
 *  - 'client'     → a client account, optionally linked to a firm's portal (lawFirmId).
 *
 * The Firebase identity is created pre-verified so the account can log in
 * immediately, and the plaintext password is echoed back so the admin can hand it
 * to a tester. If the Postgres side fails, the Firebase user is rolled back so the
 * email is free to retry.
 */
export async function adminCreateAccount({ kind, email, password, name, firmName, lawFirmId, roleId, adminUserId }: any) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new ValidationError({ email: ['Email is required'] });
  if (!password || password.length < 6) {
    throw new ValidationError({ password: ['Password must be at least 6 characters'] });
  }

  // Reject if an identity already exists (keep test accounts fresh and avoid
  // silently attaching an existing person to a new test firm).
  let existingFirebase = null;
  try {
    existingFirebase = await auth.getUserByEmail(normalizedEmail);
  } catch (err: any) {
    if (err.code !== 'auth/user-not-found') throw err;
  }
  if (existingFirebase || (await adminRepo.findUserByEmail(normalizedEmail))) {
    throw new ValidationError({ email: ['An account already exists for this email'] });
  }

  // Validate firm target up front (before creating the Firebase user) for member joins.
  if (kind === 'member') {
    if (!lawFirmId) throw new ValidationError({ lawFirmId: ['lawFirmId is required for a member account'] });
    if (!(await adminRepo.findLawFirmById(lawFirmId))) throw new NotFoundError('Law firm');
  }
  if (kind === 'client' && lawFirmId && !(await adminRepo.findLawFirmById(lawFirmId))) {
    throw new NotFoundError('Law firm');
  }

  const userType = kind === 'client' ? 'client' : 'firm_member';

  const created = await auth.createUser({
    email: normalizedEmail,
    password,
    emailVerified: true,
    displayName: name || undefined,
  });
  const uid = created.uid;

  let userRowInserted = false;
  try {
    await adminRepo.insertUserRow({ uid, email: normalizedEmail, name: name || null, userType });
    userRowInserted = true;

    if (kind === 'firm_owner') {
      const { lawFirmId: newFirmId } = await lawfirmsService.createLawFirm({
        name: firmName || `${name || 'Test'}'s Firm`,
        userId: uid,
        plan: testFirmPlan(adminUserId),
      });
      return { message: 'Firm owner account created', account: { uid, email: normalizedEmail, password, userType, lawFirmId: newFirmId } };
    }

    if (kind === 'member') {
      const resolvedRoleId = roleId || (await resolveMemberRoleId(lawFirmId));
      await membersRepo.addMember(lawFirmId, uid, { roleId: resolvedRoleId, isOwner: false, joinedAt: new Date() });
      eventBus.emit(MEMBER_ADDED, { lawFirmId, userId: uid });
      return { message: 'Member account created', account: { uid, email: normalizedEmail, password, userType, lawFirmId, roleId: resolvedRoleId } };
    }

    // client
    if (lawFirmId) {
      await linkClientIdentityToFirm({ lawFirmId, userId: uid, email: normalizedEmail, name: name || null, invitedBy: adminUserId });
    }
    return { message: 'Client account created', account: { uid, email: normalizedEmail, password, userType, lawFirmId: lawFirmId || null } };
  } catch (err: any) {
    // Postgres side failed after the Firebase identity was created. Undo BOTH
    // halves of the partial account, not just the Firebase one.
    //
    // This used to delete only the identity, which left the `users` row behind.
    // The next attempt at the same address then hit the duplicate check above
    // and was refused as "an account already exists" for an identity that no
    // longer exists, so the address became permanently unusable. The reachable
    // trigger is a member account against a firm with no assignable role: the
    // insert lands, `resolveMemberRoleId` throws, and the address is burned.
    //
    // Both deletes are best-effort. The identity is gone either way, so a
    // failure to remove the row must not replace the caller's real error with a
    // cleanup error.
    await auth.deleteUser(uid).catch(() => {});
    if (userRowInserted) {
      await adminRepo.deleteUserRow(uid).catch((cleanupErr: any) =>
        console.error('adminCreateAccount: rollback of the users row failed for', uid, cleanupErr)
      );
    }
    throw err;
  }
}
