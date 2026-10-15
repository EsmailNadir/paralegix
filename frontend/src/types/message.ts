// A matter a conversation is scoped to, carried with its display name/number so
// the thread header can show it without a separate (permissioned) matters fetch.
export interface ConversationMatter {
  id: string;
  name: string;
  matterNumber?: string | null;
}

export interface Conversation {
  conversationId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  lawFirmId: string;
  lawFirmName?: string;
  // Signed firm logo URL, surfaced on group threads for a client viewer so the
  // collapsed "Law Firm" roster entry shows the firm logo instead of initials.
  lawFirmLogoUrl?: string | null;
  lastMessageAt: Date | string;
  lastMessagePreview: string;
  unreadCountClient: number;
  unreadCountFirm: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  // Signed avatar for the client in a direct conversation (firm-side list rows).
  clientPhotoUrl?: string | null;
  // Group-conversation fields. Direct conversations leave these undefined; a
  // 'group' conversationType marks a shared multi-participant thread whose row
  // carries its own per-viewer unread total in `unreadCount`.
  conversationType?: 'direct' | 'group';
  title?: string;
  matterId?: string | null;
  // Full set of matters a group is scoped to (organizational tag). The primary
  // matterId above is the first of this set.
  matterIds?: string[];
  // Same matters, resolved to display name/number for the thread header.
  matters?: ConversationMatter[];
  // True when the firm masks other clients' names for this (client) viewer.
  clientNamesMasked?: boolean;
  // Raw per-conversation "hide client names" setting (for firm managers' toggle);
  // distinct from clientNamesMasked, which is only ever true for client viewers.
  hideClientNames?: boolean;
  // Group rows only: the OTHER participants' names (viewer excluded, co-clients
  // masked to "Client" for privacy-enabled client viewers). Drives the list-row
  // label so an untitled group reads as its members instead of "Group conversation".
  participantNames?: string[];
  unreadCount?: number;
  // Group rows only, firm-side list only: the user ids of the client participants,
  // so a client-scoped view can tell which groups a given client belongs to.
  clientParticipantIds?: string[];
  // Firm-side archive marker. Non-null when the conversation has been archived out
  // of the firm's active inbox; null/undefined for active threads.
  archivedAt?: string | null;
}

// Optional server-side window/filter for a conversation-list read. Every field is
// optional and omitting all of them requests the full unfiltered list, which is what
// the callers that pick one thread out of the whole set still do.
export interface ConversationListQuery {
  limit?: number;
  offset?: number;
  /** 1-based page number. `offset` wins when both are supplied. */
  page?: number;
  search?: string;
  // Selects one side of the firm's archive split. Omitted returns both.
  archived?: boolean;
  /** Portal user id(s), not clients-table ids. */
  clientId?: string;
  clientIds?: string[];
  matterId?: string;
}

// One window of a conversation list. `totalItems` counts every conversation matching
// the query's filters, not just the ones in this window, so a partially loaded list
// can still show a real total and know whether more remain.
export interface ConversationPage {
  conversations: Conversation[];
  totalItems: number;
}

// A participant of a group conversation (firm member or client), with a signed
// avatar URL when they have a profile photo.
export interface GroupParticipant {
  userId: string;
  type: 'client' | 'firm_member';
  name: string;
  email: string;
  photoUrl?: string | null;
  lastReadAt?: string | null;
}

// The full group thread payload returned by the group GET endpoints.
export interface GroupConversation {
  conversationId: string;
  conversationType: 'group';
  title: string;
  matterId: string | null;
  matterIds?: string[];
  // Linked matters resolved to display name/number for the thread header.
  matters?: ConversationMatter[];
  // True when the firm masks other clients' names for this (client) viewer.
  clientNamesMasked?: boolean;
  // Raw per-conversation "hide client names" setting (drives firm managers' toggle).
  hideClientNames?: boolean;
  lawFirmId: string;
  lawFirmName: string;
  lawFirmLogoUrl?: string | null;
  lastMessageAt: string | null;
}

