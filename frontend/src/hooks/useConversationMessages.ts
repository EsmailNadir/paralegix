"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { authorizeRealtime, getRealtimeClient, onRealtimeResume, retainRealtime, releaseRealtime } from '@/lib/supabase/realtimeClient';
import { deferWhileHidden } from '@/lib/supabase/deferWhileHidden';
import messagesService from '@/services/messages.service';
import clientPortalService from '@/services/client-portal.service';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import { getErrorMessage } from '@/lib/utils/apiErrors';

import type { Message, Conversation, GroupParticipant, PendingGroupClient } from '@/types';

/**
 * Messages fetched per read - the batch a thread opens with, and the batch each
 * step back through history adds. One value for every thread shape (firm and
 * portal, direct and group): the four read paths used to disagree, so a firm-side
 * direct thread opened on 10 messages while every other thread opened on 25, and
 * paging back through a long thread took two and a half times as many round trips.
 */
const MESSAGE_PAGE_SIZE = 30;

// Postgres returns timestamps as ISO strings, so this handles Date,
// epoch-number and ISO-string inputs.
function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const millis = value > 1e12 ? value : value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

// A loosely-typed message row from any of our three sources: the firm REST API
// (camelCase), the client-portal REST API (camelCase, sometimes `timestamp`/
// `id`), or a Supabase Realtime `messages` row (snake_case). The single mapper
// below reads whichever keys are present so the read-semantics live in one place.
type AnyMessageRow = Record<string, any>;

// Single source of truth for row→Message normalization. Keyed on `isClient` for
// the one piece of logic that differs: how `read` is derived. Reading both
// camelCase and snake_case keys lets this serve the firm REST, client-portal
// REST, and Realtime-payload paths without three near-duplicate mappers.
//
// `directApply` marks the Realtime fast path, whose payload never carries
// signed attachment URLs (only objectPath). Those rows are guaranteed
// attachment-free by canApplyRowDirectly, so we force `attachments: []`.
function normalizeMessage(row: AnyMessageRow, isClient: boolean, directApply = false, isGroup = false): Message {
  const senderType = (row.senderType ?? row.sender_type) === 'client' ? 'client' : 'firm_member';
  const createdAtRaw = row.createdAt ?? row.created_at ?? row.timestamp ?? new Date();
  const createdAt = toDateOrNull(createdAtRaw) || new Date();
  const updatedAt = toDateOrNull(row.updatedAt ?? row.updated_at) || createdAt;
  const readAtRaw = row.readAt ?? row.read_at;
  const readByClient = row.readByClient ?? row.read_by_client;
  const readByFirm = row.readByFirm ?? row.read_by_firm;
  // Read semantics: group rows carry a per-viewer `read` the server derives from
  // the viewer's read cursor, so trust it as-is (the direct-thread heuristics
  // below would wrongly count a co-client's unread message as read). For a direct
  // thread each side keys off its OWN read cursor, not the shared `read` column:
  // that column only flips true when the OPPOSITE party reads the message (it's a
  // "delivered/seen by the other side" flag), so it's wrong for deciding what's
  // unread to the current viewer. The client side is unread until read_by_client;
  // the firm side until read_by_firm. Each side's own sends always count as read
  // (a firm member has "seen" the firm's own message, likewise a client), which
  // also stops a co-member's message from showing as perpetually unread - firm
  // markRead only clears client-sent rows, so a firm-sent row keyed on `read`
  // could never be cleared.
  const read = isGroup
    ? row.read === true
    : isClient
      ? (readByClient === true || senderType === 'client')
      : (readByFirm === true || senderType === 'firm_member');

  // Soft-deleted messages: the REST paths already mask content + strip
  // attachments, but a raw Realtime row (direct threads) still carries the
  // retained content/attachments, so mask here too. This keeps a directly-applied
  // deleted row from rendering its original text and drives the tombstone.
  const deleted = (row.deleted ?? (row.deleted_at != null)) === true;
  const editedAt = row.editedAt ?? row.edited_at ?? null;

  return {
    messageId: row.messageId ?? row.id ?? '',
    senderId: row.senderId ?? row.sender_user_id ?? '',
    senderType,
    senderName: row.senderName ?? row.sender_name ?? (senderType === 'client' ? 'Client' : 'Law Firm'),
    content: deleted ? '' : (row.content || ''),
    attachments: (directApply || deleted) ? [] : (row.attachments || []),
    status: (row.status as Message['status']) || 'sent',
    read,
    readByClient: readByClient === true,
    readByFirm: readByFirm === true,
    readAt: readAtRaw ? (toDateOrNull(readAtRaw) || undefined) : undefined,
    createdAt,
    updatedAt,
    matterId: row.matterId ?? row.matter_id ?? undefined,
    senderPhotoUrl: row.senderPhotoUrl ?? row.sender_photo_url ?? null,
    sentAsFirm: (row.sentAsFirm ?? row.sent_as_firm) === true,
    editedAt: editedAt ?? null,
    deleted,
    kind: row.kind === 'system' ? 'system' : 'user',
    systemEvent: row.systemEvent ?? row.system_event ?? null,
  } as Message;
}

