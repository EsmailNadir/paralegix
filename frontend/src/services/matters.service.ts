import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError, ApiError } from '@/lib/utils/apiErrors';
import type {
  Matter, MatterClient, Category, Client,
  MatterContact, MatterActivity, MatterFieldDef, MatterStage, MatterStagePipeline, ConflictCheckRecord,
  ConflictCheckResult, BulkResult,
} from '@/types';
import type { Note } from '@/types';
import type { NotesPageParams, NotesPageResult, NoteLink } from '@/types/note';
import requestDeduplicator from './requestDeduplicator';
import { applyListSortSearch, applyListWindow, applyNotesPageParams } from '@/lib/utils/listQuery';
import { authenticatedHeaders } from './base.service';
import { createNotesApi, type TimeEntryInput } from './notesApi';

const matterNotesApi = createNotesApi('matters', 'matterId');

/**
 * The server's cap on `matterIds` per batch clients request. Over it the route
 * answers 400, so `listClientsForMatters` chunks rather than letting a caller
 * discover the limit as an error. Mirrors `MAX_BATCH_MATTER_IDS` in
 * `backend/src/modules/matters/clients/matterClients.validation.ts`.
 */
const MAX_BATCH_MATTER_IDS = 100;

/** What one member being removed from a matter still has assigned on it. */
export interface MemberRemovalPreviewUser {
  userId: string;
  openTasks: number;
  upcomingEvents: number;
  reminderSlots: number;
}

export interface MemberRemovalPreview {
  users: MemberRemovalPreviewUser[];
}

/**
 * Matter attribute fields shared by create + update: the pipeline stage, billing
 * preferences, key dates, and custom-field values. All optional. `budget` is in
 * dollars (the backend converts to cents). Dates are 'YYYY-MM-DD' or '' to clear.
 */
export interface MatterAttributeFields {
  stageId?: string | null;
  stagePipelineId?: string | null;
  billingMethod?: 'hourly' | 'flat' | 'contingency' | 'pro_bono';
  isBillable?: boolean;
  budget?: number | null;
  budgetIncludesExpenses?: boolean;
  contingencyPercent?: number | null;
  openDate?: string | null;
  closeDate?: string | null;
  statuteOfLimitationsDate?: string | null;
  customFields?: Record<string, unknown>;
}

/**
 * Backend returns { message, matterId } when creating a matter.
 */
export interface CreateMatterResponse {
  message: string;
  matterId: string;
}

export interface CreateMatterClientInput {
  userId?: string;
  name: string;
  email?: string;
  phone?: string;
  organization?: string;
  address?: string;
  preferredContactMethod?: string; // 'email' | 'phone' | 'sms' etc.
}

export interface CreateMatterRequest {
  name: string;
  lawFirmId: string;
  description?: string;
  matterNumber?: string;
  category?: string;

  // optional extras supported by the matter-create endpoint
  practiceAreaId?: string;
  practiceAreaName?: string;
  courtId?: string;
  courtName?: string;

  // backing firm-client records created + linked to the matter at creation time
  clients?: CreateMatterClientInput[];

  // Responsible attorneys (firm-member user ids). A matter can have zero, one, or
  // many leads. If omitted, the creator becomes the sole lead.
  leadUserIds?: string[];
}
export interface CreateMatterRequest extends MatterAttributeFields {}

export interface UpdateMatterRequest {
  matterId: string;
  lawFirmId: string;

  // simple fields
  name?: string;
  matterNumber?: string;
  description?: string;
  status?: string;
  // manual "payment ongoing" override
  paymentOngoing?: boolean;
  category?: string;

  // practice area (if provided, service verifies on backend)
  practiceAreaId?: string;

  // court
  courtId?: string;

  // Lead change. `leadUserIds` REPLACES the full lead set (an empty array clears
  // all leads); omitting it leaves the leads unchanged. The backend validates
  // every lead is a firm member.
  leadUserIds?: string[];
}
export interface UpdateMatterRequest extends MatterAttributeFields {}

export interface AddClientRequest {
  lawFirmId: string;
  matterId: string;
  client: {
    clientId?: string;
    userId?: string;
    /**
     * Only applied when this creates a brand-new client (no matching clientId
     * or userId); an existing client keeps its own immutable type. Omit for
     * the compatibility default ('person').
     */
    clientType?: "person" | "company";
    name: string;
    email?: string;
    phone?: string;
    organization?: string;
    address?: string;
    /** null records "no preference"; leaving it out takes the 'email' default. */
    preferredContactMethod?: string | null;
  };
}

export interface AddClientResponse {
  message: string;
  clientId: string;
}


export interface RemoveClientRequest {
  lawFirmId: string;
  matterId: string;
  clientId: string; // firm client uuid linked to the matter via matter_clients
}

export interface UpdateClientProfileRequest {
  lawFirmId: string;
  clientId: string;
  client: {
    name?: string;
    /** `null` clears the field; leaving it out leaves it as it is. */
    email?: string | null;
    phone?: string | null;
    organization?: string | null;
    address?: string | null;
    preferredContactMethod?: string | null;
    status?: 'active' | 'inactive' | 'archived';
  };
}

/**
 * One row from a `/lookup` typeahead endpoint. Shared by matters, clients and
 * tasks so a single picker component can render any of them: `id` + `label` are
 * always present, the rest are entity-specific extras.
 */
