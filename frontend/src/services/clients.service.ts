import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import type {
  Matter,
  Client,
  ClientContact,
  ClientCompanyRelationship,
  ClientSettings,
  ClientStatus,
  ClientType,
  PreferredContactMethod,
} from '@/types';
import type { NotesPageParams } from '@/types/note';
import { DEFAULT_CLIENT_SETTINGS } from '@/types/preferences';
import requestDeduplicator from './requestDeduplicator';
import type { ClientEvent, CreateClientEventRequest, UpdateClientEventRequest } from '@/types/clientEvent';

import type { LookupResult } from './matters.service';
import { applyListSortSearch, applyListWindow } from '@/lib/utils/listQuery';
import { authenticatedHeaders } from './base.service';
import { createNotesApi, type TimeEntryInput } from './notesApi';
import { track } from "@/lib/analytics/analytics";

const clientNotesApi = createNotesApi('clients', 'clientId');

// The lookup envelope is declared once, alongside the matters service, because
// every /lookup endpoint answers in the same shape.
export type { LookupItem, FullLookupItem, LookupResult } from './matters.service';

export interface ClientUpsertPayload {
  userId?: string;
  /**
   * Only meaningful on CREATE, immutable after insert (DB trigger). Omit on
   * update; the UI must never offer a way to change it.
   */
  clientType?: ClientType;
  name?: string;
  // null explicitly CLEARS the field; undefined leaves it unchanged.
  email?: string | null;
  phone?: string | null;
  organization?: string | null;
  address?: string | null;
  preferredContactMethod?: PreferredContactMethod | null;
  status?: ClientStatus;
  matterIds?: string[];
  portalInvitePending?: boolean;
}

export interface ClientMattersUpdateResponse {
  message: string;
  added: string[];
  failed: Array<{ matterId: string; error: string }>;
}

export interface CreateClientResponse {
  message: string;
  clientId: string;
  // 'invite_failed' = the client row WAS created, but the portal invite email
  // failed to send (non-fatal on the backend). The UI must surface this so the
  // firm knows to resend the invite.
  portalStatus?: 'added' | 'invited' | 'none' | 'invite_failed';
}

export interface InviteClientResponse {
  message: string;
  status?: 'added' | 'invited';
  email?: string;
  token?: string;
  inviteUrl?: string;
  clientId?: string;
}

export interface AssociateClientResponse {
  message: string;
  clientId: string;
}

export interface PendingClientInvite {
  id: string;
  email: string;
  invitedAt?: string;
  invitationSentAt?: string;
  invitationFailed?: boolean;
  invitationResendCount?: number;
  status: 'pending';
}

export interface ResendInvitationResponse {
  message: string;
  sent: boolean;
  resendCount: number;
}

/**
 * Add a related contact to a PERSON client (guardian, assistant, etc.),
 * unchanged. `contactId` links someone already in the firm directory, or the
 * identity fields create the directory record and link it in one step.
 */
export interface CreatePersonRelatedContactPayload {
  contactId?: string;
  relationship?: string;
  isPrimary?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  notes?: string;
}

/**
 * Add a person to a COMPANY client's roster (organization-clients plan).
 * `personClientId` links a Person client already in the firm, or the identity
 * fields create a brand-new Person client and link it in one step. No
 * `title`/`notes` · a Person client has neither.
 */
export interface CreateCompanyRosterContactPayload {
  personClientId?: string;
  relationship?: string;
  isPrimary?: boolean;
  isEmailRecipient?: boolean;
  canViewBilling?: boolean;
  name?: string;
  email?: string;
  phone?: string;
}

/**
 * The same create endpoint serves both a PERSON client's related contacts and
 * a COMPANY client's roster; which shape to send depends on the owning
 * client's own `clientType`.
 */
export type CreateClientContactPayload = CreatePersonRelatedContactPayload | CreateCompanyRosterContactPayload;