export interface GroupConversationResponse {
  conversation: GroupConversation;
  participants: GroupParticipant[];
  messages: Message[];
  hasMore: boolean;
  /**
   * People who were on this thread and were removed from it, by portal uid and by
   * client record id. Firm-side only; a client read returns them empty. The
   * add-people picker marks them, and they flip the history toggle's default.
   */
  removedParticipantIds?: string[];
  removedClientRecordIds?: string[];
  /**
   * People the firm already added who have no portal account yet, so they are
   * waiting rather than participating. They join the thread the day they
   * register. Firm-side only; a client read returns them empty.
   */
  pendingClients?: PendingGroupClient[];
}

/** A recipient added before they had a portal account, keyed by `clients.id`. */
export interface PendingGroupClient {
  clientRecordId: string;
  name: string;
  email: string;
  historyVisibleFrom: string | null;
}

export interface MessageAttachment {
  id?: string;
  name: string;
  url: string;
  objectPath: string;
  mimeType: string;
  size: number;
}

export interface Message {
  messageId: string;
  senderId: string;
  senderType: 'client' | 'firm_member';
  senderName: string;
  content: string;
  attachments?: MessageAttachment[];
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  read: boolean;
  // Raw per-side read cursors (direct threads). Unlike `read` (which is
  // viewer-centric - always true for the viewer's own sends), these say whether
  // each PARTY has read the message, so an own message's receipt can show whether
  // the RECIPIENT has seen it: a firm send is "seen" once readByClient, a client
  // send once readByFirm.
  readByClient?: boolean;
  readByFirm?: boolean;
  readAt?: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  matterId?: string;
  // Signed avatar URL for the sender (attached by the backend on message reads).
  senderPhotoUrl?: string | null;
  // The firm member sent this under the firm's identity ("send as firm"). Client
  // viewers see the firm name/logo; used to mask live (realtime) direct messages.
  sentAsFirm?: boolean;
  // Set when the sender has edited the message (marker only; the original text is
  // not retained). Drives the "edited" label next to the bubble.
  editedAt?: Date | string | null;
  // True when the message was soft-deleted. The server masks content + strips
  // attachments; the UI renders a muted "This message was deleted" tombstone.
  deleted?: boolean;
  // 'system' rows are inline participant add/remove events, rendered as a centered
  // activity line instead of a chat bubble. `systemEvent` carries the structured
  // payload (masked/filtered server-side); the UI renders from it, not `content`.
  kind?: 'user' | 'system';
  systemEvent?: {
    action: 'participant_added' | 'participant_removed';
    subjectUserId: string;
    subjectType: 'client' | 'firm_member';
    subjectName: string;
  } | null;
}

// One row of the portal's per-firm conversation list (organization-clients plan
// Phase 7): every conversation the authenticated portal uid participates in for
// one firm, tagged with which client record it belongs to. `clientRecordId` is
// null for an ad-hoc group with no company binding; `clientType` is null for
// the same case and 'person'/'company' otherwise. See
// `GET /client-portal/lawfirm/:lawFirmId/messages/conversations`.
export interface PortalConversationSummary {
  conversationId: string;
  conversationType: 'direct' | 'group';
  clientRecordId: string | null;
  clientType: 'person' | 'company' | null;
  title: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCount: number;
  archivedAt: string | null;
}

// A single in-message search hit: the conversation it belongs to, a masked
// snippet, and the (masked) sender name. Clicking a result opens the conversation.
export interface MessageSearchResult {
  conversationId: string;
  conversationType: 'direct' | 'group';
  conversationTitle: string;
  lawFirmId: string;
  messageId: string;
  snippet: string;
  senderName: string;
  createdAt: string | null;
}

export interface SendMessageData {
  lawFirmId: string;
  clientId: string;
  content: string;
  matterId?: string;
  attachments?: MessageAttachment[];
  /** User ids @mentioned in the message (drives mention notifications). */
  mentions?: string[];
}


