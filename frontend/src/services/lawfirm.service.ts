import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError, ApiError } from '@/lib/utils/apiErrors';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import { retryOnColdStart } from '@/lib/utils/coldStartRetry';
import type { LawFirm, LawFirmUpdate } from '@/types';
import requestDeduplicator from './requestDeduplicator';
import { uploadResumable } from '@/lib/files/resumableUpload';
import { authenticatedHeaders } from './base.service';

export interface CreateLawFirmResponse {
  message: string;
  lawFirm: LawFirm;
}

export interface InviteUserResponse {
  message: string;
  invitedUserId?: string;
}

export interface ChangeMemberRoleResponse {
  message: string;
  roleId: string;
  roleName?: string;
}

export interface PendingMemberInvite {
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

class LawFirmService {
  private apiUrl: string;

  constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiUrl = `${API_URL}/lawfirms`;
  }

  private async authHeaders(
    extra: Record<string, string> = {},
    options?: { timezone?: boolean; requireToken?: boolean },
  ) {
    return authenticatedHeaders(extra, options);
  }

  /** Create a new law firm - NO DEDUPLICATION (mutation) */
  async createLawFirm(input: {
    name: string;
    firmSize?: string;
    practiceArea?: string;
  }): Promise<CreateLawFirmResponse> {
    const response = await apiFetch(`${this.apiUrl}/create-lawfirm`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to create law firm');
    }
    return body as CreateLawFirmResponse;
  }

