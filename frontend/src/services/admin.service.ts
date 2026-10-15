import BaseApiService from './base.service';

const BYTES_PER_MB = 1024 * 1024;

export interface AdminStorageSettings {
  quotaBytes: number;
  usedBytes: number;
  warnAtPercent: number;
  hardLimit: boolean;
}

export interface AdminPlanData {
  planId: string;
  billingStatus: string;
  billingInterval: string | null;
  /**
   * List price in cents for the tier + interval the firm is on, so monthly and
   * annual subscribers are distinguishable at a glance. Null when no interval is
   * stored (comped, or never subscribed). What Stripe actually collected is
   * `lastPaymentAmount`, which can differ through a coupon or proration.
   */
  planPriceCents: number | null;
  stripePriceId: string | null;
  comped: boolean;
  compedReason: string | null;
  unlimitedOverride: boolean;
  limitOverrides?: {
    maxMatters?: number;
    maxMembers?: number;
    storageQuotaBytes?: number;
    maxFileSizeBytes?: number;
  };
  featureOverrides?: Record<string, boolean>;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  trialEndsAt: string | null;
  lastPaymentAt: string | null;
  lastPaymentAmount: number | null;
  assignedAt: string | null;
  assignedBy: string | null;
}

export interface AdminLawFirm {
  id: string;
  lawFirmId?: string;
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  plan?: AdminPlanData;
  settings?: Record<string, unknown>;
  /** Storage quota/usage, read from the firm's typed `storage_*` columns. */
  storage?: AdminStorageSettings;
  /**
   * Usage counts, present only on the paged list - how much of a tenant a firm
   * actually is. The unpaged `getLawFirms()` does not compute them.
   */
  memberCount?: number;
  matterCount?: number;
  clientCount?: number;
}

export type AdminUserType = 'client' | 'firm_member' | 'pending';

/** A firm a user is attached to, named rather than just referenced by id. */
export interface AdminUserFirm {
  id: string;
  name: string;
  /** Staff memberships only - absent on the portal-client side. */
  isOwner?: boolean;
  roleName?: string | null;
  joinedAt?: string | null;
}

export interface AdminUser {
  uid: string;
  email: string;
  name: string;
  userType: AdminUserType;
  isAdmin?: boolean;
  role?: string;
  /** Firms the user is staff at, and firms they are a portal client of. */
  memberFirms?: AdminUserFirm[];
  clientFirms?: AdminUserFirm[];
  lawFirmIds?: string[];
  clientLawFirmIds?: string[];
  provider?: string;
  /**
   * Newest audited sign-in. Null means no login was ever recorded for the
   * account - which, for an account older than the audit log, is not the same as
   * never having been used.
   */
  lastLoginAt?: string | null;
  lastLoginProvider?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * Whether a client record has reached the portal: `linked` once an account is
 * attached, `pending` while an invite is outstanding, `none` if none was sent.
 */
export type ClientPortalStatus = 'linked' | 'pending' | 'none';

/**
 * A client RECORD as the platform-admin console renders it - a row in a firm's
 * client list, which is a different thing from the login account in `AdminUser`.
 * A client may have no account at all, and an account may be a client of several
 * firms.
 */
export interface AdminClientRecord {
  id: string;
  lawFirmId: string;
  lawFirmName: string;
  clientType: 'person' | 'company';
  userId: string | null;
  name: string;
  email: string;
  phone: string | null;
  organization: string | null;
  status: string;
  portalStatus: ClientPortalStatus;
  portalEmail: string | null;
  portalAccountCreatedAt: string | null;
  /** Portal-enabled roster contacts. Always 0 for a person client; a company has no `portalStatus` of its own. */
  rosterPortalCount: number;
  invitationFailed: boolean;
  invitedAt: string | null;
  invitationSentAt: string | null;
  joinedAt: string | null;
  createdAt: string | null;
  matterCount: number;
}

export interface UpdateLawFirmPayload {
  lawFirm?: {
    name?: string;
    description?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phone?: string;
    email?: string;
  };
  storage?: {
    quotaBytes?: number;
    hardLimit?: boolean;
    warnAtPercent?: number;
  };
}

export interface AdminMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  isOwner: boolean;
  roleId: string | null;
  roleName: string;
  joinedAt?: string | null;
}