export interface LookupItem {
  id: string;
  label: string;
  sublabel?: string | null;
  status?: string | null;
  /**
   * Clients only: the client's linked portal Firebase UID, or null when the
   * client has no portal account. It identifies the PERSON, whereas `id`
   * identifies the `clients` row, and the two are different values. Anything
   * addressed to a human (an e-signature recipient, a portal notification) must
   * use this, never `id`. A `portalOnly` lookup returns it non-null on every
   * row; an unscoped one can return null.
   */
  userId?: string | null;
  /** Matters only: lets task forms prefill their court from the chosen matter. */
  courtId?: string | null;
  courtName?: string | null;
  /** Matters only: the matter's own reference number. */
  matterNumber?: string | null;
  /**
   * Tasks only: enough of the task to render a search result as a task row
   * (priority dot, due-date label) without a second read. `dueDate` is day-only
   * ('YYYY-MM-DD'), so parse it with `toLocalDate` rather than `new Date`.
   */
  priority?: string | null;
  dueDate?: string | null;
  /** Contacts only: what this contact usually is, so callers can prefill a per-matter role from it. */
  category?: string | null;
  /** Clients only: 'person' or 'company', immutable after creation. */
  clientType?: 'person' | 'company' | null;
  /**
   * Clients only: how many people are linked to a company (`client_company_links`).
   * Always present for a company row, undefined for a person row.
   */
  contactCount?: number | null;
}

/**
 * A row from a `full=true` matters or clients lookup. Alongside label/sublabel
 * it carries every enriched field of the underlying record, so callers that
 * need the whole thing (template merge fields, the time-entry target) can read
 * it straight off the option.
 *
 * The index signature lives here rather than on `LookupItem` so ordinary slim
 * rows stay strictly typed: on a plain `LookupItem`, a misspelled or absent
 * field is a compile error instead of silently widening to `unknown`.
 */
export type FullLookupItem = LookupItem & Record<string, unknown>;

/**
 * `/lookup` envelope. `hasMore` (rather than a total) says the result set was
 * truncated, so the picker can prompt the user to narrow the search.
 *
 * Generic over the row type so a `full=true` caller can ask for
 * `LookupResult<FullLookupItem>` without widening every other lookup.
 */
export interface LookupResult<T extends LookupItem = LookupItem> {
  items: T[];
  hasMore: boolean;
}

class MattersService {
  private baseApi: string;

  constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.baseApi = API_URL.replace(/\/$/, ''); // ensure no trailing slash
  }

  private getLawFirmMattersUrl(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matters`;
  }

  private getLawFirmMatterUrl(lawFirmId: string, matterId: string): string {
    return `${this.getLawFirmMattersUrl(lawFirmId)}/${encodeURIComponent(matterId)}`;
  }

  private getLawFirmClientUrl(lawFirmId: string, clientId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/clients/${encodeURIComponent(clientId)}`;
  }

  /** Shared credential/header builder, delegating to the app-wide helper. */
  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders(extra);
  }

  /**
   * Shared mutation helper for the homogeneous methods that previously repeated
   * the exact same `apiFetch` + headers + error-parse + throw pattern.
   *
   * Request contract:
   * - Always sends `Authorization: Bearer <token>` (omitted rather than `Bearer
   *   null` when no session is present).
   * - Sends `Content-Type: application/json` only when a `body` object is given
   *   (every prior caller that sent a JSON body also sent this header).
   * - Sends `X-Timezone` by default, matching the shared transport's convention.
   * - On non-2xx: throws an `ApiError` built from the response body (preserving
   *   status, code, details, and requestId), with `errorMessage` as the fallback
   *   message when the body carries none.
   * - On success: returns the parsed JSON cast to `T`.
   *
   * NOTE: this intentionally does NOT cover the methods that parse the body
   * up-front and use it on the success path
   * (notes, removeClient, conflict-check, categories, etc.), the GET
   * methods (custom error text / `requestDeduplicator` / 404 handling), or the
   * FormData upload. Those keep their original bodies to avoid any drift.
   */
  private async request<T>(
    url: string,
    opts: {
      method: 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      timezone?: boolean;
      errorMessage: string;
    },
  ): Promise<T> {
    const headers = await this.authHeaders(
      opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    );

    const response = await apiFetch(url, {
      method: opts.method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    if (!response.ok) {
      throw await toApiError(response, opts.errorMessage);
    }

    return (await response.json()) as T;
  }

  // -------------------------
  // Matters
  // -------------------------

  // Create a new matter
  async createMatter(payload: CreateMatterRequest): Promise<CreateMatterResponse> {
    const { lawFirmId, ...body } = payload;
    if (!lawFirmId) {
      throw new Error('lawFirmId is required to create a matter');
    }

    return this.request<CreateMatterResponse>(this.getLawFirmMattersUrl(lawFirmId), {
      method: 'POST',
      body,
      timezone: true,
      errorMessage: 'Failed to create matter',
    });
  }

  /** Get a single matter by ID */
  async getMatterById(matterId: string, lawFirmId: string): Promise<Matter> {
    // Timezone is sent via the `X-Timezone` header (the app-wide convention,
    // matching create/update and the other matter methods) rather than a `tz`
    // query param, so the whole module is consistent.
    const response = await apiFetch(this.getLawFirmMatterUrl(lawFirmId, matterId), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load matter details. Please try again.');
    }

    return response.json();
  }

  /** Get all matters for a specific law firm */
  async getMatters(lawFirmId: string): Promise<Matter[]> {
    const url = new URL(this.getLawFirmMattersUrl(lawFirmId));

    try {
      const response = await requestDeduplicator.execute<{matters?: Matter[]}>(url.toString(), {
        method: 'GET',
        headers: await this.authHeaders(),
      });

      if (!response) {
        return [];
      }

      return response?.matters ?? [];
    } catch (error: any) {
      // Handle 404 gracefully - this means no matters exist yet, which is normal
      if (error?.message?.includes('404') || error?.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get one server-paged, filtered, sorted window of matters.
   *
   * `getMatters()` (above) returns the FULL enriched list. This variant pushes the paging,
   * filtering, search and ordering into the backend (`matters.validation.js` ->
   * `matters.repository.js`) and returns the page plus `totalItems`, the full size
   * of the filtered result set, so a caller can render correct page controls
   * without fetching every row.
   *
   * `sort` is the ordered multi-column model, serialized as "field:dir,field:dir".
   * Only the backend's whitelisted fields are accepted (name, status, matterNumber,
   * createdAt, updatedAt, practiceArea); anything else is rejected with a 400.
   */
  async getMattersPaged(
    lawFirmId: string,
    params: {
      page?: number;
      limit?: number;
      offset?: number;
      search?: string;
      status?: string;
      /**
       * Its own filter, not a `status` enum value: a matter can be any status
       * and still have payment ongoing.
       */
      paymentOngoing?: boolean;
      practiceAreaId?: string;
      clientId?: string;
      /**
       * Full ' > '-joined category path. The server matches the whole subtree,
       * so selecting a parent includes its children.
       */
      category?: string;
      leadUserId?: string;
      sortBy?: string;
      order?: 'asc' | 'desc';
      sort?: Array<{ field: string; sort: 'asc' | 'desc' }>;
    } = {},
  ): Promise<{ matters: Matter[]; totalItems: number }> {
    const url = new URL(this.getLawFirmMattersUrl(lawFirmId));
    applyListWindow(url, params, { maxLimit: 500 });

    if (params.status) url.searchParams.set('status', params.status);
    if (params.paymentOngoing) url.searchParams.set('paymentOngoing', 'true');
    if (params.practiceAreaId) url.searchParams.set('practiceAreaId', params.practiceAreaId);
    if (params.clientId) url.searchParams.set('clientId', params.clientId);
    if (params.leadUserId) url.searchParams.set('leadUserId', params.leadUserId);
    if (params.category) url.searchParams.set('category', params.category);
    applyListSortSearch(url, params);

    try {
      const response = await requestDeduplicator.execute<{ matters?: Matter[]; totalItems?: number }>(url.toString(), {
        method: 'GET',
        headers: await this.authHeaders(),
      });
      return {
        matters: response?.matters ?? [],
        totalItems: response?.totalItems ?? (response?.matters?.length ?? 0),
      };
    } catch (error: any) {
      // A firm with no matters yet is a normal empty state, not an error.
      if (error?.message?.includes('404') || error?.status === 404) {
        return { matters: [], totalItems: 0 };
      }
      throw error;
    }
  }

  /**
   * The ids of EVERY matter matching these filters, unpaginated.
   *
   * Backs "select all" in the matters grid: the user means every matter behind the
   * current filters, not the page on screen, and the bulk endpoints act on ids. The
   * server applies the same visibility and filters as `getMattersPaged`, so the
   * selection can never reach a matter the list wouldn't show.
   *
   * `truncated` means the match set was larger than `limit` and the answer was
   * capped, so the caller should say the selection is partial rather than imply it
   * covers everything.
   */
  async listMatterIds(
    lawFirmId: string,
    params: {
      search?: string;
      status?: string;
      paymentOngoing?: boolean;
      practiceAreaId?: string;
      clientId?: string;
      category?: string;
      leadUserId?: string;
    } = {},
  ): Promise<{ ids: string[]; truncated: boolean; limit: number }> {
    const url = new URL(`${this.getLawFirmMattersUrl(lawFirmId)}/ids`);
    if (params.status) url.searchParams.set('status', params.status);
    if (params.paymentOngoing) url.searchParams.set('paymentOngoing', 'true');
    if (params.practiceAreaId) url.searchParams.set('practiceAreaId', params.practiceAreaId);
    if (params.clientId) url.searchParams.set('clientId', params.clientId);
    if (params.leadUserId) url.searchParams.set('leadUserId', params.leadUserId);
    if (params.category) url.searchParams.set('category', params.category);
    if (params.search?.trim()) url.searchParams.set('search', params.search.trim());

    const response = await requestDeduplicator.execute<{ ids?: string[]; truncated?: boolean; limit?: number }>(
      url.toString(),
      { method: 'GET', headers: await this.authHeaders() },
    );
    return {
      ids: response?.ids ?? [],
      truncated: !!response?.truncated,
      limit: response?.limit ?? 0,
    };
  }

  /**
   * Typeahead lookup for matter pickers - DEDUPLICATED.
   *
   * `search` and `ids` are mutually exclusive server-side: pass `ids` to resolve
   * labels for values a form already holds, `search` to find new ones. An `ids`
   * request that matches nothing comes back empty rather than falling back to an
   * arbitrary page, so a stale id never renders as some unrelated matter.
   */
  async lookupMatters(
    lawFirmId: string,
    {
      search,
      exactName,
      ids,
      limit,
      clientId,
      full,
    }: {
      search?: string;
      exactName?: string;
      ids?: string[];
      limit?: number;
      /**
       * Restricts the result to matters linked to this client. A value that
       * resolves to nothing yields an empty list rather than the unscoped one,
       * so a scoped picker can never silently offer another client's matters.
       */
      clientId?: string;
      /** Returns the complete enriched matter on each item, plus label/sublabel. */
      full?: boolean;
    } = {},
  ): Promise<LookupResult> {
    const url = new URL(`${this.getLawFirmMattersUrl(lawFirmId)}/lookup`);
    if (search) url.searchParams.set('search', search);
    if (exactName) url.searchParams.set('exactName', exactName);
    if (ids?.length) url.searchParams.set('ids', ids.join(','));
    if (limit != null) url.searchParams.set('limit', String(limit));
    if (clientId) url.searchParams.set('clientId', clientId);
    if (full) url.searchParams.set('full', 'true');

    const response = await requestDeduplicator.execute<Partial<LookupResult>>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return { items: response?.items ?? [], hasMore: response?.hasMore ?? false };
  }

  /**
   * Update a matter (also supports changing the lead by passing leadUserId / leadUserName)
   */
  async updateMatter(payload: UpdateMatterRequest): Promise<{ message: string }> {
    const { lawFirmId, matterId, ...body } = payload;
    if (!lawFirmId || !matterId) {
      throw new Error('lawFirmId and matterId are required to update a matter');
    }

    return this.request<{ message: string }>(this.getLawFirmMatterUrl(lawFirmId, matterId), {
      method: 'PUT',
      body,
      timezone: true,
      errorMessage: 'Failed to update matter',
    });
  }

  // Delete a matter
  async deleteMatter(lawFirmId: string, matterId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(this.getLawFirmMatterUrl(lawFirmId, matterId), {
      method: 'DELETE',
      errorMessage: 'Failed to delete matter',
    });
  }

  // Answers 200 even when some matters were refused (legal hold, trust activity,
  // billing history), so callers must inspect `failed`/`errors` - nothing throws.
  async deleteMultipleMatters(lawFirmId: string, matterIds: string[]): Promise<BulkResult> {
    return this.request<BulkResult>(`${this.getLawFirmMattersUrl(lawFirmId)}/bulk-delete`, {
      method: 'POST',
      body: { matterIds },
      errorMessage: 'Failed to delete multiple matters',
    });
  }

  // Bulk update practice area for multiple matters and tasks.
  // (The backend resolves the practice-area name itself; no name is sent.)
  async bulkUpdatePracticeArea(
    lawFirmId: string,
    matterIds: string[],
    practiceAreaId: string
  ): Promise<BulkResult> {
    return this.request<BulkResult>(`${this.getLawFirmMattersUrl(lawFirmId)}/bulk-update-practice-area`, {
      method: 'POST',
      body: {
        matterIds,
        practiceAreaId,
      },
      errorMessage: 'Failed to update practice area',
    });
  }

  // Bulk update status for multiple matters and tasks
  async bulkUpdateStatus(lawFirmId: string, matterIds: string[], status: string): Promise<BulkResult> {
    return this.request<BulkResult>(`${this.getLawFirmMattersUrl(lawFirmId)}/bulk-update-status`, {
      method: 'POST',
      body: {
        matterIds,
        status,
      },
      errorMessage: 'Failed to update status',
    });
  }

  // Convenience helpers (mirror backend routes)

  // Change a single matter's practice area (the backend resolves the name and
  // propagates the change to the matter's tasks).
  async updatePracticeArea(params: {
    lawFirmId: string;
    matterId: string;
    /** null clears the matter's practice area. */
    practiceAreaId: string | null;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/update-practice-area`, {
      method: 'POST',
      body: {
        practiceAreaId: params.practiceAreaId,
      },
      errorMessage: 'Failed to update practice area',
    });
  }

  async addMembers(params: {
    lawFirmId: string;
    matterId: string;
    targetUserIds: string[];
    role?: string;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/members`, {
      method: 'POST',
      body: {
        targetUserIds: params.targetUserIds,
        role: params.role,
      },
      errorMessage: 'Failed to add members',
    });
  }

  async removeMembers(params: {
    lawFirmId: string;
    matterId: string;
    targetUserIds: string[];
    /** A member who stays on the matter and takes over the removed users' task and event assignments. */
    reassignTo?: string | null;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/members/remove`, {
      method: 'POST',
      body: {
        targetUserIds: params.targetUserIds,
        ...(params.reassignTo ? { reassignTo: params.reassignTo } : {}),
      },
      errorMessage: 'Failed to remove members',
    });
  }

  /**
   * What removing these members would leave behind on THIS matter: per user, the
   * open tasks, upcoming events and task-reminder slots still pointing at them.
   * Writes nothing; lets the remove confirm offer a reassignment target.
   */
  async previewRemoveMembers(params: {
    lawFirmId: string;
    matterId: string;
    targetUserIds: string[];
  }): Promise<MemberRemovalPreview> {
    // The backend names the per-user list `members`; callers read it as `users`.
    const response = await this.request<{ members: MemberRemovalPreviewUser[] }>(
      `${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/members/remove/preview`,
      {
        method: 'POST',
        body: { targetUserIds: params.targetUserIds },
        errorMessage: 'Failed to check what removing these members affects',
      },
    );
    return { users: response.members ?? [] };
  }

  async updateMemberHourlyRate(params: {
    lawFirmId: string;
    matterId: string;
    userId: string;
    hourlyRate: number | null;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/members/hourly-rate`, {
      method: 'PUT',
      body: {
        userId: params.userId,
        hourlyRate: params.hourlyRate,
      },
      errorMessage: 'Failed to update hourly rate',
    });
  }

  /**
   * Same scoping as bulkAddMember, without writing anything: lets the assign
   * dialog show how many of the selected matters the user would actually
   * join, instead of assuming all of them.
   */
  async previewBulkAddMember(params: {
    lawFirmId: string;
    userId: string;
    matterIds: string[];
  }): Promise<{ toAdd: string[]; alreadyAssigned: string[]; failed: { matterId: string; error: string }[] }> {
    return this.request<{ toAdd: string[]; alreadyAssigned: string[]; failed: { matterId: string; error: string }[] }>(
      `${this.getLawFirmMattersUrl(params.lawFirmId)}/bulk-add-member/preview`,
      {
        method: 'POST',
        body: {
          userId: params.userId,
          matterIds: params.matterIds,
        },
        errorMessage: 'Failed to preview bulk assign member',
      },
    );
  }

  async bulkAddMember(params: {
    lawFirmId: string;
    userId: string;
    matterIds: string[];
  }): Promise<{ added: string[]; alreadyAssigned: string[]; failed: { matterId: string; error: string }[] }> {
    return this.request<{ added: string[]; alreadyAssigned: string[]; failed: { matterId: string; error: string }[] }>(
      `${this.getLawFirmMattersUrl(params.lawFirmId)}/bulk-add-member`,
      {
        method: 'POST',
        body: {
          userId: params.userId,
          matterIds: params.matterIds,
        },
        errorMessage: 'Failed to bulk assign member',
      },
    );
  }

  // Notes
  //
  // Matter notes are the same feature as task/client notes (rich content,
  // pinning, retraction, replies, time entries), sharing one implementation
  // with them - see `notesApi.ts`. Only what's genuinely matter-specific
  // stays here: links to tasks/files, sending a client update, and the
  // firm-wide notes list.

  async listMatterNotes(lawFirmId: string, matterId: string, params: NotesPageParams = {}) {
    return matterNotesApi.listNotes(lawFirmId, matterId, params);
  }

  /**
   * One page of the firm's notes across every matter the caller can see.
   *
   * Same filter vocabulary as the per-matter list, plus an optional matter
   * filter, so a reader can move between "everything" and one matter without
   * learning a second set of controls. Returns no tag vocabulary of its own
   * (tags are read per matter); callers hide the tag dropdown on this surface.
   */
  async listFirmNotes(
    lawFirmId: string,
    params: NotesPageParams & { matterId?: string } = {},
  ): Promise<NotesPageResult & { notes: (Note & { matterId?: string; matterName?: string; matterNumber?: string })[] }> {
    const url = new URL(`${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/notes`);
    applyNotesPageParams(url, params);
    if (params.matterId) url.searchParams.set('matterId', params.matterId);

    const response = await apiFetch(url.toString(), {
      headers: await this.authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to load notes');
    return {
      notes: Array.isArray(body.notes) ? body.notes : [],
      totalNotes: body.totalNotes ?? 0,
      counts: {
        all: body.counts?.all ?? 0,
        withTime: body.counts?.withTime ?? 0,
        withoutTime: body.counts?.withoutTime ?? 0,
      },
      tags: Array.isArray(body.tags) ? body.tags : [],
    };
  }

  async addNoteToMatter(lawFirmId: string, matterId: string, noteData: Parameters<typeof matterNotesApi.addNote>[2]) {
    return matterNotesApi.addNote(lawFirmId, matterId, noteData);
  }

  async updateNoteInMatter(lawFirmId: string, matterId: string, noteId: string, noteData: Parameters<typeof matterNotesApi.updateNote>[3]) {
    return matterNotesApi.updateNote(lawFirmId, matterId, noteId, noteData);
  }

  /**
   * Retract a note. The note and its time entries are kept, not deleted; the
   * backend marks the row and the panel renders it struck through.
   */
  async retractNoteFromMatter(lawFirmId: string, matterId: string, noteId: string, reason?: string) {
    return matterNotesApi.retractNote(lawFirmId, matterId, noteId, reason);
  }

  /** Add one time entry to a note. */
  async addNoteTimeEntry(lawFirmId: string, matterId: string, noteId: string, entry: TimeEntryInput) {
    return matterNotesApi.addNoteTimeEntry(lawFirmId, matterId, noteId, entry);
  }

  /** Update one of a note's time entries. */
  async updateNoteTimeEntry(lawFirmId: string, matterId: string, noteId: string, timeEntryId: string, entry: TimeEntryInput) {
    return matterNotesApi.updateNoteTimeEntry(lawFirmId, matterId, noteId, timeEntryId, entry);
  }

  /** Remove one of a note's time entries. */
  async removeNoteTimeEntry(lawFirmId: string, matterId: string, noteId: string, timeEntryId: string) {
    return matterNotesApi.removeNoteTimeEntry(lawFirmId, matterId, noteId, timeEntryId);
  }

  /** Pin or unpin a note on its matter. */
  async setNotePinned(lawFirmId: string, matterId: string, noteId: string, pinned: boolean) {
    return matterNotesApi.setNotePinned(lawFirmId, matterId, noteId, pinned);
  }

  /** Every prior state of a note, newest first. */
  async listNoteVersions(lawFirmId: string, matterId: string, noteId: string) {
    return matterNotesApi.listNoteVersions(lawFirmId, matterId, noteId);
  }

  /** Create a task from a note, keeping a backlink to it. */
  async createTaskFromNote(
    lawFirmId: string,
    matterId: string,
    noteId: string,
    task: { title?: string; description?: string; dueDate?: string; priority?: string; replyId?: string },
  ): Promise<{ taskId: string; link: NoteLink }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/notes/${encodeURIComponent(noteId)}/tasks`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(task),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to create task');
    return body as { taskId: string; link: NoteLink };
  }

  /** Link an existing task on the same matter to a note. */
  async linkTaskToNote(
    lawFirmId: string, matterId: string, noteId: string, taskId: string,
  ): Promise<{ link: NoteLink }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/notes/${encodeURIComponent(noteId)}/links/task`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ taskId }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to link task');
    return body as { link: NoteLink };
  }

  /**
   * Link an existing document to a note.
   *
   * Identified by its GCS object path, the same identifier every file picker
   * in the app already uses; the backend resolves that to the `files` row.
   */
  async linkFileToNote(
    lawFirmId: string, matterId: string, noteId: string, fileId: string,
  ): Promise<{ link: NoteLink }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/notes/${encodeURIComponent(noteId)}/links/file`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ fileId }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to link document');
    return body as { link: NoteLink };
  }

  /** Remove a link. The linked task or document is untouched. */
  async unlinkFromNote(
    lawFirmId: string, matterId: string, noteId: string, linkId: string,
  ): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/notes/${encodeURIComponent(noteId)}/links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to remove link');
    return body as { message: string };
  }

  /** A single note with its time summary and links, for a deep link or print view. */
  async getNote(lawFirmId: string, matterId: string, noteId: string) {
    return matterNotesApi.getNoteDetail(lawFirmId, matterId, noteId);
  }

  /** Every reply on a note, oldest first. */
  async listNoteReplies(lawFirmId: string, matterId: string, noteId: string) {
    return matterNotesApi.listNoteReplies(lawFirmId, matterId, noteId);
  }

  async addNoteReply(lawFirmId: string, matterId: string, noteId: string, reply: Parameters<typeof matterNotesApi.addNoteReply>[3]) {
    return matterNotesApi.addNoteReply(lawFirmId, matterId, noteId, reply);
  }

  async updateNoteReply(lawFirmId: string, matterId: string, noteId: string, replyId: string, reply: Parameters<typeof matterNotesApi.updateNoteReply>[4]) {
    return matterNotesApi.updateNoteReply(lawFirmId, matterId, noteId, replyId, reply);
  }

  async retractNoteReply(lawFirmId: string, matterId: string, noteId: string, replyId: string, reason?: string) {
    return matterNotesApi.retractNoteReply(lawFirmId, matterId, noteId, replyId, reason);
  }

  /**
   * Send a client update drawn from a note. The note itself is never shared;
   * this posts an ordinary matter message to the matter's clients.
   */
  async sendNoteAsClientUpdate(
    lawFirmId: string, matterId: string, noteId: string,
    payload: { message: string; recipientClientIds?: string[] },
  ): Promise<{ message: string; conversationId: string }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/notes/${encodeURIComponent(noteId)}/client-update`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Failed to send client update');
    return body as { message: string; conversationId: string };
  }

  // -------------------------
  // Matter Clients (matter_clients junction → clients)
  // -------------------------

  async listClients(lawFirmId: string, matterId: string): Promise<MatterClient[]> {
    const url = new URL(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/clients`);

    const response = await requestDeduplicator.execute<{clients?: MatterClient[]}>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return response?.clients || [];
  }

  /**
   * The clients of SEVERAL matters in one request, as matterId -> clients.
   *
   * For a page holding a list of matters that each need their payer shares. The
   * rows are exactly what `listClients` returns, `billingPortionBp` included.
   *
   * A matter the caller may read but which has no clients comes back present and
   * empty; a matter they may NOT read is ABSENT from the map, which is the batch
   * equivalent of the 403 the per-matter route answers. Callers must treat a
   * missing key and an empty array the same way rather than assuming every id
   * they asked about is present.
   *
   * The route caps `matterIds` at 100 and answers 400 above it, so a longer list
   * is chunked here. The chunks go out one after another on purpose: the whole
   * reason this endpoint exists is to keep a large list off the API instance's
   * small Postgres connection pool, and firing the chunks together would put the
   * pressure straight back.
   */
  async listClientsForMatters(lawFirmId: string, matterIds: string[]): Promise<Record<string, MatterClient[]>> {
    const unique = [...new Set((matterIds || []).filter(Boolean))];
    if (unique.length === 0) return {};

    const clientsByMatterId: Record<string, MatterClient[]> = {};
    for (let start = 0; start < unique.length; start += MAX_BATCH_MATTER_IDS) {
      const url = new URL(`${this.getLawFirmMattersUrl(lawFirmId)}/clients`);
      url.searchParams.set('matterIds', unique.slice(start, start + MAX_BATCH_MATTER_IDS).join(','));

      const response = await requestDeduplicator.execute<{ clientsByMatterId?: Record<string, MatterClient[]> }>(
        url.toString(),
        { method: 'GET', headers: await this.authHeaders() },
      );

      Object.assign(clientsByMatterId, response?.clientsByMatterId || {});
    }
    return clientsByMatterId;
  }

  /**
   * Set how this matter's invoices divide between its clients, as
   * clientId -> basis points. Pass an empty map to turn split billing off.
   *
   * The server rejects a split that misses a client on the matter or that does
   * not total 10000, so the caller does not have to pre-validate beyond keeping
   * the editor honest.
   */
  async setClientBillingPortions(
    lawFirmId: string,
    matterId: string,
    portions: Record<string, number>,
  ): Promise<{ message: string; clients: MatterClient[] }> {
    return this.request<{ message: string; clients: MatterClient[] }>(
      `${this.getLawFirmMatterUrl(lawFirmId, matterId)}/clients/billing-portions`,
      {
        method: 'PUT',
        body: { portions },
        errorMessage: 'Failed to update the billing split',
      },
    );
  }

  async addClient(params: AddClientRequest): Promise<AddClientResponse> {
    return this.request<AddClientResponse>(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/clients`, {
      method: 'POST',
      body: { client: params.client },
      errorMessage: 'Failed to add client',
    });
  }

  async removeClient(params: RemoveClientRequest): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getLawFirmMatterUrl(params.lawFirmId, params.matterId)}/clients/${encodeURIComponent(params.clientId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { message: string };
  }

  async getClientProfile(lawFirmId: string, clientId: string): Promise<Client | null> {
    const url = this.getLawFirmClientUrl(lawFirmId, clientId);

    try {
      return await requestDeduplicator.execute<Client>(url, {
        method: 'GET',
        headers: await this.authHeaders(),
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      if (message.includes('404') || error?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getClientProfilesByIds(lawFirmId: string, clientIds: string[]): Promise<Record<string, Client>> {
    const uniqueIds = Array.from(new Set((clientIds || []).filter(Boolean)));
    if (uniqueIds.length === 0) return {};

    // Single batch call to `GET /lawfirms/:id/clients?ids=a,b,c`, which returns
    // `{ clients: [...] }` of full enriched client profiles.
    const url = new URL(`${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/clients`);
    url.searchParams.append('ids', uniqueIds.join(','));

    const response = await requestDeduplicator.execute<{ clients?: Client[] }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    const clients = response?.clients ?? [];
    const byId: Record<string, Client> = {};
    clients.forEach((profile) => {
      if (profile && profile.id) byId[profile.id] = profile;
    });

    return byId;
  }

  async updateClientProfile(params: UpdateClientProfileRequest): Promise<{ message: string }> {
    return this.request<{ message: string }>(this.getLawFirmClientUrl(params.lawFirmId, params.clientId), {
      method: 'PUT',
      body: params.client,
      errorMessage: 'Failed to update client profile',
    });
  }

  async checkConflicts(
    lawFirmId: string,
    params: { names?: string[]; emails?: string[]; organizations?: string[]; excludeClientIds?: string[] },
  ): Promise<{ hasConflicts: boolean; conflicts: ConflictCheckResult[] }> {
    const response = await apiFetch(`${this.getLawFirmMattersUrl(lawFirmId)}/conflict-check`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(params),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Conflict check failed');
    return body;
  }

  // -------------------------
  // Related contacts (non-client parties on a matter)
  // -------------------------

  async listContacts(lawFirmId: string, matterId: string): Promise<MatterContact[]> {
    const url = `${this.getLawFirmMatterUrl(lawFirmId, matterId)}/contacts`;
    const response = await requestDeduplicator.execute<{ contacts?: MatterContact[] }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.contacts || [];
  }

  /**
   * Put a contact on a matter, in either of two ways: `{ contactId, role }`
   * links one that is already in the firm directory, or the identity fields
   * (`name`, `email`, …) create the directory record and link it in one step.
   */
  async createContact(lawFirmId: string, matterId: string, contact: Partial<MatterContact>): Promise<{ contact: MatterContact }> {
    return this.request<{ contact: MatterContact }>(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/contacts`, {
      method: 'POST', body: contact, errorMessage: 'Failed to add contact',
    });
  }

  /**
   * Update what a contact is ON THIS MATTER - role, matter note, display order.
   * `linkId` is `MatterContact.id`, the link, not the directory contact. The
   * contact's own details are shared across matters and are edited through
   * `contactsService`.
   */
  async updateContact(lawFirmId: string, matterId: string, linkId: string, contact: Partial<MatterContact>): Promise<{ contact: MatterContact }> {
    return this.request<{ contact: MatterContact }>(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/contacts/${encodeURIComponent(linkId)}`, {
      method: 'PUT', body: contact, errorMessage: 'Failed to update contact',
    });
  }

  /** Unlink a contact from a matter. The directory record survives. */
  async deleteContact(lawFirmId: string, matterId: string, linkId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/contacts/${encodeURIComponent(linkId)}`, {
      method: 'DELETE', errorMessage: 'Failed to remove contact',
    });
  }

  // -------------------------
  // Activity feed
  // -------------------------

  /**
   * One page of a matter's activity feed, newest first. The feed is append-only
   * and never pruned, so `totalItems` is what lets the caller page back through
   * the whole history instead of only seeing the newest page.
   */
  async listActivity(
    lawFirmId: string,
    matterId: string,
    params: { limit?: number; offset?: number; activityTypes?: string[] } = {}
  ): Promise<{ activity: MatterActivity[]; totalItems: number }> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    for (const type of params.activityTypes || []) query.append('type', type);
    const qs = query.toString();
    const url = `${this.getLawFirmMatterUrl(lawFirmId, matterId)}/activity${qs ? `?${qs}` : ''}`;
    const response = await requestDeduplicator.execute<{
      activity?: MatterActivity[];
      totalItems?: number;
    }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return {
      activity: response?.activity || [],
      totalItems: response?.totalItems ?? response?.activity?.length ?? 0,
    };
  }

  // -------------------------
  // Conflict-of-interest records (surfacing + re-run)
  // -------------------------

  async listConflictChecks(lawFirmId: string, matterId: string): Promise<ConflictCheckRecord[]> {
    const url = `${this.getLawFirmMatterUrl(lawFirmId, matterId)}/conflict-checks`;
    const response = await requestDeduplicator.execute<{ conflictChecks?: ConflictCheckRecord[] }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.conflictChecks || [];
  }

  async rerunConflictCheck(lawFirmId: string, matterId: string): Promise<{ conflictChecks: ConflictCheckRecord[] }> {
    return this.request<{ conflictChecks: ConflictCheckRecord[] }>(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/conflict-checks/run`, {
      method: 'POST', errorMessage: 'Failed to run conflict check',
    });
  }

  // -------------------------
  // Legal hold
  // -------------------------

  async setLegalHold(lawFirmId: string, matterId: string, legalHold: boolean, reason?: string): Promise<{ message: string; matter: Matter }> {
    return this.request<{ message: string; matter: Matter }>(`${this.getLawFirmMatterUrl(lawFirmId, matterId)}/legal-hold`, {
      method: 'PATCH' as 'PUT', body: { legalHold, reason }, timezone: true, errorMessage: 'Failed to update legal hold',
    });
  }

  // -------------------------
  // Custom field definitions (firm-level config, /matter-field-defs)
  // -------------------------

  private fieldDefsUrl(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matter-field-defs`;
  }

  async listFieldDefs(lawFirmId: string, includeArchived = false): Promise<MatterFieldDef[]> {
    const url = new URL(this.fieldDefsUrl(lawFirmId));
    if (includeArchived) url.searchParams.set('includeArchived', 'true');
    const response = await requestDeduplicator.execute<{ fieldDefs?: MatterFieldDef[] }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.fieldDefs || [];
  }

  async createFieldDef(lawFirmId: string, def: Partial<MatterFieldDef>): Promise<{ fieldDef: MatterFieldDef }> {
    return this.request<{ fieldDef: MatterFieldDef }>(this.fieldDefsUrl(lawFirmId), {
      method: 'POST', body: def, errorMessage: 'Failed to create custom field',
    });
  }

  async updateFieldDef(lawFirmId: string, defId: string, def: Partial<MatterFieldDef>): Promise<{ fieldDef: MatterFieldDef }> {
    return this.request<{ fieldDef: MatterFieldDef }>(`${this.fieldDefsUrl(lawFirmId)}/${encodeURIComponent(defId)}`, {
      method: 'PUT', body: def, errorMessage: 'Failed to update custom field',
    });
  }

  async deleteFieldDef(lawFirmId: string, defId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.fieldDefsUrl(lawFirmId)}/${encodeURIComponent(defId)}`, {
      method: 'DELETE', errorMessage: 'Failed to delete custom field',
    });
  }

  // -------------------------
  // Matter stages (firm-level config, /matter-stages)
  // -------------------------

  private stagesUrl(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matter-stages`;
  }

  async createStage(lawFirmId: string, stage: Partial<MatterStage>): Promise<{ stage: MatterStage }> {
    return this.request<{ stage: MatterStage }>(this.stagesUrl(lawFirmId), {
      method: 'POST', body: stage, errorMessage: 'Failed to create stage',
    });
  }

  async updateStage(lawFirmId: string, stageId: string, stage: Partial<MatterStage>): Promise<{ stage: MatterStage }> {
    return this.request<{ stage: MatterStage }>(`${this.stagesUrl(lawFirmId)}/${encodeURIComponent(stageId)}`, {
      method: 'PUT', body: stage, errorMessage: 'Failed to update stage',
    });
  }

  async deleteStage(lawFirmId: string, stageId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.stagesUrl(lawFirmId)}/${encodeURIComponent(stageId)}`, {
      method: 'DELETE', errorMessage: 'Failed to delete stage',
    });
  }

  // -------------------------
  // Matter stage pipelines (firm-level config, /matter-stage-pipelines)
  // -------------------------

  private pipelinesUrl(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matter-stage-pipelines`;
  }

  async listPipelines(lawFirmId: string): Promise<MatterStagePipeline[]> {
    const response = await requestDeduplicator.execute<{ pipelines?: MatterStagePipeline[] }>(this.pipelinesUrl(lawFirmId), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.pipelines || [];
  }

  async createPipeline(
    lawFirmId: string,
    pipeline: {
      name: string;
      practiceAreaId: string | null;
      isDefault: boolean;
      stages: Array<{
        clientId: string;
        name: string;
        color: string | null;
        sortOrder: number;
        isClosed: boolean;
        parentClientId: string | null;
      }>;
    },
  ): Promise<{ pipeline: MatterStagePipeline }> {
    return this.request<{ pipeline: MatterStagePipeline }>(this.pipelinesUrl(lawFirmId), {
      method: 'POST', body: pipeline, errorMessage: 'Failed to create pipeline',
    });
  }

  async updatePipeline(
    lawFirmId: string,
    pipelineId: string,
    pipeline: Partial<Pick<MatterStagePipeline, 'name' | 'practiceAreaId' | 'isDefault'>>,
  ): Promise<{ pipeline: MatterStagePipeline }> {
    return this.request<{ pipeline: MatterStagePipeline }>(`${this.pipelinesUrl(lawFirmId)}/${encodeURIComponent(pipelineId)}`, {
      method: 'PUT', body: pipeline, errorMessage: 'Failed to update pipeline',
    });
  }

  async deletePipeline(lawFirmId: string, pipelineId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.pipelinesUrl(lawFirmId)}/${encodeURIComponent(pipelineId)}`, {
      method: 'DELETE', errorMessage: 'Failed to delete pipeline',
    });
  }

  // Category methods
  async listCategories(lawFirmId: string): Promise<Category[]> {
    const url = new URL(`${this.getLawFirmMattersUrl(lawFirmId)}/categories`);

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return (body.categories || []) as Category[];
  }

  async listCategoriesTree(lawFirmId: string): Promise<Category[]> {
    const url = new URL(`${this.getLawFirmMattersUrl(lawFirmId)}/categories/tree`);

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return (body.categories || []) as Category[];
  }

  async createCategory(lawFirmId: string, name: string, parentId?: string | null): Promise<{ message: string; category: Category }> {
    const response = await apiFetch(`${this.getLawFirmMattersUrl(lawFirmId)}/categories`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, parentId: parentId || null }),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { message: string; category: Category };
  }

  async updateCategory(lawFirmId: string, categoryId: string, updates: { name?: string; parentId?: string | null; order?: number }): Promise<{ message: string; category: Category }> {
    const response = await apiFetch(`${this.getLawFirmMattersUrl(lawFirmId)}/categories/${encodeURIComponent(categoryId)}`, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(updates),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { message: string; category: Category };
  }

  async deleteCategory(lawFirmId: string, categoryId: string): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getLawFirmMattersUrl(lawFirmId)}/categories/${encodeURIComponent(categoryId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body, 'Something went wrong. Please try again.');
    return body as { message: string };
  }
}

const mattersService = new MattersService();
export default mattersService;