  /** Invite a user to a law firm by email - NO DEDUPLICATION (mutation) */
  async inviteUserToLawFirm(
    email: string,
    lawFirmId: string,
    roleId: string,
  ): Promise<InviteUserResponse> {
    const response = await apiFetch(`${this.apiUrl}/${encodeURIComponent(lawFirmId)}/invitations/invite-member`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        email,
        roleId,
      }),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to invite user');
    }
    return body as InviteUserResponse;
  }

  /** List pending member invitations for a firm - DEDUPLICATED */
  async listPendingMemberInvites(lawFirmId: string): Promise<PendingMemberInvite[]> {
    const body = await requestDeduplicator.execute<{ invites?: PendingMemberInvite[] }>(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/invitations/pending-member-invites`,
      {
        method: 'GET',
        headers: await this.authHeaders(),
      },
    );
    return Array.isArray(body?.invites) ? body.invites : [];
  }

  /** Resend a pending member invitation email - NO DEDUPLICATION (mutation) */
  async resendMemberInvitation(lawFirmId: string, inviteId: string): Promise<ResendInvitationResponse> {
    const response = await apiFetch(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/invitations/resend-member-invite`,
      {
        method: 'POST',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ inviteId }),
      },
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to resend invitation');
    }
    return body as ResendInvitationResponse;
  }

  /** Revoke (cancel) a pending member invitation - NO DEDUPLICATION (mutation) */
  async revokeMemberInvitation(lawFirmId: string, inviteId: string): Promise<{ message: string; inviteId: string }> {
    const response = await apiFetch(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/invitations/member-invites/${encodeURIComponent(inviteId)}/revoke`,
      {
        method: 'POST',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      },
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to revoke invitation');
    }
    return body as { message: string; inviteId: string };
  }

  /** Change a member's role in a law firm - NO DEDUPLICATION (mutation) */
  async changeMemberRole(
    lawFirmId: string,
    memberId: string,
    roleId: string,
  ): Promise<ChangeMemberRoleResponse> {
    const response = await apiFetch(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/members/${encodeURIComponent(memberId)}/role`,
      {
        method: 'PUT',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ roleId }),
      },
    );

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to change member role');
    }

    return body as ChangeMemberRoleResponse;
  }

  /** Get details for a specific law firm - DEDUPLICATED */
  async getLawFirmById(lawFirmId: string): Promise<LawFirm | null> {
    const headers = await this.authHeaders(undefined, { requireToken: true });

    const body = await requestDeduplicator.execute<any>(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}`,
      {
        method: 'GET',
        headers,
        // The workspace shell blocks on this one read and renders a full-page
        // connection error if it fails, so it gets the bootstrap budget rather
        // than the shorter default: it is usually the request that pays for
        // waking a scaled-to-zero API.
        timeoutMs: REQUEST_TIMEOUT_MS.bootstrap,
      }
    );

    // Normalize: support either `{ lawFirm: ... }` or a plain `LawFirm`
    const lawFirm: LawFirm | null =
      (body && typeof body === 'object' && 'lawFirm' in body ? (body.lawFirm as LawFirm) : (body as LawFirm)) ?? null;

    return lawFirm;
  }

  /**
   * The same read, as the workspace shell needs it: one automatic retry when the
   * failure has the shape of an API that had scaled to zero.
   *
   * Separate from `getLawFirmById` because the retry is a property of the CALLER,
   * not of the endpoint. This is the request a user waits on with a blank screen,
   * and its failure renders a full-page connection error whose only remedy is a
   * button that repeats the request. Doing that once automatically costs a second
   * request on a boot and saves the user the dead end. A background refresh of
   * the same firm wants the plain method.
   */
  async getLawFirmForWorkspace(lawFirmId: string): Promise<LawFirm | null> {
    return retryOnColdStart(() => this.getLawFirmById(lawFirmId));
  }

  /** Get all members of a law firm - DEDUPLICATED */
  async getLawFirmMembers(lawFirmId: string): Promise<any[]> {
    const headers = await this.authHeaders(undefined, { requireToken: true });

    const body = await requestDeduplicator.execute<{members?: any[]} | any[]>(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/members`,
      {
        method: 'GET',
        headers,
      }
    );

    if (Array.isArray(body)) return body;
    return body.members || [];
  }

  /**
   * The calling member's own row for one firm, with permissions resolved.
   *
   * What a workspace mount actually needs. `getLawFirmMembers` answers the same
   * question by fetching every member of the firm and letting the caller find
   * itself, which costs an identity lookup and a signed avatar per member on a
   * request about one row. The roster method stays for the members settings
   * screen, which genuinely needs the list.
   *
   * DEDUPLICATED: several gated shells mount at once and ask on the same tick.
   *
   * A non-member is refused with a 403, which surfaces as an `ApiError`; the
   * caller decides whether that means "holds nothing here" or a failure.
   */
  async getMyMembership(lawFirmId: string): Promise<any | null> {
    const headers = await this.authHeaders(undefined, { requireToken: true });

    const body = await requestDeduplicator.execute<{ member?: any } | any>(
      `${this.apiUrl}/${encodeURIComponent(lawFirmId)}/members/me`,
      {
        method: 'GET',
        headers,
      }
    );

    if (body && typeof body === 'object' && 'member' in body) return body.member ?? null;
    return body ?? null;
  }

  /** Update law firm information - NO DEDUPLICATION (mutation) */
  async updateLawFirm(lawFirmId: string, data: LawFirmUpdate): Promise<LawFirm> {
    const response = await apiFetch(`${this.apiUrl}/${encodeURIComponent(lawFirmId)}`, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to update law firm');
    }
    return body as LawFirm;
  }

  /**
   * Upload a firm logo straight to storage.
   *
   * The file used to be POSTed to the API as multipart, hand-rolled in the
   * settings page, which held the whole image in a container that serves many
   * requests at once. Three steps now: ask for a session, PUT the bytes to
   * storage, tell the API where they landed.
   *
   * `uploadResumable` is shared with the files and profile-picture uploaders
   * rather than rebuilt here. It carries no API credential, which matters: the
   * session url is already the authorization, and a bearer token would send the
   * user's credential to a host that never needed it.
   *
   * Finalize runs only after the PUT resolves. Reached after a failed upload it
   * would point the firm's branding at an object that is not there.
   */
  async uploadLogo(lawFirmId: string, file: File): Promise<{ lawFirm: LawFirm }> {
    const firm = encodeURIComponent(lawFirmId);
    const initResponse = await apiFetch(`${this.apiUrl}/${firm}/logo/upload-init`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        contentType: file.type || 'application/octet-stream',
        fileName: file.name,
        size: file.size,
      }),
    });
    const opened = await initResponse.json().catch(() => ({} as any));
    if (!initResponse.ok) {
      throw ApiError.fromResponse(initResponse, opened, 'Failed to upload logo');
    }

    await uploadResumable({
      file,
      sessionUrl: opened.uploadUrl,
      contentType: file.type || 'application/octet-stream',
    });

    const doneResponse = await apiFetch(`${this.apiUrl}/${firm}/logo/upload-finalize`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ objectPath: opened.objectPath }),
    });
    const body = await doneResponse.json().catch(() => ({} as any));
    if (!doneResponse.ok) {
      throw ApiError.fromResponse(doneResponse, body, 'Failed to upload logo');
    }
    return body as { lawFirm: LawFirm };
  }

  /** Remove a member from a law firm - NO DEDUPLICATION (mutation) */
  async removeMemberFromLawFirm(lawFirmId: string, memberId: string): Promise<void> {
    const response = await apiFetch(`${this.apiUrl}/${encodeURIComponent(lawFirmId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove member');
    }
  }

  /** Leave a law firm, optionally transferring admin to another member, or confirming
   *  deletion when you're the sole remaining member - NO DEDUPLICATION (mutation) */
  async leaveLawFirm(lawFirmId: string, options?: { newAdminUserId?: string; confirmDeletion?: boolean }): Promise<any> {
    const response = await apiFetch(`${this.apiUrl}/${encodeURIComponent(lawFirmId)}/leave`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(options || {}),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      const error = ApiError.fromResponse(response, body, 'Failed to leave law firm') as ApiError & { eligibleMembers?: unknown };
      error.eligibleMembers = body.details?.eligibleMembers;
      throw error;
    }
    return body;
  }

  /** Delete a law firm (admin only) - NO DEDUPLICATION (mutation) */
  async deleteLawFirm(lawFirmId: string): Promise<any> {
    const response = await apiFetch(`${this.apiUrl}/${encodeURIComponent(lawFirmId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to delete law firm');
    }
    return body;
  }
}

const lawFirmService = new LawFirmService();
export default lawFirmService;