export interface AdminRole {
  id: string;
  name: string;
  isBuiltIn: boolean;
  permissions: string[];
  createdAt?: string | null;
}

export interface AdminPendingInvite {
  id: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  invitedAt?: any;
  invitedBy: string | null;
}

export interface AdminPendingClientInvite {
  id: string;
  email: string;
  invitedAt?: any;
  invitedBy: string | null;
}

export interface AdminClient {
  id: string;
  /** The client's linked Firebase uid, null when the client has no portal account. */
  userId: string | null;
  clientType: 'person' | 'company';
  name: string;
  email: string;
  /** Portal-enabled roster contacts. Always 0 for a person client. */
  rosterPortalCount: number;
  joinedAt?: string | null;
  matterIds: string[];
}

export interface LawFirmDetailResponse {
  lawFirm: AdminLawFirm;
  members: AdminMember[];
  roles: AdminRole[];
  pendingInvites: AdminPendingInvite[];
  pendingClientInvites: AdminPendingClientInvite[];
  clients: AdminClient[];
}

export interface UpdateRolePayload {
  name?: string;
  permissions?: string[];
}

interface UpdateRoleResponse {
  message: string;
  role: AdminRole;
}

interface UpdateMemberRoleResponse {
  message: string;
  memberId: string;
  roleId: string;
  roleName: string;
}

interface LawFirmsResponse {
  lawFirms: AdminLawFirm[];
}

interface UsersResponse {
  users: AdminUser[];
}

/** Paging + search for the admin console's platform-wide tables. */
export type SortDirection = 'asc' | 'desc';

export interface AdminListQuery {
  page?: number;
  limit?: number;
  offset?: number;
  search?: string;
  /** Field name from the endpoint's whitelist; an unknown one is a 400. */
  sortBy?: string;
  order?: SortDirection;
}

export interface AdminLawFirmListQuery extends AdminListQuery {
  planId?: string;
  billingStatus?: string;
}

export interface AdminUserListQuery extends AdminListQuery {
  userType?: AdminUserType;
  isAdmin?: boolean;
  /** Matches users attached to the firm as staff OR as a portal client. */
  lawFirmId?: string;
  /** ISO instants bounding `createdAt`, for the "signed up since" windows. */
  createdAfter?: string;
  createdBefore?: string;
}

export interface AdminClientListQuery extends AdminListQuery {
  lawFirmId?: string;
  status?: string;
  portal?: ClientPortalStatus;
  clientType?: 'person' | 'company';
  createdAfter?: string;
  createdBefore?: string;
}

/** Platform-wide firm counts, unfiltered, for the console's cards. */
export interface AdminLawFirmStats {
  total: number;
  new7d: number;
  new30d: number;
  byPlan: Record<string, number>;
  byBillingStatus: Record<string, number>;
}

export interface AdminLawFirmsPage {
  lawFirms: AdminLawFirm[];
  /** Firms matching the filters, i.e. what the pager walks. */
  totalItems: number;
  /** Firms on the platform, unfiltered, for the console's total card. */
  totalFirms: number;
  stats: AdminLawFirmStats;
}

/** Platform-wide user counts, unfiltered, including the rolling signup windows. */
export interface AdminUserStats {
  total: number;
  clients: number;
  firmMembers: number;
  pending: number;
  admins: number;
  new24h: number;
  new7d: number;
  new30d: number;
}

export interface AdminUsersPage {
  users: AdminUser[];
  /** Users matching the filters, i.e. what the pager walks. */
  totalItems: number;
  /** Unfiltered platform breakdown, for the console's stat cards. */
  stats: AdminUserStats;
}

export interface AdminClientStats {
  /** Client RECORDS - a company is one row no matter how large its roster. */
  total: number;
  withPortal: number;
  invitesPending: number;
  new7d: number;
  new30d: number;
  personCount: number;
  companyCount: number;
  /** Roster contacts linked to a company client, platform-wide. */
  rosterContactTotal: number;
  /** Portal-enabled roster contacts, platform-wide. */
  rosterPortalTotal: number;
  /** Real people, not records: personCount + rosterContactTotal. */
  peopleTotal: number;
}

export interface AdminClientsPage {
  clients: AdminClientRecord[];
  totalItems: number;
  stats: AdminClientStats;
}

