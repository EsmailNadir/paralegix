import { getFirebaseToken } from '@/lib/utils/auth';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import { authenticatedHeaders } from './base.service';
import { uploadResumable, UploadCancelledError } from '@/lib/files/resumableUpload';
import type {
  Conversation,
  ConversationListQuery,
  ConversationPage,
  Message,
  MessageAttachment,
  SendMessageData,
  GroupConversationResponse,
  GroupParticipant,
  MessageSearchResult,
} from '@/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

// Serialize a conversation-list window into a query string. An empty query yields an
// empty string, so a call with no options hits the exact same URL as the historic
// unpaginated read and the server answers it with the full list.
function conversationListParams(opts: ConversationListQuery): string {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.page != null) params.set('page', String(opts.page));
  if (opts.search?.trim()) params.set('search', opts.search.trim());
  if (opts.archived != null) params.set('archived', String(opts.archived));
  if (opts.clientId) params.set('clientId', opts.clientId);
  if (opts.clientIds?.length) params.set('clientIds', opts.clientIds.join(','));
  if (opts.matterId) params.set('matterId', opts.matterId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

class MessagesService {
  // Send message via API (creates conversation if needed)
  async sendMessage(data: SendMessageData): Promise<{ messageId: string; conversationId: string }> {
    const response = await apiFetch(`${API_URL}/lawfirms/${data.lawFirmId}/messaging/send`, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to send message');
    }

    return response.json();
  }

  // Get one window of the firm's direct conversations, with the total number of
  // matches. Search and the archived filter are applied server-side, so the result
  // is authoritative rather than a filter over whatever happened to be loaded.
  async getFirmConversationPage(
    lawFirmId: string,
    opts: ConversationListQuery = {}
  ): Promise<ConversationPage> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/conversations${conversationListParams(opts)}`,
      { headers: await authenticatedHeaders() }
    );

    if (!response.ok) throw await toApiError(response, 'Failed to fetch conversations');
    const data = await response.json();
    const conversations: Conversation[] = data.conversations || [];
    return { conversations, totalItems: Number(data.totalItems) || conversations.length };
  }

  // Get one page of the firm's whole inbox: direct threads and the caller's group
  // threads interleaved by recency, paged, searched and filtered server-side. The
  // Messages page reads this rather than paging the two lists separately, since
  // page N of the merged list is not page N of each half.
  async getFirmInboxPage(
    lawFirmId: string,
    opts: ConversationListQuery = {}
  ): Promise<ConversationPage> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/inbox${conversationListParams(opts)}`,
      { headers: await authenticatedHeaders() }
    );

    if (!response.ok) throw await toApiError(response, 'Failed to fetch conversations');
    const data = await response.json();
    const conversations: Conversation[] = data.conversations || [];
    return { conversations, totalItems: Number(data.totalItems) || conversations.length };
  }

  // Get every direct conversation in the firm. Callers that need to locate one
  // specific thread within the whole set (a client's or a matter's messages tab) use
  // this rather than a window.
  async getFirmConversations(
    lawFirmId: string,
    opts: ConversationListQuery = {},
  ): Promise<Conversation[]> {
    const { conversations } = await this.getFirmConversationPage(lawFirmId, opts);
    return conversations;
  }

  // Get conversations for client
  async getClientConversations(): Promise<Conversation[]> {
    const response = await apiFetch(`${API_URL}/messaging/client-conversations`, {
      headers: await authenticatedHeaders(),
    });

    if (!response.ok) throw await toApiError(response, 'Failed to fetch conversations');
    const data = await response.json();
    return data.conversations || [];
  }

  // Get paginated messages for a conversation (initial load)
  async getConversationMessages(
    conversationId: string,
    lawFirmId: string,
    pageSize: number = 25,
    lastMessageId?: string
  ): Promise<{ messages: Message[]; hasMore: boolean; conversation: Conversation; participants?: GroupParticipant[] }> {
    const params = new URLSearchParams({
      limit: pageSize.toString(),
    });
    if (lastMessageId) params.append('lastMessageId', lastMessageId);

    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/conversations/${conversationId}?${params}`, {
      headers: await authenticatedHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch messages');
    }
    return response.json();
  }

  // Edit one of the caller's own messages (sender-only, enforced server-side).
  // Works for direct and group threads; realtime propagates the change.
  async editMessage(
    lawFirmId: string,
    messageId: string,
    content: string
  ): Promise<{ messageId: string; editedAt: string }> {
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/messages/${messageId}`, {
      method: 'PATCH',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to edit message');
    return response.json();
  }

  // Soft-delete one of the caller's own messages. The row is retained server-side
  // and rendered as a "message was deleted" tombstone.
  async deleteMessage(lawFirmId: string, messageId: string): Promise<{ messageId: string }> {
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/messages/${messageId}`, {
      method: 'DELETE',
      headers: await authenticatedHeaders(),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to delete message');
    return response.json();
  }

  // Full-text search over message content across the firm's conversations.
  // Returns masked snippet results (never a bare array at the root).
  async searchMessages(lawFirmId: string, q: string): Promise<MessageSearchResult[]> {
    const params = new URLSearchParams({ q });
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/search?${params}`, {
      headers: await authenticatedHeaders(),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to search messages');
    const data = await response.json();
    return data.results || [];
  }

  // Mark messages as read
  async markAsRead(conversationId: string, lawFirmId: string, messageIds: string[]): Promise<void> {
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/mark-read`, {
      method: 'PUT',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ conversationId, messageIds }),
    });

    if (!response.ok) throw await toApiError(response, 'Failed to mark messages as read');
  }

  // Get unread count. Uses a non-forced token. apiFetch already refreshes the
  // Firebase token and retries on a 401, so forcing a refresh every call was
  // unnecessary churn (the badge is event-driven, not a tight poll).
  async getUnreadCount(lawFirmId?: string): Promise<number> {
    try {
      // Firm members use firm-scoped endpoint, clients use client-scoped
      const url = lawFirmId
        ? `${API_URL}/lawfirms/${lawFirmId}/messaging/unread-count`
        : `${API_URL}/messaging/unread-count`;
      const response = await apiFetch(url, {
        headers: await authenticatedHeaders(),
      });

      if (!response.ok) {
        // Try to get error message, but don't throw if it fails
        let errorMessage = 'Failed to get unread count';
        try {
          const errorBody = await response.json();
          errorMessage = errorBody.error || errorMessage;
        } catch {
          // If response is not JSON, use status text
          errorMessage = response.statusText || errorMessage;
        }

        // For 401/403, don't log as error - just return 0
        if (response.status === 401 || response.status === 403) {
          return 0;
        }

        // For other errors, log but still return 0 to prevent UI breakage
        if (process.env.NODE_ENV === 'development') {
          console.warn('Failed to get unread count:', errorMessage);
        }
        return 0;
      }

      const data = await response.json().catch(() => ({ count: 0 }));
      return data.count || 0;
    } catch (error) {
      // Silently handle network errors and return 0
      // This prevents UI breakage if the endpoint is unavailable
      if (process.env.NODE_ENV === 'development') {
        console.warn('Error fetching unread count:', error instanceof Error ? error.message : 'Unknown error');
      }
      return 0;
    }
  }

  /**
   * Upload attachment files before sending a message.
   *
   * Direct threads target a client id (the conversation row may not exist yet);
   * group threads have no single client, so they target the conversation id.
   *
   * The files used to be POSTed to the API as multipart through a hand-rolled
   * XMLHttpRequest here: up to five at a hundred megabytes each, all resident in
   * the API container before the handler ran. Three steps now, and the middle
   * one goes browser to storage. `uploadResumable` is shared with the files,
   * photo and logo paths rather than being a fourth retry loop, and it carries
   * no API credential: a signed session url is already the authorization, and a
   * bearer token would send the user's credential to a host that never needed it.
   *
   * Finalize is reached only after every PUT resolves. Called after a failure it
   * would record attachments pointing at objects that are not there.
   *
   * `signal` cancels. Any step it interrupts rejects with `UploadCancelledError`,
   * never a raw abort, so the composer can tell "the user stopped this" from a
   * failure worth reporting. A cancel never reaches finalize, including one that
   * lands after the last byte: finalize is what turns landed bytes into
   * attachments. `onFinalizing` fires just before finalize goes out, which is
   * the point past which a cancel can no longer withdraw anything.
   *
   * Init holds a quota reservation per file that only finalize or the cancel
   * route gives back before it lapses (two hours). So a batch that stops short
   * of finalize, cancelled or failed, sends the cancel route every session init
   * opened, without the rejection waiting on it.
   */
  async uploadAttachments(
    lawFirmId: string,
    target: { clientId?: string; conversationId?: string },
    files: File[],
    onProgress?: (progress: number) => void,
    options: {
      signal?: AbortSignal;
      onFinalizing?: () => void;
      // Called with the files finalize refused (a type or content check, say),
      // by name. The rest still come back as attachments.
      onRejected?: (rejected: Array<{ name: string; error: string }>) => void;
    } = {}
  ): Promise<MessageAttachment[]> {
    if (files.length === 0) return [];
    const { signal, onFinalizing, onRejected } = options;
    const base = `${API_URL}/lawfirms/${lawFirmId}/messaging/attachments`;
    const scope = target.clientId
      ? { clientId: target.clientId }
      : { conversationId: target.conversationId };

    type Opened = { uploads: Array<{ uploadUrl: string; objectPath: string; fileName: string; reservationId?: string }> };
    /**
     * Give back what init opened, once. Best effort and not awaited: the user
     * has already moved on, and a hold this misses still lapses on its own.
     */
    let released = false;
    const release = (batch: Opened | null | undefined) => {
      const uploads = (batch?.uploads || [])
        .map((u) => ({ objectPath: u.objectPath, reservationId: u.reservationId }));
      if (released || uploads.length === 0) return;
      released = true;
      this.postJson(`${base}/upload-cancel`, { ...scope, uploads }).catch(() => {});
    };

    // Null until init answers, so a failure before then has nothing to release.
    let opened: Opened | null = null;
    try {
      // Checked before init as well, since init reserves quota for the batch.
      if (signal?.aborted) throw new UploadCancelledError();
      // Not aborted by the signal: the server reserves whether or not the
      // browser waits for its answer, so a cancel stops waiting at once and
      // releases what the answer names when it arrives.
      const init = this.postJson<Opened>(`${base}/upload-init`, {
        ...scope,
        files: files.map((file) => ({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        })),
      });
      opened = await new Promise<Opened>((resolve, reject) => {
        if (!signal) { init.then(resolve, reject); return; }
        const onAbort = () => {
          init.then(release, () => {});
          reject(new UploadCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Removed as the answer lands rather than a turn later, so a cancel
        // after that is handled once, by the caller, and not also here.
        const settle = () => signal.removeEventListener('abort', onAbort);
        init.then((value) => { settle(); resolve(value); }, (err) => { settle(); reject(err); });
      });

      // Progress is reported across the whole batch, so one bar tracks the send
      // rather than jumping back to zero on each file.
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
      const sentPerFile = new Array<number>(files.length).fill(0);
      const report = () => {
        if (!onProgress) return;
        const sent = sentPerFile.reduce((sum, n) => sum + n, 0);
        onProgress(Math.min(100, Math.round((sent / totalBytes) * 100)));
      };

      for (let i = 0; i < files.length; i += 1) {
        const session = opened.uploads[i];
        // Sequential uploading keeps the browser
        // holding one file's worth of upload buffer rather than five.
        await uploadResumable({
          file: files[i],
          sessionUrl: session.uploadUrl,
          contentType: files[i].type || 'application/octet-stream',
          onTransportBytes: (bytes: number) => { sentPerFile[i] = bytes; report(); },
          signal,
        });
      }
    } catch (err) {
      // Whatever init opened is never finalized now. An init that is still
      // answering is released by the abort handler above instead.
      release(opened);
      // An abort can surface from the transport as a plain network error, so
      // the signal decides, not the error type.
      if (signal?.aborted || err instanceof UploadCancelledError) throw new UploadCancelledError();
      throw err;
    }

    // A cancel that arrived after the last byte landed interrupted nothing, so
    // only the signal says the user withdrew these files.
    if (signal?.aborted) {
      release(opened);
      throw new UploadCancelledError();
    }

    onFinalizing?.();
    // No signal from here on: finalize verifies and settles quota on the
    // server, and aborting the request would undo neither.
    const settled = await this.postJson<{
      attachments: MessageAttachment[];
      failures?: Array<{ objectPath?: string | null; fileName?: string; error?: string }>;
    }>(
      `${base}/upload-finalize`,
      // Each upload carries back its `reservationId`, which finalize deletes.
      { ...scope, uploads: opened.uploads },
    );
    const refused = settled.failures || [];
    if (refused.length > 0) {
      const batch = opened.uploads;
      onRejected?.(refused.map((f) => ({
        name: f.fileName || batch.find((u) => u.objectPath === f.objectPath)?.fileName || 'A file',
        error: f.error || '',
      })));
    }
    return settled.attachments || [];
  }

  /** POST JSON to the API with the caller's credential, or throw its error. */
  private async postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await apiFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getFirebaseToken()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw new Error(parsed?.error || 'Upload failed');
    }
    return parsed as T;
  }

  /**
   * Discard attachments that were uploaded (or copied from the file manager)
   * but never sent, so their bytes stop counting against the firm's storage.
   * Scoped the way the upload was: the client for a direct thread, else the
   * conversation. The server deletes only the caller's own finalized objects
   * that no message names, and a repeat is harmless.
   */
  async discardAttachments(
    lawFirmId: string,
    target: { clientId?: string; conversationId?: string },
    objectPaths: string[],
  ): Promise<{ discarded: number }> {
    if (objectPaths.length === 0) return { discarded: 0 };
    const scope = target.clientId
      ? { clientId: target.clientId }
      : { conversationId: target.conversationId };
    return this.postJson<{ discarded: number }>(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/attachments/discard`,
      { ...scope, objectPaths },
    );
  }

  // Attach documents that already live in the firm's file manager. The server
  // re-verifies read access to each one and copies the bytes into the
  // conversation's own folder, returning ready-to-send MessageAttachments.
  //
  // A document is named by its file id. The name comes from its row, so a
  // request cannot forward one document into a chat under another's name.
  async attachExistingFiles(
    lawFirmId: string,
    target: { clientId?: string; conversationId?: string },
    files: Array<{ fileId: string }>
  ): Promise<MessageAttachment[]> {
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/attachments/from-files`, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ...target, files }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to attach files');
    const data = await response.json();
    return data.attachments || [];
  }

  // ── Group conversations (firm side) ──────────────────────────────────────

  // Create a group conversation. `clientIds` are portal user ids; `memberIds`
  // are firm-member user ids (the creator is added automatically server-side).
  // `organizationClientIds` (max 20) are company `clients.id`s; each is expanded
  // server-side to that company's whole roster and merged with
  // `clientIds` (organization-clients plan Phase 7 ad-hoc group composition).
  async createGroup(
    lawFirmId: string,
    data: { title?: string; matterIds?: string[]; memberIds?: string[]; clientIds?: string[]; clientRecordIds?: string[]; organizationClientIds?: string[] }
  ): Promise<{ conversationId: string }> {
    const response = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/messaging/groups`, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to create group');
    return response.json();
  }

  // One window of the calling member's group threads within a firm, with the total
  // number of matches. Takes the same window/filter options as the direct list so the
  // two can be merged into a single most-recent-first list of the same depth.
  async listGroupsPage(
    lawFirmId: string,
    opts: ConversationListQuery = {}
  ): Promise<ConversationPage> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups${conversationListParams(opts)}`,
      { headers: await authenticatedHeaders() }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to fetch group conversations');
    const data = await response.json();
    const conversations: Conversation[] = data.conversations || [];
    return { conversations, totalItems: Number(data.totalItems) || conversations.length };
  }

  // Every group thread the calling member is in within a firm. Rows carry a
  // per-viewer `unreadCount`.
  async listGroups(
    lawFirmId: string,
    opts: ConversationListQuery = {},
  ): Promise<Conversation[]> {
    const { conversations } = await this.listGroupsPage(lawFirmId, opts);
    return conversations;
  }

  // Resolve (find or create) a COMPANY client's canonical conversation
  // (organization-clients plan Phase 7). Always returns a conversationId: the
  // backend creates the thread on first call if none exists yet, the same
  // lazy-creation contract a person client's direct thread already gets on
  // first send. The result is a group-type conversation id, loadable through
  // `getGroup`/`sendGroupMessage` like any other group.
  async getCompanyConversation(
    lawFirmId: string,
    clientId: string,
  ): Promise<{ conversationId: string }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/company-conversation/${clientId}`,
      { headers: await authenticatedHeaders() }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to load company conversation');
    return response.json();
  }

  // Load a group thread: conversation metadata, participants, and a page of
  // messages. `lastMessageId` pages backwards through history.
  async getGroup(
    lawFirmId: string,
    conversationId: string,
    opts: { limit?: number; lastMessageId?: string } = {}
  ): Promise<GroupConversationResponse> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.lastMessageId) params.set('lastMessageId', opts.lastMessageId);
    const qs = params.toString();
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}${qs ? `?${qs}` : ''}`,
      { headers: await authenticatedHeaders() }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to load group');
    return response.json();
  }

  async sendGroupMessage(
    lawFirmId: string,
    conversationId: string,
    body: { content: string; attachments?: MessageAttachment[]; mentions?: string[] }
  ): Promise<{ messageId: string; conversationId: string }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/messages`,
      {
        method: 'POST',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to send message');
    return response.json();
  }

  async markGroupRead(lawFirmId: string, conversationId: string): Promise<void> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/mark-read`,
      {
        method: 'PUT',
        headers: await authenticatedHeaders(),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to mark group as read');
  }

  // `organizationClientIds` (max 20) are company `clients.id`s; each is expanded
  // server-side to that company's whole roster and merged with
  // `clientIds` (organization-clients plan Phase 7 ad-hoc group composition).
  async addGroupParticipants(
    lawFirmId: string,
    conversationId: string,
    data: { memberIds?: string[]; clientIds?: string[]; clientRecordIds?: string[]; organizationClientIds?: string[]; shareHistory?: boolean }
  ): Promise<{ message: string; conversationType?: string; converted?: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/participants`,
      {
        method: 'POST',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to add participants');
    return response.json();
  }

  // Replace a group's matter scope (organizational tag; zero, one, or many
  // matters). Firm members only. Returns the saved matter ids.
  async setGroupMatters(
    lawFirmId: string,
    conversationId: string,
    matterIds: string[]
  ): Promise<{ message: string; matterIds: string[] }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/matters`,
      {
        method: 'PUT',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ matterIds }),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update matter scope');
    return response.json();
  }

  async setGroupPrivacy(
    lawFirmId: string,
    conversationId: string,
    hideClientNames: boolean
  ): Promise<{ message: string; hideClientNames: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/privacy`,
      {
        method: 'PUT',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ hideClientNames }),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update messaging privacy');
    return response.json();
  }

  async getPresentAsFirm(lawFirmId: string): Promise<{ presentAsFirm: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/present-as-firm`,
      { headers: await authenticatedHeaders() }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to load messaging preference');
    return response.json();
  }

  async setPresentAsFirm(
    lawFirmId: string,
    presentAsFirm: boolean
  ): Promise<{ message: string; presentAsFirm: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/present-as-firm`,
      {
        method: 'PUT',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ presentAsFirm }),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update messaging preference');
    return response.json();
  }

  async removeGroupParticipant(
    lawFirmId: string,
    conversationId: string,
    userId: string
  ): Promise<{ message: string; conversationType?: string; converted?: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/participants/${userId}`,
      {
        method: 'DELETE',
        headers: await authenticatedHeaders(),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to remove participant');
    return response.json();
  }

  // Remove a recipient added before they had a portal account. They are keyed by
  // `clients.id`, not a portal uid, so they need their own endpoint: the
  // participant route above cannot address anyone who has no participant row.
  async removePendingGroupClient(
    lawFirmId: string,
    conversationId: string,
    clientRecordId: string
  ): Promise<{ message: string }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/groups/${conversationId}/pending/${clientRecordId}`,
      {
        method: 'DELETE',
        headers: await authenticatedHeaders(),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to remove pending recipient');
    return response.json();
  }

  // Firm-side archive/unarchive of a conversation (direct or group).
  async setConversationArchived(
    lawFirmId: string,
    conversationId: string,
    archived: boolean
  ): Promise<{ message: string; archived: boolean }> {
    const response = await apiFetch(
      `${API_URL}/lawfirms/${lawFirmId}/messaging/conversations/${conversationId}/archive`,
      {
        method: 'PUT',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ archived }),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update conversation');
    return response.json();
  }
}

const messagesService = new MessagesService();
export default messagesService;