/** Patches a PERSON client's related contact - unchanged. */
export interface UpdatePersonRelatedContactPayload {
  name?: string;
  // null explicitly CLEARS the field; undefined leaves it unchanged.
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  relationship?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

/**
 * Patches a COMPANY roster link. Link-only: the linked person's own
 * name/email/phone are edited through the ordinary client update endpoint
 * instead, since they belong to that person's own `clients` row.
 */
export interface UpdateCompanyRosterLinkPayload {
  relationship?: string | null;
  isPrimary?: boolean;
  isEmailRecipient?: boolean;
  canViewBilling?: boolean;
}

export type UpdateClientContactPayload = UpdatePersonRelatedContactPayload | UpdateCompanyRosterLinkPayload;

function asRecord(value: unknown): Record<string, any> {
  if (typeof value === 'object' && value !== null) return value as Record<string, any>;
  return {};
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Timestamp columns serialize to ISO strings, and occasionally a Date.
function timestampToIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function normalizeClient(raw: unknown): Client {
  const record = asRecord(raw);
  const id =
    asString(record.id) ||
    asString(record.clientId) ||
    asString(record.userId) ||
    '';

  const normalizedStatus = asString(record.status);
  const status: ClientStatus =
    normalizedStatus === 'archived' || normalizedStatus === 'inactive' ? normalizedStatus : 'active';

  const normalizedContactMethod = asString(record.preferredContactMethod);
  const preferredContactMethod: PreferredContactMethod =
    normalizedContactMethod === 'phone' ||
    normalizedContactMethod === 'sms' ||
    normalizedContactMethod === 'portal'
      ? normalizedContactMethod
      : 'email';

  const clientType: ClientType = record.clientType === 'company' ? 'company' : 'person';

  return {
    id,
    userId: asString(record.userId),
    lawFirmId: asString(record.lawFirmId) || undefined,
    clientType,
    name: asString(record.name),
    email: asString(record.email),
    phone: asString(record.phone),
    organization: asString(record.organization),
    address: asString(record.address),
    status,
    preferredContactMethod,
    matterIds: asArray<string>(record.matterIds).filter(Boolean),
    // Only the list endpoint aggregates this; leave it undefined elsewhere so a
    // detail response can't render a misleading "0 tasks".
    taskCount: typeof record.taskCount === 'number' ? record.taskCount : undefined,
    // Same: only the paged list endpoint aggregates the roster contact count.
    contactCount: typeof record.contactCount === 'number' ? record.contactCount : undefined,
    companyNames: asArray<string>(record.companyNames).filter((name) => typeof name === 'string' && name.trim().length > 0),
    invitedBy: asString(record.invitedBy) || undefined,
    invitedAt: timestampToIso(record.invitedAt),
    joinedAt: timestampToIso(record.joinedAt),
    portalInvitePending: record.portalInvitePending === true,
    createdAt: timestampToIso(record.createdAt),
    updatedAt: timestampToIso(record.updatedAt),
  };
}

/**
 * The list/create/update/delete client-contact endpoints serve both a PERSON
 * client's related contacts and a COMPANY client's roster, dispatched
 * server-side on the target client's own `clientType`. The two response
 * shapes are told apart the same way `ClientContact` itself is: a roster row
 * carries `personClientId`, a related-contact row carries `contactId`.
 */
function normalizeClientContact(raw: unknown, lawFirmId: string, clientId: string): ClientContact {
  const record = asRecord(raw);
  const personClientId = asString(record.personClientId);
  if (personClientId) {
    return {
      // `id` is the LINK id, `personClientId` the linked Person client behind it.
      id: asString(record.id) || '',
      personClientId,
      clientId,
      lawFirmId,
      name: asString(record.name) || 'Unnamed Contact',
      email: asString(record.email),
      phone: asString(record.phone),
      status: (asString(record.status) as ClientStatus) || undefined,
      relationship: asString(record.relationship),
      isPrimary: record.isPrimary === true,
      isEmailRecipient: record.isEmailRecipient === true,
      canViewBilling: record.canViewBilling === true,
      userId: asString(record.userId),
      portalInvitePending: record.portalInvitePending === true,
      invitedAt: timestampToIso(record.invitedAt) || null,
      joinedAt: timestampToIso(record.joinedAt) || null,
      createdBy: asString(record.createdBy) || undefined,
      createdAt: timestampToIso(record.createdAt),
      updatedAt: timestampToIso(record.updatedAt),
    };
  }
  return {
    // `id` is the LINK id, `contactId` the directory record behind it.
    id: asString(record.id) || '',
    contactId: asString(record.contactId) || '',
    clientId,
    lawFirmId,
    name: asString(record.name) || 'Unnamed Contact',
    email: asString(record.email),
    phone: asString(record.phone),
    title: asString(record.title),
    organization: asString(record.organization),
    relationship: asString(record.relationship),
    notes: asString(record.notes),
    isPrimary: record.isPrimary === true,
    isEmailRecipient: record.isEmailRecipient === true,
    canViewBilling: record.canViewBilling === true,
    createdBy: asString(record.createdBy) || undefined,
    createdAt: timestampToIso(record.createdAt),
    updatedAt: timestampToIso(record.updatedAt),
  };
}

export interface ClientSummary {
  clientId: string;
  matters: { count: number } | null;
  billing: {
    invoiceCount: number;
    totalBilledCents: number;
    totalPaidCents: number;
    /** Billed minus paid, not clamped at zero. */
    outstandingCents: number;
  } | null;
}

class ClientsService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private clientsBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/clients`;
  }

  private clientUrl(lawFirmId: string, clientId: string): string {
    return `${this.clientsBase(lawFirmId)}/${encodeURIComponent(clientId)}`;
  }

  private invitationsBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/invitations`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders(extra);
  }