/** A row from the platform-wide firm typeahead. `sublabel` is plan + member count. */
export interface AdminLawFirmLookupItem {
  id: string;
  label: string;
  sublabel?: string | null;
}

/**
 * Serialize a list query into a query string.
 *
 * Every key is optional and omitted when unset, which is what preserves each
 * endpoint's "no `limit` means the whole list" contract. Booleans are sent as
 * the literals the route schemas expect, since a query string carries no types.
 */
function adminListParams(query: AdminListQuery): string {
  const params = new URLSearchParams();
  // An interface has no implicit index signature, so the entries are read
  // through a widened view rather than by declaring the parameter as a record - 
  // which would drop the type checking at every call site.
  Object.entries(query as Record<string, unknown>).forEach(([key, value]) => {
    if (value == null) return;
    if (typeof value === 'string') {
      if (!value.trim()) return;
      params.set(key, value.trim());
      return;
    }
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

interface UpdateLawFirmResponse {
  message: string;
  lawFirm: AdminLawFirm;
}

interface UpdateUserAdminResponse {
  message: string;
  user: AdminUser;
}

export interface AdminWhitelistEntry {
  email: string;
  note: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string | null;
}

interface WhitelistResponse {
  entries: AdminWhitelistEntry[];
}

export interface AuditEventLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
  coordinates: [number, number] | null;
}

export interface AdminAuditEvent {
  id: string;
  lawFirmId: string | null;
  lawFirmName: string | null;
  actorUid: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  metadata: {
    provider?: string | null;
    needsRegistration?: boolean;
    location?: AuditEventLocation | null;
    [key: string]: unknown;
  };
  createdAt: string | null;
}

export interface AuditEventsResponse {
  items: AdminAuditEvent[];
  totalItems: number;
}

export interface AuditEventsQuery {
  limit?: number;
  offset?: number;
  action?: string;
  actorUid?: string;
  lawFirmId?: string;
  /**
   * Free-text term matched server-side across actor, firm, action, IP and the
   * location/provider metadata, so it covers the whole log rather than the page
   * the caller currently holds.
   */
  search?: string;
}

export type TestAccountKind = 'firm_owner' | 'client' | 'member';

export interface CreateTestAccountPayload {
  kind: TestAccountKind;
  email: string;
  password: string;
  name: string;
  firmName?: string;
  lawFirmId?: string;
  roleId?: string;
}

export interface CreatedTestAccount {
  uid: string;
  email: string;
  password: string;
  userType: string;
  lawFirmId?: string;
  roleId?: string;
}

interface CreateTestAccountResponse {
  message: string;
  account: CreatedTestAccount;
}

class AdminService extends BaseApiService {
  constructor() {
    super('admin');
  }

  async updateLawFirmRole(
    lawFirmId: string,
    roleId: string,
    payload: UpdateRolePayload,
  ): Promise<UpdateRoleResponse> {
    return this.request(this.url('lawfirms', lawFirmId, 'roles', roleId), {
      method: 'PATCH',
      body: payload,
      errorMessage: 'Failed to update role',
    });
  }

  async updateMemberRole(
    lawFirmId: string,
    memberId: string,
    roleId: string,
  ): Promise<UpdateMemberRoleResponse> {
    return this.request(this.url('lawfirms', lawFirmId, 'members', memberId, 'role'), {
      method: 'PATCH',
      body: { roleId },
      errorMessage: 'Failed to update member role',
    });
  }

  async getLawFirmDetail(lawFirmId: string): Promise<LawFirmDetailResponse> {
    return this.dedupedGet(this.url('lawfirms', lawFirmId));
  }

  async getLawFirms(): Promise<AdminLawFirm[]> {
    const response = await this.dedupedGet<LawFirmsResponse>(this.url('lawfirms'));
    return response.lawFirms || [];
  }

  /**
   * One page of firms, filtered and counted server-side. Use this for anything
   * that renders the firm table: the set grows with the whole business, not with
   * one tenant, so `getLawFirms()` above is only for callers that genuinely need
   * every row.
   */
  async getLawFirmsPaged(query: AdminLawFirmListQuery = {}): Promise<AdminLawFirmsPage> {
    const url = `${this.url('lawfirms')}${adminListParams(query)}`;
    const response = await this.dedupedGet<Partial<AdminLawFirmsPage>>(url);

    const lawFirms = response.lawFirms || [];
    const total = response.totalFirms ?? lawFirms.length;
    return {
      lawFirms,
      totalItems: response.totalItems ?? lawFirms.length,
      totalFirms: total,
      stats: response.stats ?? { total, new7d: 0, new30d: 0, byPlan: {}, byBillingStatus: {} },
    };
  }

  /**
   * Typeahead over every firm on the platform, for admin pickers that would
   * otherwise render an unbounded firm dropdown. `ids` resolves the label of an
   * existing selection; the two modes are mutually exclusive server-side.
   */
  async lookupLawFirms(
    { search, ids, limit }: { search?: string; ids?: string[]; limit?: number } = {},
  ): Promise<{ items: AdminLawFirmLookupItem[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (search?.trim()) params.set('search', search.trim());
    if (ids?.length) params.set('ids', ids.join(','));
    if (limit != null) params.set('limit', String(limit));
    const qs = params.toString();
    const url = `${this.url('lawfirms', 'lookup')}${qs ? `?${qs}` : ''}`;
    const response = await this.dedupedGet<{
      items?: AdminLawFirmLookupItem[];
      hasMore?: boolean;
    }>(url);

    return { items: response?.items ?? [], hasMore: response?.hasMore ?? false };
  }

  async getAuditEvents(query: AuditEventsQuery = {}): Promise<AuditEventsResponse> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set('limit', String(query.limit));
    if (query.offset != null) params.set('offset', String(query.offset));
    if (query.action) params.set('action', query.action);
    if (query.actorUid) params.set('actorUid', query.actorUid);
    if (query.lawFirmId) params.set('lawFirmId', query.lawFirmId);
    if (query.search) params.set('search', query.search);
    const qs = params.toString();
    const url = `${this.url('audit-events')}${qs ? `?${qs}` : ''}`;
    return this.dedupedGet<AuditEventsResponse>(url);
  }

  async getUsers(): Promise<AdminUser[]> {
    const response = await this.dedupedGet<UsersResponse>(this.url('users'));
    return response.users || [];
  }

  /**
   * One page of platform users, filtered and counted server-side. `stats` is the
   * unfiltered platform breakdown, so the console's cards report the platform
   * rather than the current search.
   */
  async getUsersPaged(query: AdminUserListQuery = {}): Promise<AdminUsersPage> {
    const url = `${this.url('users')}${adminListParams(query)}`;
    const response = await this.dedupedGet<Partial<AdminUsersPage>>(url);

    const users = response.users || [];
    return {
      users,
      totalItems: response.totalItems ?? users.length,
      stats: response.stats ?? {
        total: users.length,
        clients: 0,
        firmMembers: 0,
        pending: 0,
        admins: 0,
        new24h: 0,
        new7d: 0,
        new30d: 0,
      },
    };
  }

  /**
   * One page of client RECORDS across every firm - the `clients` table, not the
   * login accounts `getUsersPaged` returns. Always paged: this is the largest of
   * the console's three lists and has no unpaginated callers.
   */
  async getClientsPaged(query: AdminClientListQuery = {}): Promise<AdminClientsPage> {
    const url = `${this.url('clients')}${adminListParams(query)}`;
    const response = await this.dedupedGet<Partial<AdminClientsPage>>(url);

    const clients = response.clients || [];
    return {
      clients,
      totalItems: response.totalItems ?? clients.length,
      stats: response.stats ?? {
        total: clients.length,
        withPortal: 0,
        invitesPending: 0,
        new7d: 0,
        new30d: 0,
        personCount: 0,
        companyCount: 0,
        rosterContactTotal: 0,
        rosterPortalTotal: 0,
        peopleTotal: 0,
      },
    };
  }

  async updateLawFirm(
    lawFirmId: string,
    payload: UpdateLawFirmPayload,
  ): Promise<UpdateLawFirmResponse> {
    return this.request(this.url('lawfirms', lawFirmId), {
      method: 'PATCH',
      body: payload,
      errorMessage: 'Failed to update law firm',
    });
  }

  async removeMember(
    lawFirmId: string,
    memberId: string,
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'members', memberId), {
      method: 'DELETE',
      errorMessage: 'Failed to remove member',
    });
  }

  async deletePendingInvite(
    lawFirmId: string,
    inviteId: string,
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'pending-invites', inviteId), {
      method: 'DELETE',
      errorMessage: 'Failed to delete pending invite',
    });
  }

  async deletePendingClientInvite(
    lawFirmId: string,
    inviteId: string,
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'pending-client-invites', inviteId), {
      method: 'DELETE',
      errorMessage: 'Failed to delete pending client invite',
    });
  }

  async updateUserAdmin(userId: string, isAdmin: boolean): Promise<UpdateUserAdminResponse> {
    return this.request(this.url('users', userId, 'admin'), {
      method: 'PATCH',
      body: { isAdmin },
      errorMessage: 'Failed to update user admin access',
    });
  }

  async getLawFirmPlan(lawFirmId: string): Promise<{
    lawFirm: AdminLawFirm;
    limits: Record<string, number>;
    features: Record<string, boolean>;
    usage: { matters: number; members: number; storageBytes: number };
  }> {
    return this.dedupedGet(this.url('lawfirms', lawFirmId, 'plan'));
  }

  async updateLawFirmPlan(
    lawFirmId: string,
    payload: {
      planId?: string;
      billingStatus?: string;
      comped?: boolean;
      compedReason?: string;
      unlimitedOverride?: boolean;
      trialEndsAt?: string | null;
      limitOverrides?: Record<string, number>;
      featureOverrides?: Record<string, boolean>;
    },
  ): Promise<{ message: string; lawFirm: AdminLawFirm }> {
    return this.request(this.url('lawfirms', lawFirmId, 'plan'), {
      method: 'PATCH',
      body: payload,
      errorMessage: 'Failed to update plan',
    });
  }

  async recountStorage(
    lawFirmId: string,
  ): Promise<{ message: string; usedBytes: number; fileCount: number; lawFirm: AdminLawFirm }> {
    return this.request(this.url('lawfirms', lawFirmId, 'storage', 'recount'), {
      method: 'POST',
      errorMessage: 'Failed to recount storage',
    });
  }

  async compFirm(
    lawFirmId: string,
    payload: { planId?: string; reason: string },
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'subscription', 'comp'), {
      method: 'POST',
      body: payload,
      errorMessage: 'Failed to comp firm',
    });
  }

  async adminCancelSubscription(
    lawFirmId: string,
    payload: { immediate?: boolean; reason?: string },
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'subscription', 'cancel'), {
      method: 'POST',
      body: payload,
      errorMessage: 'Failed to cancel subscription',
    });
  }

  async getWhitelist(): Promise<AdminWhitelistEntry[]> {
    const response = await this.dedupedGet<WhitelistResponse>(this.url('whitelist'));
    return response.entries || [];
  }

  async addWhitelistEntry(
    payload: { email: string; note?: string },
  ): Promise<{ message: string; email: string }> {
    return this.request(this.url('whitelist'), {
      method: 'POST',
      body: payload,
      errorMessage: 'Failed to add whitelist entry',
    });
  }

  async removeWhitelistEntry(email: string): Promise<{ message: string; email: string }> {
    return this.request(this.url('whitelist'), {
      method: 'DELETE',
      body: { email },
      errorMessage: 'Failed to remove whitelist entry',
    });
  }

  async createTestAccount(payload: CreateTestAccountPayload): Promise<CreatedTestAccount> {
    const data = await this.request<CreateTestAccountResponse>(this.url('test-accounts'), {
      method: 'POST',
      body: payload,
      errorMessage: 'Failed to create test account',
    });
    return data.account;
  }

  quotaBytesToMb(quotaBytes: number): number {
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return 1;
    return Math.max(1, Math.round((quotaBytes / BYTES_PER_MB) * 100) / 100);
  }

  quotaMbToBytes(quotaMb: number): number {
    if (!Number.isFinite(quotaMb) || quotaMb <= 0) return BYTES_PER_MB;
    return Math.max(BYTES_PER_MB, Math.round(quotaMb * BYTES_PER_MB));
  }

  /** Bytes -> MB (2-decimal), for editing per-file size limits which are MB/GB scale. */
  bytesToMb(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return 0;
    return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
  }

  /** MB -> bytes, for per-file size limits. Returns 0 for non-positive input. */
  mbToBytes(mb: number): number {
    if (!Number.isFinite(mb) || mb <= 0) return 0;
    return Math.round(mb * BYTES_PER_MB);
  }
}

const adminService = new AdminService();
export default adminService;