// Map a raw client-portal message payload into the UI `Message` shape (sorted
// oldest-first, matching the order the firm path returns).
function mapClientMessages(rawMessages: AnyMessageRow[]): Message[] {
  return (rawMessages || [])
    .map((msg) => normalizeMessage(msg, true))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

// Single source of truth for fetching + mapping the latest page of messages for
// a conversation, branching on client vs firm. Used by both the initial load
// and the realtime refetch so the fetch endpoint + mapper stay in lock-step.
// For the firm path the underlying REST response also carries `conversation`
// and `hasMore`, which are surfaced for the initial load (undefined for client).
async function fetchConversationMessages(
  conversationId: string,
  lawFirmId: string,
  isClient: boolean,
  isGroup = false,
  lastMessageId?: string,
): Promise<{
  messages: Message[];
  conversation?: Conversation;
  hasMore?: boolean;
  participants?: GroupParticipant[];
  removedParticipantIds?: string[];
  removedClientRecordIds?: string[];
  pendingClients?: PendingGroupClient[];
}> {
  // Group threads use their own endpoints (firm + client) which return the same
  // { conversation, participants, messages, hasMore } envelope. conversationId is
  // the real conversation uuid on both sides here (no synthetic client key).
  if (isGroup) {
    const data = isClient
      ? await clientPortalService.getGroup(conversationId, { limit: MESSAGE_PAGE_SIZE, lastMessageId })
      : await messagesService.getGroup(lawFirmId, conversationId, { limit: MESSAGE_PAGE_SIZE, lastMessageId });
    const c = data.conversation;
    const conversation: Conversation = {
      conversationId: c.conversationId,
      clientId: '',
      clientName: '',
      clientEmail: '',
      lawFirmId: c.lawFirmId,
      lawFirmName: c.lawFirmName,
      lawFirmLogoUrl: c.lawFirmLogoUrl ?? null,
      lastMessageAt: c.lastMessageAt || new Date(),
      lastMessagePreview: '',
      unreadCountClient: 0,
      unreadCountFirm: 0,
      createdAt: c.lastMessageAt || new Date(),
      updatedAt: c.lastMessageAt || new Date(),
      conversationType: 'group',
      title: c.title,
      matterId: c.matterId,
      matterIds: c.matterIds || [],
      matters: c.matters || [],
      clientNamesMasked: c.clientNamesMasked,
      hideClientNames: c.hideClientNames,
    };
    return {
      messages: (data.messages || []).map((m) => normalizeMessage(m, isClient, false, true)),
      conversation,
      hasMore: data.hasMore,
      participants: data.participants || [],
      // Firm-side only: who used to be on this thread, so the add-people picker
      // can mark a returning person. The client read returns empty arrays.
      removedParticipantIds: data.removedParticipantIds || [],
      removedClientRecordIds: data.removedClientRecordIds || [],
      // Also firm-side only: recipients the firm added who have not registered
      // yet, so the roster shows them instead of leaving them invisible until
      // the day they appear on the thread by themselves.
      pendingClients: data.pendingClients || [],
    };
  }
  if (isClient) {
    const response = await clientPortalService.getMessages(lawFirmId, {
      limit: MESSAGE_PAGE_SIZE,
      lastMessageId,
    });
    return {
      messages: mapClientMessages(response.messages || []),
      hasMore: response.hasMore,
    };
  }
  const data = await messagesService.getConversationMessages(conversationId, lawFirmId, MESSAGE_PAGE_SIZE);
  return {
    messages: data.messages.map((m) => normalizeMessage(m, false)),
    conversation: data.conversation,
    hasMore: data.hasMore,
    // Firm-side direct threads carry a synthesized roster (client + the firm
    // members on the thread) so the header can offer the participants/add-people
    // affordance and convert the 1:1 to a group in place.
    participants: data.participants,
  };
}

// A raw `messages` row as delivered by Supabase Realtime (snake_case Postgres
// columns). Attachments here only carry `objectPath`, never a signed `url`,
// because the backend strips URLs before persisting and only re-signs them on
// REST reads. So a payload message WITH attachments cannot be rendered directly
// and must fall back to a REST refetch.
interface RawMessageRow {
  id?: string;
  sender_user_id?: string;
  sender_type?: string;
  sender_name?: string;
  content?: string;
  attachments?: unknown[];
  status?: string;
  read?: boolean;
  read_by_client?: boolean;
  read_by_firm?: boolean;
  read_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  matter_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
}

// True when the Realtime payload row carries everything the UI needs to render
// the message identically to the REST-fetched version. We require an id and a
// created_at, and we refuse rows that have attachments (their signed `url` is
// never present in the Realtime payload (see RawMessageRow). Such rows fall
// back to a targeted REST refetch instead.
function canApplyRowDirectly(row: RawMessageRow | undefined | null): row is RawMessageRow {
  if (!row || !row.id || !row.created_at) return false;
  if (Array.isArray(row.attachments) && row.attachments.length > 0) return false;
  return true;
}


export function useConversationMessages(
  conversationId: string | null,
  lawFirmId?: string,
  isClient: boolean = false,
  isGroup: boolean = false,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [participants, setParticipants] = useState<GroupParticipant[]>([]);
  const [removedParticipantIds, setRemovedParticipantIds] = useState<string[]>([]);
  const [removedClientRecordIds, setRemovedClientRecordIds] = useState<string[]>([]);
  const [pendingClients, setPendingClients] = useState<PendingGroupClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Switching threads starts from an empty, loading thread. Adjusted during
  // render (not in the load effect) so no render ever pairs the new thread id
  // with the previous thread's messages: the auto-mark-as-read effect below
  // would otherwise advance the new thread's read cursor on the strength of
  // messages the viewer saw in another conversation.
  const [shownThread, setShownThread] = useState({ conversationId, lawFirmId });
  if (shownThread.conversationId !== conversationId || shownThread.lawFirmId !== lawFirmId) {
    setShownThread({ conversationId, lawFirmId });
    setMessages([]);
    setConversation(null);
    setParticipants([]);
    setRemovedParticipantIds([]);
    setRemovedClientRecordIds([]);
    setPendingClients([]);
    setHasMore(true);
    setError(null);
    setLoading(!!conversationId && !!lawFirmId);
  }

  // The client's firms are already fetched by the client layout and shared via
  // ClientPortalContext. Held in a ref so the new-thread firm-name lookup below
  // can read it without adding a dependency that would re-run the load effect
  // (this hook is deliberately careful about dependency-driven refetch loops).
  const { lawFirms: portalFirms } = useClientPortal();
  const portalFirmsRef = useRef(portalFirms);
  portalFirmsRef.current = portalFirms;

  // Tracks the thread this hook instance is currently showing, so a `loadMore`
  // page requested for one thread cannot land in state after the viewer has
  // since switched to another (this hook is shared across a thread switch
  // rather than remounted, so state persists unless explicitly guarded).
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const channelRef = useRef<RealtimeChannel | null>(null);
  // The roster, read by the live-row merge to give a new message its sender's
  // photo without re-running the subscription effect when the roster changes.
  const participantsRef = useRef<GroupParticipant[]>(participants);
  participantsRef.current = participants;
  // Gates the realtime refetch so it only fires after the initial load has
  // completed. Using a ref (not reactive state) keeps it out of the effect's
  // dependency array, preventing the cleanup→re-run→double-fetch loop.
  const hasLoadedRef = useRef(false);
  // Tracks message ids we've already issued a read POST for, so the auto-mark
  // effect only fires for genuinely new unread messages (not every realtime
  // append).
  const markedReadIdsRef = useRef<Set<string>>(new Set());

  // Initial load + Supabase Realtime subscription.
  useEffect(() => {
    if (!conversationId || !lawFirmId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- effect does the initial async load and opens a Supabase Realtime subscription
      setMessages([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Mark an active subscriber so the shared JWT refresh timer runs while this
    // channel is open and stops once it (and every other channel) is gone.
    // This runs only AFTER the conversationId/lawFirmId guard above returns early
    // (a not-yet-created conversation never reaches here), so retain is paired
    // with exactly one releaseRealtime() in this effect's cleanup below.
    retainRealtime();

    // Reset the load gate for this conversation. Realtime events only trigger
    // a refetch once the initial load below has finished.
    hasLoadedRef.current = false;
    markedReadIdsRef.current = new Set();

    // Merge an array of newly-mapped messages into state by messageId, then
    // re-sort oldest-first. Existing messages are updated in place (so read-flag
    // changes from an UPDATE event apply), new ones are appended. Returns the
    // previous reference unchanged when nothing actually changed, to avoid
    // needless re-renders.
    //
    // `live` marks rows mapped from a Realtime payload. Those carry no photo
    // column and the raw sender name, so they never overwrite the photo or the
    // name a REST read already resolved, and a new live message borrows the
    // photo its sender already shows in the thread (or on the roster).
    const mergeMessages = (incoming: Message[], live = false) => {
      if (incoming.length === 0) return;
      setMessages(prev => {
        const byId = new Map(prev.map(m => [m.messageId, m]));
        const knownPhoto = (msg: Message): string | null => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const other = prev[i];
            if (other.senderId === msg.senderId && !!other.sentAsFirm === !!msg.sentAsFirm && other.senderPhotoUrl) {
              return other.senderPhotoUrl;
            }
          }
          if (msg.sentAsFirm) return null;
          return participantsRef.current.find((p) => p.userId === msg.senderId)?.photoUrl ?? null;
        };
        let changed = false;
        for (const msg of incoming) {
          const existing = byId.get(msg.messageId);
          if (!existing) {
            byId.set(msg.messageId, live && !msg.senderPhotoUrl ? { ...msg, senderPhotoUrl: knownPhoto(msg) } : msg);
            changed = true;
          } else if (
            existing.read !== msg.read ||
            existing.readByClient !== msg.readByClient ||
            existing.readByFirm !== msg.readByFirm ||
            existing.content !== msg.content ||
            existing.status !== msg.status ||
            existing.deleted !== msg.deleted ||
            existing.editedAt !== msg.editedAt
          ) {
            // Preserve already-resolved attachments (signed URLs) on the
            // existing message; the direct-apply path never carries them. A
            // newly-deleted message drops its attachments (server strips them).
            const attachments = msg.deleted ? [] : existing.attachments;
            byId.set(msg.messageId, {
              ...existing,
              ...msg,
              attachments,
              senderName: live ? existing.senderName : msg.senderName,
              senderPhotoUrl: msg.senderPhotoUrl ?? existing.senderPhotoUrl,
            });
            changed = true;
          }
        }
        if (!changed) return prev;
        return Array.from(byId.values()).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });
    };

    // On each realtime event, re-fetch the latest messages from the REST API
    // (the authoritative camelCase source) and merge any new ones in.
    // Realtime is purely a change trigger, no snake_case payload mapping.
    // In a hidden tab this only records that the thread changed; the re-fetch
    // runs once when the tab is visible again (see `deferWhileHidden`).
    const fetchLatest = deferWhileHidden(async () => {
      try {
        const { messages: latest, participants: latestParticipants } =
          await fetchConversationMessages(conversationId, lawFirmId, isClient, isGroup);
        if (cancelled) return;
        mergeMessages(latest);
        if (isGroup && latestParticipants) setParticipants(latestParticipants);
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error('Message refetch error:', err);
        }
      }
    });

    const refetchLatest = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        fetchLatest.run();
      }, 250);
    };

    // Headline efficiency win: apply the Realtime payload row directly instead
    // of round-tripping to REST for every change. The payload already contains
    // the new/changed `messages` row. We map it (snake→camel, matching the REST
    // mappers' shape) and merge by messageId, no fetch.
    //
    // CRITICAL SAFETY FALLBACK: we only direct-apply when the row is renderable
    // identically to the REST version (canApplyRowDirectly): it must have id +
    // created_at and must NOT have attachments (their signed `url` is absent
    // from the Realtime payload). Anything else, including attachments present, missing
    // fields, or DELETE events, falls back to the debounced REST refetch, which
    // re-signs attachments and stays the source of truth. Dedupe-by-messageId
    // and ordering are preserved by mergeMessages.
    const handleRealtimeEvent = (payload: { eventType?: string; new?: RawMessageRow }) => {
      if (!hasLoadedRef.current) return;
      const row = payload?.new;
      const evt = payload?.eventType;
      if ((evt === 'INSERT' || evt === 'UPDATE') && canApplyRowDirectly(row)) {
        mergeMessages([normalizeMessage(row, isClient, true)], true);
        return;
      }
      // DELETE, attachment-bearing, or incomplete rows: targeted REST refetch.
      refetchLatest();
    };

    // `realConversationId` must be the actual `conversations.id` (a uuid). On the
    // client portal the `conversationId` prop is a synthetic `${lawFirmId}_${uid}`
    // key, which would never match the uuid `messages.conversation_id` column,
    // so callers must pass the resolved uuid from the loaded conversation.
    // The uuid the channel was last opened for, so a resume can reopen it.
    let subscribedConversationId: string | null = null;

    const subscribe = async (realConversationId: string) => {
      if (!realConversationId) return;
      subscribedConversationId = realConversationId;
      const supabase = await authorizeRealtime();
      if (cancelled || !supabase) return;
      // A resume can reopen while an earlier open is still resolving; keep one.
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      // Group threads use a content-free Broadcast ping (fired by the backend on
      // every group send) as the live-update trigger for BOTH firm members and
      // clients, then re-fetch the messages via REST. Two reasons this is the one
      // path for groups:
      //   1. Clients must not stream the raw `messages` row -- it carries a co-
      //      client's plaintext sender_name (RLS/migration 0105 forbids it).
      //   2. Firm members' row-level `postgres_changes` on `messages` don't
      //      reliably deliver for group threads, so a viewer would otherwise miss
      //      live sends until a reload.
      // The ping carries only ids (no name/content); the REST refetch stays
      // authoritative (re-signs attachments, applies client-name masking).
      if (isGroup) {
        channelRef.current = supabase
          .channel(`groupmsg:${realConversationId}`)
          .on('broadcast', { event: 'new' }, () => refetchLatest())
          .subscribe();
        return;
      }

      // A client's direct thread: re-read through the masked portal REST path
      // on either of two content-free triggers. A raw messages row would hand
      // the client the real sender of a "send as firm" message and the retained
      // text of a deleted one, so RLS (migration 0040) lets only firm members
      // stream message rows.
      //   1. The client's own conversations row, which moves on every send.
      //   2. The conversation's broadcast ping, the same one groups use, which
      //      the backend fires for what leaves that row alone: an edit, a soft
      //      delete, and the firm reading the client's messages. The channel is
      //      named for the ping's topic so one channel carries both.
      if (isClient) {
        channelRef.current = supabase
          .channel(`groupmsg:${realConversationId}`)
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'conversations',
              filter: `id=eq.${realConversationId}`,
            },
            () => refetchLatest(),
          )
          .on('broadcast', { event: 'new' }, () => refetchLatest())
          .subscribe();
        return;
      }

      // A firm member's direct thread: stream the message rows directly. A
      // payload row is applied directly when renderable, else it falls back to a
      // REST refetch.
      channelRef.current = supabase
        .channel(`messages:${realConversationId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${realConversationId}`,
          },
          (payload) => handleRealtimeEvent(payload as { eventType?: string; new?: RawMessageRow }),
        )
        .subscribe();
    };

    const setupListener = async () => {
      try {
        setLoading(true);
        setError(null);

        // Group threads: same load path for firm and client. conversationId is
        // the real conversation uuid, so we can subscribe to it directly (RLS
        // authorizes participants). Participants + title come back in the payload.
        if (isGroup) {
          const groupData = await fetchConversationMessages(conversationId, lawFirmId, isClient, true);
          if (cancelled) return;
          setMessages(groupData.messages);
          setConversation(groupData.conversation ?? null);
          setParticipants(groupData.participants || []);
          setRemovedParticipantIds(groupData.removedParticipantIds || []);
          setRemovedClientRecordIds(groupData.removedClientRecordIds || []);
          setPendingClients(groupData.pendingClients || []);
          setHasMore(groupData.hasMore ?? false);
          hasLoadedRef.current = true;
          await subscribe(conversationId);
          return;
        }

        if (isClient) {
          const [{ messages: mappedMessages, hasMore: clientHasMore }, clientConversations] = await Promise.all([
            fetchConversationMessages(conversationId, lawFirmId, true),
            messagesService.getClientConversations().catch(() => [] as Conversation[]),
          ]);
          if (cancelled) return;

          setMessages(mappedMessages);
          const matchedConversation =
            clientConversations.find((conv) => conv.conversationId === conversationId)
            || clientConversations.find((conv) => conv.lawFirmId === lawFirmId)
            || null;

          if (matchedConversation) {
            setConversation(matchedConversation);
          } else {
            // Prefer the shared portal firm list; only fall back to a fetch if
            // the firm somehow isn't in it (should not happen for a valid thread).
            let matchedFirm: { name?: string } | undefined = portalFirmsRef.current.find(
              (firm) => firm.id === lawFirmId,
            );
            if (!matchedFirm) {
              const firmsResponse = await clientPortalService.getMyLawFirms().catch(() => ({ lawFirms: [] as any[] }));
              matchedFirm = (firmsResponse.lawFirms || []).find((firm: any) => firm.id === lawFirmId);
            }
            if (matchedFirm?.name) {
              const now = new Date();
              setConversation({
                conversationId,
                clientId: '',
                clientName: '',
                clientEmail: '',
                lawFirmId,
                lawFirmName: matchedFirm.name,
                lastMessageAt: now,
                lastMessagePreview: '',
                unreadCountClient: 0,
                unreadCountFirm: 0,
                createdAt: now,
                updatedAt: now,
              });
            } else {
              setConversation(null);
            }
          }
          setHasMore(clientHasMore ?? false);
          hasLoadedRef.current = true;

          // Subscribe so incoming firm messages appear instantly. The client's
          // `conversationId` prop is the synthetic `${lawFirmId}_${uid}` key, so
          // we must use the real uuid from the resolved conversation; without a
          // resolved conversation row there's nothing to watch yet.
          if (matchedConversation?.conversationId) {
            await subscribe(matchedConversation.conversationId);
          }
          return;
        }

        // Initial load: Get last 25 messages via API (for pagination)
        try {
          const initialData = await fetchConversationMessages(conversationId, lawFirmId, false);

          if (cancelled) return;

          setMessages(initialData.messages);
          setConversation(initialData.conversation ?? null);
          setParticipants(initialData.participants || []);
          setHasMore(initialData.hasMore ?? false);
        } catch (fetchErr) {
          // If conversation doesn't exist yet, treat as new (empty) conversation
          if (fetchErr instanceof Error && fetchErr.message === 'Conversation not found') {
            setMessages([]);
            setHasMore(false);
            // Skip the realtime subscription. The conversation row doesn't
            // exist yet so there's nothing to watch. The subscription will be
            // set up when the effect re-runs after the first message is sent.
            hasLoadedRef.current = true;
            return;
          } else {
            throw fetchErr;
          }
        }

        if (cancelled) return;
        hasLoadedRef.current = true;

        // Subscribe for new messages on this conversation. On the firm side the
        // `conversationId` prop is already the real conversation uuid.
        await subscribe(conversationId);
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to load messages'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    setupListener();

    // The token lapsed while the tab was hidden, so the server closed the
    // channel and messages since went undelivered: reopen it and re-read once.
    const stopResume = onRealtimeResume(() => {
      if (cancelled || !subscribedConversationId) return;
      subscribe(subscribedConversationId);
      refetchLatest();
    });

    return () => {
      cancelled = true;
      stopResume();
      fetchLatest.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (channelRef.current) {
        getRealtimeClient()?.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      releaseRealtime();
    };
  }, [conversationId, lawFirmId, isClient, isGroup, refreshKey]);

  // Re-initialize the hook (e.g. after the first message creates the conversation)
  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  // Load more messages (pagination) - loads OLDER messages
  const loadMore = useCallback(async () => {
    if (!conversationId || !lawFirmId || loadingMore || !hasMore) return;

    // Captured so a page that resolves after the viewer has switched threads
    // (this hook is shared across a thread switch, not remounted) can detect
    // it's stale and skip applying its result to the now-current thread.
    const requestedConversationId = conversationId;
    const isStale = () => conversationIdRef.current !== requestedConversationId;

    try {
      setLoadingMore(true);

      // Get older messages via API - use the FIRST (oldest) message as cursor
      const firstMessage = messages[0];

      // Group threads (firm + client) and the client's direct thread all page
      // through the same cursor-based fetch; only the firm-side direct read has
      // its own endpoint below.
      if (isGroup || isClient) {
        const { messages: older, hasMore: more } = await fetchConversationMessages(
          conversationId, lawFirmId, isClient, isGroup, firstMessage?.messageId
        );
        if (isStale()) return;
        setMessages(prev => {
          const existing = new Set(prev.map(m => m.messageId));
          const prepend = older.filter(m => !existing.has(m.messageId));
          return [...prepend, ...prev];
        });
        setHasMore(more ?? false);
        return;
      }

      const data = await messagesService.getConversationMessages(
        conversationId,
        lawFirmId,
        MESSAGE_PAGE_SIZE,
        firstMessage?.messageId
      );

      if (isStale()) return;

      const older = data.messages.map((m) => normalizeMessage(m, false));

      // Prepend older messages to the beginning of the array, skipping any the
      // list already holds (a realtime append can land between the cursor being
      // read and this batch arriving), which would otherwise duplicate a row.
      setMessages(prev => {
        const existing = new Set(prev.map(m => m.messageId));
        return [...older.filter(m => !existing.has(m.messageId)), ...prev];
      });
      setHasMore(data.hasMore);
    } catch (err) {
      if (isStale()) return;
      setError(getErrorMessage(err, 'Failed to load more messages'));
    } finally {
      setLoadingMore(false);
    }
  }, [conversationId, lawFirmId, isClient, isGroup, messages, loadingMore, hasMore]);

  // Keep the latest messages in a ref so markAsRead can read them without being
  // re-created on every realtime append (which would otherwise re-POST reads).
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  // Mark messages as read when conversation is viewed. Only POSTs for unread
  // messages we haven't already marked, so realtime appends of already-read
  // (or already-marked) messages don't trigger redundant writes.
  const markAsRead = useCallback(async () => {
    if (!conversationId || !lawFirmId) return;
    // Nothing is marked until this thread's own first page has landed: until
    // then the messages in hand are not ones the viewer has seen here.
    if (!hasLoadedRef.current) return;

    const current = messagesRef.current;
    if (current.length === 0) return;

    // Group threads track read state with a per-participant cursor (not per-
    // message flags), so a single idempotent mark-read call advances it. Only
    // fire when the newest message isn't the viewer's own send.
    if (isGroup) {
      const newest = current[current.length - 1];
      if (!newest || markedReadIdsRef.current.has(newest.messageId)) return;
      markedReadIdsRef.current.add(newest.messageId);
      try {
        if (isClient) {
          await clientPortalService.markGroupRead(conversationId);
        } else {
          await messagesService.markGroupRead(lawFirmId, conversationId);
        }
        window.dispatchEvent(new CustomEvent('messages-marked-read', {
          detail: { conversationId },
        }));
      } catch (err) {
        markedReadIdsRef.current.delete(newest.messageId);
        console.error('Failed to mark group as read:', err);
      }
      return;
    }

    const already = markedReadIdsRef.current;
    const unreadMessages = current.filter(m => !m.read && !already.has(m.messageId));
    if (unreadMessages.length === 0) return;

    const messageIds = unreadMessages.map(m => m.messageId);
    // Optimistically record these ids so a concurrent realtime append doesn't
    // queue a duplicate POST for the same messages.
    messageIds.forEach(id => already.add(id));

    try {
      if (isClient) {
        await clientPortalService.markAsRead(lawFirmId, messageIds);
      } else {
        await messagesService.markAsRead(conversationId, lawFirmId, messageIds);
      }
      // Trigger event to refresh unread count in sidebar. Carry the
      // conversationId so the conversation-list hook can zero THIS thread's
      // list-row unread immediately, instead of letting a stale list-row count
      // get re-inflated by a subsequent patch-in-place before a full refetch.
      window.dispatchEvent(new CustomEvent('messages-marked-read', {
        detail: { conversationId },
      }));
    } catch (err) {
      // Roll back so a transient failure can be retried on the next append.
      messageIds.forEach(id => already.delete(id));
      console.error('Failed to mark as read:', err);
    }
  }, [conversationId, lawFirmId, isClient, isGroup]);

  // Auto-mark as read when the conversation is viewed and messages are loaded.
  // Depends on messages.length only as a cheap "something changed" trigger;
  // markAsRead itself filters to genuinely-new unread ids via the ref + Set.
  useEffect(() => {
    if (messages.length > 0 && conversationId && !loading) {
      markAsRead();
    }
  }, [conversationId, messages.length, loading, markAsRead]); // Mark as read when messages load

  return {
    messages, // Messages are already in correct order (oldest first, newest last)
    conversation,
    participants,
    removedParticipantIds,
    removedClientRecordIds,
    pendingClients,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    markAsRead,
    setError,
    refresh,
  };
}