  async listClients(lawFirmId: string): Promise<Client[]> {
    const url = this.clientsBase(lawFirmId);
    const headers = await this.authHeaders();

    const response = await requestDeduplicator.execute<{ clients?: unknown[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId },
    });

    return asArray(response?.clients)
      .map((client) => normalizeClient(client))
      .filter((client) => Boolean(client.id));
  }

  /**
   * Get one server-paged, filtered, sorted window of clients.
   *
   * `listClients()` (above) still returns the FULL list, which the pickers and the
   * other whole-set consumers need. This variant pushes the paging, search and
   * ordering into the backend (`clients.validation.js` -> `clients.repository.js`)
   * and returns the page plus `totalItems`, the full size of the filtered result
   * set, so a caller can render correct page controls without fetching every row.
   *
   * `sort` is the ordered multi-column model, serialized as "field:dir,field:dir".
   * Only the backend's whitelisted fields are accepted (name, email, organization,
   * createdAt); anything else is rejected with a 400.
   */
  async listClientsPaged(
    lawFirmId: string,
    params: {
      page?: number;
      limit?: number;
      offset?: number;
      search?: string;
      portalOnly?: boolean;
      /** Only the clients linked to this matter. */
      matterId?: string;
      status?: string;
      clientType?: ClientType;
      sortBy?: string;
      order?: 'asc' | 'desc';
      sort?: Array<{ field: string; sort: 'asc' | 'desc' }>;
    } = {},
  ): Promise<{ clients: Client[]; totalItems: number }> {
    const url = new URL(this.clientsBase(lawFirmId));
    applyListWindow(url, params, { maxLimit: 500 });

    if (params.portalOnly) url.searchParams.set('portalOnly', 'true');
    if (params.matterId) url.searchParams.set('matterId', params.matterId);
    if (params.status) url.searchParams.set('status', params.status);
    if (params.clientType) url.searchParams.set('clientType', params.clientType);
    applyListSortSearch(url, params);

    const response = await requestDeduplicator.execute<{ clients?: unknown[]; totalItems?: number }>(
      url.toString(),
      {
        method: 'GET',
        headers: await this.authHeaders({ 'X-Timezone': getUserTimeZone() }),
      },
    );

    const clients = asArray(response?.clients)
      .map((client) => normalizeClient(client))
      .filter((client) => Boolean(client.id));

    return { clients, totalItems: response?.totalItems ?? clients.length };
  }

  async listPortalClients(lawFirmId: string): Promise<Client[]> {
    const url = `${this.clientsBase(lawFirmId)}?portalOnly=true`;
    const headers = await this.authHeaders();

    const response = await requestDeduplicator.execute<{ clients?: unknown[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, portalOnly: true },
    });

    return asArray(response?.clients)
      .map((client) => normalizeClient(client))
      .filter((client) => Boolean(client.id));
  }

  /**
   * Typeahead lookup for client pickers - DEDUPLICATED.
   *
   * `search` and `ids` are mutually exclusive server-side: pass `ids` to resolve
   * labels for values a form already holds, `search` to find new ones. An `ids`
   * request that matches nothing comes back empty rather than falling back to an
   * arbitrary page, so a stale id never renders as some unrelated client.
   */
  async lookupClients(
    lawFirmId: string,
    {
      search,
      exactName,
      exactOrganization,
      excludeId,
      ids,
      userIds,
      portalOnly,
      limit,
      matterId,
      clientType,
      excludeArchived,
      excludeLinkedToClientId,
      full,
    }: {
      search?: string;
      exactName?: string;
      /** Exact, case-insensitive organization match, e.g. "colleagues at this organization." */
      exactOrganization?: string;
      /** Drops one client id from the result, so a client never appears in its own lookup. */
      excludeId?: string;
      ids?: string[];
      /**
       * Resolves labels the same way `ids` does, but keyed on each client's
       * linked portal Firebase UID. Pickers whose value identifies a person
       * rather than a client record (messaging participants are stored by UID)
       * hold no client-row id to resolve, so this is the only key that works for
       * them. The server rejects a request that sends both this and `ids`.
       */
      userIds?: string[];
      portalOnly?: boolean;
      limit?: number;
      /**
       * Restricts the result to clients linked to this matter. A value that
       * resolves to nothing yields an empty list rather than the unscoped one,
       * so a scoped picker can never silently offer unrelated clients.
       */
      matterId?: string;
      /** Restricts the result to one client type ('person' or 'company'). */
      clientType?: 'person' | 'company';
      /**
       * Drops archived clients from the browsable result, for pickers that attach
       * a client to new work. It excludes ONLY `archived`; `inactive` clients stay
       * selectable. The server deliberately ignores it in `ids` mode, so a record
       * saved before its client was archived still resolves that client's name.
       */
      excludeArchived?: boolean;
      /**
       * Drops clients already linked to this company client, for the "add an
       * existing client" picker on a company's Related Clients tab, so it
       * cannot offer someone the link endpoint would then reject as a
       * duplicate. Malformed/unresolvable values are ignored server-side
       * rather than erroring.
       */
      excludeLinkedToClientId?: string;
      /**
       * Returns the enriched client on each item (still carrying `label` and
       * `sublabel`), for callers that need the whole record rather than a label.
       */
      full?: boolean;
    } = {},
  ): Promise<LookupResult> {
    const url = new URL(`${this.clientsBase(lawFirmId)}/lookup`);
    if (search) url.searchParams.set('search', search);
    if (exactName) url.searchParams.set('exactName', exactName);
    if (exactOrganization) url.searchParams.set('exactOrganization', exactOrganization);
    if (excludeId) url.searchParams.set('excludeId', excludeId);
    if (ids?.length) url.searchParams.set('ids', ids.join(','));
    if (userIds?.length) url.searchParams.set('userIds', userIds.join(','));
    if (portalOnly) url.searchParams.set('portalOnly', 'true');
    if (limit != null) url.searchParams.set('limit', String(limit));
    if (matterId) url.searchParams.set('matterId', matterId);
    if (clientType) url.searchParams.set('clientType', clientType);
    if (excludeArchived) url.searchParams.set('excludeArchived', 'true');
    if (excludeLinkedToClientId) url.searchParams.set('excludeLinkedToClientId', excludeLinkedToClientId);
    if (full) url.searchParams.set('full', 'true');

    const response = await requestDeduplicator.execute<Partial<LookupResult>>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders({ 'X-Timezone': getUserTimeZone() }),
    });

    return { items: response?.items ?? [], hasMore: response?.hasMore ?? false };
  }

  /**
   * The client page's header figures, counted by the server: how many matters
   * the member can see for this client (linked companies' included, every
   * status) and the owned-invoice billing totals in cents. A section is null
   * when the member lacks `matters.view` or `billing.viewInvoices`.
   */
  async getClientSummary(lawFirmId: string, clientId: string): Promise<ClientSummary> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/summary`;
    const headers = await this.authHeaders();
    return requestDeduplicator.execute<ClientSummary>(url, { method: 'GET', headers });
  }

  async getClient(lawFirmId: string, clientId: string): Promise<Client> {
    const url = this.clientUrl(lawFirmId, clientId);
    const headers = await this.authHeaders();

    const response = await requestDeduplicator.execute<unknown>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    const record = asRecord(response);
    const candidate = record.client ? record.client : record;
    return normalizeClient(candidate);
  }

  async createClient(lawFirmId: string, payload: ClientUpsertPayload): Promise<CreateClientResponse> {
    const url = this.clientsBase(lawFirmId);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create client', { method: 'POST', url });
    }

    return response.json();
  }

  async updateClient(
    lawFirmId: string,
    clientId: string,
    payload: ClientUpsertPayload,
  ): Promise<{ message: string }> {
    const url = this.clientUrl(lawFirmId, clientId);
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update client', { method: 'PUT', url });
    }

    return response.json();
  }

  async archiveClient(lawFirmId: string, clientId: string): Promise<{ message: string }> {
    return this.updateClient(lawFirmId, clientId, { status: 'archived' });
  }

  async deleteClient(lawFirmId: string, clientId: string): Promise<{ message: string }> {
    const url = this.clientUrl(lawFirmId, clientId);
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove client', { method: 'DELETE', url });
    }

    return response.json();
  }

  async revokePortalAccess(lawFirmId: string, clientId: string): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/revoke-portal-access`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to revoke portal access', { method: 'POST', url });
    }

    return response.json();
  }

  async addClientMatters(
    lawFirmId: string,
    clientId: string,
    matterIds: string[],
  ): Promise<ClientMattersUpdateResponse> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/matters`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ matterIds }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update client matter associations', {
        method: 'POST',
        url,
      });
    }

    return response.json();
  }

  async removeClientMatter(
    lawFirmId: string,
    clientId: string,
    matterId: string,
  ): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/matters/${encodeURIComponent(matterId)}`;
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove matter association', {
        method: 'DELETE',
        url,
      });
    }

    return response.json();
  }

  async listClientMatters(lawFirmId: string, clientId: string): Promise<Matter[]> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/matters`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ matters?: Matter[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    return asArray<Matter>(response?.matters);
  }

  async listClientTasks(lawFirmId: string, clientId: string): Promise<{ id: string; title: string }[]> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/tasks`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ tasks?: { id: string; title: string }[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    return asArray<{ id: string; title: string }>(response?.tasks);
  }

  /**
   * Client notes are the same feature as matter/task notes (rich content,
   * pinning, retraction, replies, time entries billed directly to the
   * client), sharing one implementation with them - see `notesApi.ts`.
   */
  async listClientNotes(lawFirmId: string, clientId: string, params: NotesPageParams = {}) {
    return clientNotesApi.listNotes(lawFirmId, clientId, params);
  }
  async getClientNote(lawFirmId: string, clientId: string, noteId: string) {
    return clientNotesApi.getNoteDetail(lawFirmId, clientId, noteId);
  }
  async addClientNote(lawFirmId: string, clientId: string, noteData: Parameters<typeof clientNotesApi.addNote>[2]) {
    return clientNotesApi.addNote(lawFirmId, clientId, noteData);
  }
  async updateClientNote(lawFirmId: string, clientId: string, noteId: string, noteData: Parameters<typeof clientNotesApi.updateNote>[3]) {
    return clientNotesApi.updateNote(lawFirmId, clientId, noteId, noteData);
  }
  async retractClientNote(lawFirmId: string, clientId: string, noteId: string, reason?: string) {
    return clientNotesApi.retractNote(lawFirmId, clientId, noteId, reason);
  }
  async addClientNoteTimeEntry(lawFirmId: string, clientId: string, noteId: string, entry: TimeEntryInput) {
    return clientNotesApi.addNoteTimeEntry(lawFirmId, clientId, noteId, entry);
  }
  async updateClientNoteTimeEntry(lawFirmId: string, clientId: string, noteId: string, timeEntryId: string, entry: TimeEntryInput) {
    return clientNotesApi.updateNoteTimeEntry(lawFirmId, clientId, noteId, timeEntryId, entry);
  }
  async removeClientNoteTimeEntry(lawFirmId: string, clientId: string, noteId: string, timeEntryId: string) {
    return clientNotesApi.removeNoteTimeEntry(lawFirmId, clientId, noteId, timeEntryId);
  }
  async setClientNotePinned(lawFirmId: string, clientId: string, noteId: string, pinned: boolean) {
    return clientNotesApi.setNotePinned(lawFirmId, clientId, noteId, pinned);
  }
  async listClientNoteVersions(lawFirmId: string, clientId: string, noteId: string) {
    return clientNotesApi.listNoteVersions(lawFirmId, clientId, noteId);
  }
  async listClientNoteReplies(lawFirmId: string, clientId: string, noteId: string) {
    return clientNotesApi.listNoteReplies(lawFirmId, clientId, noteId);
  }
  async addClientNoteReply(lawFirmId: string, clientId: string, noteId: string, reply: Parameters<typeof clientNotesApi.addNoteReply>[3]) {
    return clientNotesApi.addNoteReply(lawFirmId, clientId, noteId, reply);
  }
  async updateClientNoteReply(lawFirmId: string, clientId: string, noteId: string, replyId: string, reply: Parameters<typeof clientNotesApi.updateNoteReply>[4]) {
    return clientNotesApi.updateNoteReply(lawFirmId, clientId, noteId, replyId, reply);
  }
  async retractClientNoteReply(lawFirmId: string, clientId: string, noteId: string, replyId: string, reason?: string) {
    return clientNotesApi.retractNoteReply(lawFirmId, clientId, noteId, replyId, reason);
  }

  async listClientContacts(lawFirmId: string, clientId: string): Promise<ClientContact[]> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/contacts`;
    const headers = await this.authHeaders();

    const response = await requestDeduplicator.execute<{ contacts?: unknown[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    return asArray(response?.contacts)
      .map((contact) => normalizeClientContact(contact, lawFirmId, clientId))
      .filter((contact) => Boolean(contact.id));
  }

  /** Company memberships for a Person client, including link-owned access flags. */
  async listClientCompanyRelationships(
    lawFirmId: string,
    clientId: string,
  ): Promise<ClientCompanyRelationship[]> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/company-relationships`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ relationships?: ClientCompanyRelationship[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    return asArray<ClientCompanyRelationship>(response?.relationships)
      .filter((relationship) => Boolean(relationship.id && relationship.companyClientId))
      .map((relationship) => ({
        ...relationship,
        // Normalized so a caller can compare it without guarding for undefined
        // against an older backend that predates the field.
        companyEmailRecipientCount: Number(relationship.companyEmailRecipientCount) || 0,
      }));
  }

  async createClientContact(
    lawFirmId: string,
    clientId: string,
    payload: CreateClientContactPayload,
  ): Promise<{ message: string; contactId: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/contacts`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create client contact', { method: 'POST', url });
    }

    return response.json();
  }

  /**
   * Edit a person on a client. `linkId` is `ClientContact.id`. Name, email,
   * phone, title and notes belong to the shared directory record, so changing
   * one of those changes it everywhere that person appears.
   */
  async updateClientContact(
    lawFirmId: string,
    clientId: string,
    linkId: string,
    payload: UpdateClientContactPayload,
  ): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/contacts/${encodeURIComponent(linkId)}`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update client contact', { method: 'PUT', url });
    }

    return response.json();
  }

  /** Take a person off a client. The directory record survives. */
  async deleteClientContact(
    lawFirmId: string,
    clientId: string,
    linkId: string,
  ): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/contacts/${encodeURIComponent(linkId)}`;
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove client contact', { method: 'DELETE', url });
    }

    return response.json();
  }

  async getClientSettings(lawFirmId: string, clientId: string): Promise<ClientSettings> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/settings`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ settings?: ClientSettings }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });

    return {
      notifications: {
        ...DEFAULT_CLIENT_SETTINGS.notifications,
        ...(response.settings?.notifications || {}),
      },
      communication: {
        ...DEFAULT_CLIENT_SETTINGS.communication,
        ...(response.settings?.communication || {}),
      },
      portal: {
        ...DEFAULT_CLIENT_SETTINGS.portal,
        ...(response.settings?.portal || {}),
      },
    };
  }

  async updateClientSettings(
    lawFirmId: string,
    clientId: string,
    settings: Partial<ClientSettings>,
  ): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/settings`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ settings }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update client settings', { method: 'PUT', url });
    }

    return response.json();
  }

  async inviteClientToLawFirm(email: string, lawFirmId: string): Promise<InviteClientResponse> {
    const url = `${this.invitationsBase(lawFirmId)}/send-client-invite`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: asStringOrUndefined(email) || email }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to invite client', { method: 'POST', url });
    }

    track("client_invited");
    return response.json();
  }

  async listPendingClientInvites(lawFirmId: string): Promise<PendingClientInvite[]> {
    const url = `${this.invitationsBase(lawFirmId)}/pending-client-invites`;
    const headers = await this.authHeaders();

    const response = await requestDeduplicator.execute<{ invites?: unknown[] }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId },
    });

    return asArray(response?.invites).map((invite) => {
      const record = asRecord(invite);
      return {
        id: asString(record.id) || '',
        email: asString(record.email) || '',
        invitedAt: timestampToIso(record.invitedAt),
        invitationSentAt: timestampToIso(record.invitationSentAt),
        invitationFailed: record.invitationFailed === true,
        invitationResendCount: typeof record.invitationResendCount === 'number' ? record.invitationResendCount : 0,
        status: 'pending' as const,
      };
    });
  }

  /** Revoke (cancel) a pending client invitation before it is accepted/expires. */
  async revokeClientInvitation(
    lawFirmId: string,
    inviteId: string,
  ): Promise<{ message: string; inviteId: string }> {
    const url = `${this.invitationsBase(lawFirmId)}/client-invites/${encodeURIComponent(inviteId)}/revoke`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to cancel client invitation', { method: 'POST', url });
    }

    return response.json();
  }

  async resendClientInvitation(lawFirmId: string, clientId: string): Promise<ResendInvitationResponse> {
    const url = `${this.invitationsBase(lawFirmId)}/resend-client-invite`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to resend invitation', { method: 'POST', url });
    }

    return response.json();
  }

  /**
   * Firm-wide standalone client events for the calendar. `window` bounds the read
   * to the days being drawn; omitting it returns every event.
   */
  async listAllClientEvents(
    lawFirmId: string,
    window?: { from: string; to: string },
  ): Promise<{ events: ClientEvent[]; totalEvents: number }> {
    const base = `${this.clientsBase(lawFirmId)}/events`;
    const url = window ? `${base}?from=${window.from}&to=${window.to}` : base;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ events?: ClientEvent[]; totalEvents?: number }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId },
    });
    return { events: Array.isArray(response?.events) ? response.events : [], totalEvents: response?.totalEvents ?? 0 };
  }

  async listClientEvents(
    lawFirmId: string,
    clientId: string,
  ): Promise<{ events: ClientEvent[]; totalEvents: number }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/events`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ events?: ClientEvent[]; totalEvents?: number }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });
    return { events: Array.isArray(response?.events) ? response.events : [], totalEvents: response?.totalEvents ?? 0 };
  }

  /**
   * One status section of the client's events, paged by the server. Serves the
   * LIST only; blocking reads the graph above.
   */
  async getEventsPage(
    lawFirmId: string,
    clientId: string,
    params: { status?: string; page?: number; limit?: number },
  ): Promise<{ events: ClientEvent[]; totalEvents: number }> {
    // The window has to be on the URL, not only in the deduplicator's key: the
    // key decides which in-flight requests coalesce, the query string is what the
    // server actually reads. Sending it in one and not the other is how every
    // page of this list came back holding the same rows.
    const url = new URL(`${this.clientUrl(lawFirmId, clientId)}/events`);
    if (params.status) url.searchParams.set('status', params.status);
    if (params.page) url.searchParams.set('page', String(params.page));
    if (params.limit) url.searchParams.set('limit', String(params.limit));

    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ events?: ClientEvent[]; totalEvents?: number }>(
      url.toString(),
      {
        method: 'GET',
        headers,
        params: { lawFirmId, clientId, ...params },
      },
    );
    return {
      events: Array.isArray(response?.events) ? response.events : [],
      totalEvents: response?.totalEvents ?? 0,
    };
  }

  async createClientEvent(
    lawFirmId: string,
    clientId: string,
    payload: CreateClientEventRequest,
  ): Promise<{ message: string; eventId: string; event: ClientEvent }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/events`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to create event', { method: 'POST', url });
    }
    return response.json();
  }

  async updateClientEvent(
    lawFirmId: string,
    clientId: string,
    eventId: string,
    payload: UpdateClientEventRequest,
  ): Promise<{ message: string; event: ClientEvent }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/events/${encodeURIComponent(eventId)}`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update event', { method: 'PUT', url });
    }
    return response.json();
  }

  async deleteClientEvent(
    lawFirmId: string,
    clientId: string,
    eventId: string,
    source: 'matter' | 'client',
    matterId?: string,
  ): Promise<{ message: string }> {
    const params = new URLSearchParams({ source });
    if (matterId) params.set('matterId', matterId);
    const url = `${this.clientUrl(lawFirmId, clientId)}/events/${encodeURIComponent(eventId)}?${params}`;
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete event', { method: 'DELETE', url });
    }
    return response.json();
  }

  async associateClientDirect(email: string, lawFirmId: string): Promise<AssociateClientResponse> {
    const url = `${this.invitationsBase(lawFirmId)}/associate-client-direct`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: asStringOrUndefined(email) || email }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to associate client', { method: 'POST', url });
    }

    return response.json();
  }

  async getClientBillingRates(lawFirmId: string, clientId: string): Promise<{ billingRates: { defaultRate?: number | null; memberRates?: Record<string, number> } }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/billing-rates`;
    const headers = await this.authHeaders();
    const response = await requestDeduplicator.execute<{ billingRates: { defaultRate?: number | null; memberRates?: Record<string, number> } }>(url, {
      method: 'GET',
      headers,
      params: { lawFirmId, clientId },
    });
    return response;
  }

  async updateClientBillingRates(
    lawFirmId: string,
    clientId: string,
    payload: { defaultRate?: number | null; memberRates?: Record<string, number> },
  ): Promise<{ message: string }> {
    const url = `${this.clientUrl(lawFirmId, clientId)}/billing-rates`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update client billing rates', { method: 'PUT', url });
    }
    return response.json();
  }
}

const clientsService = new ClientsService();
export default clientsService;
