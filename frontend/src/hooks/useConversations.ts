"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { authorizeRealtime, getRealtimeClient, onRealtimeResume, retainRealtime, releaseRealtime } from '@/lib/supabase/realtimeClient';
import { deferWhileHidden } from '@/lib/supabase/deferWhileHidden';
import { useAuth } from '@/hooks/useAuth';
import messagesService from '@/services/messages.service';
import type { Conversation, ConversationPage } from '@/types';
import { getErrorMessage } from '@/lib/utils/apiErrors';

interface UseConversationsOptions {
  lawFirmId?: string;  // For firm members
  isClient?: boolean;   // For clients
  // Firm-side server-side page/filter over the whole inbox (direct threads plus the
  // caller's group threads). `limit` is the page size and `page` is 1-based;
  // omitting `limit` keeps the unbounded full-list read. `search` and `archived` are
  // applied in SQL so they cover every conversation rather than only the loaded
  // ones. Callers debounce `search` before passing it.
  limit?: number;
  page?: number;
  search?: string;
  archived?: boolean;
}

// A raw `conversations` row as delivered by Supabase Realtime (snake_case).
//
// It carries less than it looks like it should. The client's name and email,
// the firm's name and the last-message preview were all columns here once and
// were all dropped for a join or a derivation, so the payload has none of them,
// and neither has it the unread aggregate, which is a join over `messages`.
// What a payload CAN do is reorder the list and bump an unread badge; the text
// comes from the refetch.
interface RawConversationRow {
  id?: string;
  client_id?: string;
  law_firm_id?: string;
  last_message_at?: string | null;
  last_sender_user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export function useConversations(options: UseConversationsOptions = {}) {
  const { user } = useAuth();
  const { lawFirmId, isClient, limit, page, search, archived } = options;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mirror the latest list so the Realtime handler can decide patch-vs-refetch
  // synchronously without depending on it (which would re-subscribe per change).
  const conversationsRef = useRef<Conversation[]>(conversations);
  conversationsRef.current = conversations;

  // Whether a list for the CURRENT identity has landed. Turning the page or typing
  // in the search box refetches without flipping `loading` back on, so the view
  // keeps rendering rows instead of blanking to a full-page spinner.
  const loadedOnceRef = useRef(false);

  const fetchPage = useCallback(async (): Promise<ConversationPage> => {
    if (isClient) {
      // The portal reads the full list: a client has one direct thread per firm, so
      // there is nothing to window.
      const clientConversations = await messagesService.getClientConversations();
      return { conversations: clientConversations, totalItems: clientConversations.length };
    }
    if (lawFirmId) {
      return messagesService.getFirmInboxPage(lawFirmId, { limit, page, search, archived });
    }
    return { conversations: [], totalItems: 0 };
  }, [isClient, lawFirmId, limit, page, search, archived]);

  // The Realtime handler needs the CURRENT page and filters, but the subscription
  // must not depend on them: every pager click and every debounced keystroke would
  // otherwise tear the channel down and rebuild it.
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;

  // Read synchronously by the Realtime handler to decide whether patching a row in
  // place is still sound (see patchInPlace). Kept in a ref for the same reason as
  // fetchPage: the subscription must not rebuild when the user turns the page.
  const pageRef = useRef(page);
  pageRef.current = page;

  // Signal that this list changed so the sidebar badge and the group-thread
  // queries refresh (they re-read their own authoritative source on this event;
  // it carries no payload - the direct-thread list here excludes group unread, so
  // a total computed from it would be incomplete anyway).
  const broadcastUnread = useCallback(() => {
    window.dispatchEvent(new CustomEvent('unread-count-updated'));
  }, []);

  // A different firm (or a switch between the firm and portal identity) is a whole
  // new list, so the next load shows the initial loading state instead of paging on
  // top of the previous identity's rows. Declared before the load effect so it has
  // already run by the time that one reads the flag.
  useEffect(() => {
    loadedOnceRef.current = false;
  }, [lawFirmId, isClient]);

  // Initial load, and a reload whenever the page or the filters change.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadConversations = async () => {
      try {
        if (!loadedOnceRef.current) setLoading(true);
        setFetching(true);
        setError(null);

        const page = await fetchPage();
        if (cancelled) return;

        loadedOnceRef.current = true;
        setConversations(page.conversations);
        setTotalItems(page.totalItems);
        broadcastUnread();
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Failed to load conversations'));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setFetching(false);
        }
      }
    };

    loadConversations();
    return () => { cancelled = true; };
  }, [user, fetchPage, broadcastUnread]);

  // Real-time listener: subscribe to changes on the `conversations` table.
  //
  // Fast path: when the changed row already exists in our list, patch it in
  // place from the Realtime payload (map snake→camel, merge by id), updating
  // the last-message preview/timestamp and re-sorting, instead of re-running
  // the whole-list CONV_SELECT. The payload does NOT carry the derived unread
  // aggregate, so we increment the acting side's unread when the last message
  // came from the other party (mirroring the server's derived count for the
  // common "new inbound message" matter) and leave it otherwise.
  //
  // Fallback: a conversation that is not on the loaded page (a brand-new thread, or
  // an older one that a new message has just made the most recent), a group thread,
  // a DELETE, or an incomplete payload falls back to the debounced REST refetch,
  // which is authoritative for names + unread counts. The refetch re-reads the
  // CURRENT page, so the row set stays consistent with what the server would serve.
  useEffect(() => {
    if (typeof window === 'undefined' || !user || (!lawFirmId && !isClient)) return;

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Mark an active subscriber so the shared JWT refresh timer runs while this
    // channel is open and stops once it (and every other channel) is gone.
    retainRealtime();

    // A hidden tab only records that the list changed; the re-read runs once
    // when the tab is visible again (see `deferWhileHidden`).
    const refetchNow = deferWhileHidden(async () => {
      try {
        const page = await fetchPageRef.current();
        if (cancelled) return;
        setConversations(page.conversations);
        setTotalItems(page.totalItems);
        broadcastUnread();
      } catch (err) {
        if (cancelled) return;
        console.error('Conversation refetch error:', err);
        setError('Failed to sync conversations');
      }
    });

    const refetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        refetchNow.run();
      }, 300);
    };

    // Patch an existing conversation in place from a Realtime payload row.
    // Returns true if it was applied; false (no matching row / not enough info)
    // means the caller should fall back to a full refetch. The decision uses the
    // ref (synchronous) so the fallback choice never races React's batching.
    const patchInPlace = (row: RawConversationRow | undefined | null): boolean => {
      if (!row?.id) return false;
      // Only the first page can be patched. Activity on any row promotes it to the
      // top of the whole inbox, which on page 1 is a reorder WITHIN the page (its
      // membership is unchanged), but on any later page changes which rows belong
      // to that page - so those must come from the server.
      const currentPage = pageRef.current;
      if (currentPage != null && currentPage !== 1) return false;
      const current = conversationsRef.current;
      const idx = current.findIndex(c => c.conversationId === row.id);
      // Not on the loaded page (new conversation, or one below it) -> refetch.
      if (idx === -1) return false;

      const existing = current[idx];
      // Group threads track unread with a per-participant read cursor, which this
      // payload cannot express (it carries no participant rows), so their unread
      // badge is only ever correct when it comes from the server.
      if (existing.conversationType === 'group') return false;
      // Mirror the server's derived unread semantics, which key off the message
      // author's PARTICIPANT TYPE, not merely "not me":
      //   unread_firm   counts messages with sender_type = 'client'
      //   unread_client counts messages with sender_type = 'firm_member'
      // (messaging.repository.js CONV_SELECT). The conversations payload has no
      // sender_type column, but it carries last_sender_user_id and client_id, so
      // we derive it: the last sender is the CLIENT iff their uid is the
      // conversation's client_id; anyone else is a firm member. This means a
      // message authored by ANOTHER firm member never bumps firm unread (and a
      // firm member's own send never does either), matching the server.
      const clientId = row.client_id ?? existing.clientId;
      const lastSender = row.last_sender_user_id;
      const lastSenderIsClient = !!lastSender && !!clientId && lastSender === clientId;
      const lastSenderIsFirm = !!lastSender && !lastSenderIsClient;
      // Don't inflate our own sends as unread for us, regardless of derivation.
      const fromOther = !!lastSender && lastSender !== user.uid;
      const incFirm = fromOther && lastSenderIsClient;   // client -> firm unread
      const incClient = fromOther && lastSenderIsFirm;   // firm   -> client unread
      const updated: Conversation = {
        ...existing,
        lastMessageAt: row.last_message_at ?? existing.lastMessageAt,
        updatedAt: row.updated_at ?? existing.updatedAt,
        unreadCountClient: isClient && incClient
          ? (existing.unreadCountClient || 0) + 1
          : existing.unreadCountClient,
        unreadCountFirm: !isClient && incFirm
          ? (existing.unreadCountFirm || 0) + 1
          : existing.unreadCountFirm,
      };
      const next = [...current];
      next[idx] = updated;
      // Re-sort newest-first by last_message_at to preserve list ordering. This
      // moves the patched row to the top of the page, which is where it belongs: it
      // now genuinely has the firm's most recent activity.
      next.sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      });
      conversationsRef.current = next;
      setConversations(next);
      broadcastUnread();
      // The patch moved the row and bumped its unread badge, which the payload
      // CAN express. It cannot express the preview: the client's name, email,
      // the firm's name and the last-message preview were all columns on this
      // row once and are all derived server-side now, so the payload carries
      // none of them. Fall through to the debounced refetch for the text, which
      // lands a moment after the reorder the user already saw.
      refetch();
      return true;
    };

    const handleConversationEvent = (payload: {
      eventType?: string;
      new?: RawConversationRow;
    }) => {
      const evt = payload?.eventType;
      // INSERT/UPDATE with a patchable existing row -> apply in place.
      if ((evt === 'INSERT' || evt === 'UPDATE') && patchInPlace(payload?.new)) {
        return;
      }
      // Out of the loaded window, DELETE, or incomplete payload -> authoritative
      // refetch of the current window.
      refetch();
    };

    const subscribe = async () => {
      const supabase = await authorizeRealtime();
      if (cancelled || !supabase) return;
      // A resume can reopen while an earlier open is still resolving; keep one.
      if (channel) supabase.removeChannel(channel);

      // RLS limits the rows this JWT can see to the user's own conversations.
      // For firm members we additionally pin the subscription to this firm's
      // `law_firm_id` so a member only wakes for their own firm's conversation
      // changes (not every firm row RLS would otherwise let through). Security
      // is unchanged. RLS still applies on top of the filter. Clients have no
      // single firm scope here (they may belong to several), so they keep the
      // RLS-only table subscription.
      const changeConfig: {
        event: '*';
        schema: 'public';
        table: 'conversations';
        filter?: string;
      } = { event: '*', schema: 'public', table: 'conversations' };
      if (lawFirmId) {
        changeConfig.filter = `law_firm_id=eq.${lawFirmId}`;
      }

      channel = supabase
        .channel(`conversations:${lawFirmId || 'client'}:${user.uid}`)
        .on(
          'postgres_changes',
          changeConfig,
          (payload) => handleConversationEvent(payload as { eventType?: string; new?: RawConversationRow }),
        )
        .subscribe();
    };

    subscribe();

    // The token lapsed while the tab was hidden, so the server closed the
    // channel and changes since went undelivered: reopen it and re-read once.
    const stopResume = onRealtimeResume(() => {
      if (cancelled) return;
      subscribe();
      refetch();
    });

    return () => {
      cancelled = true;
      stopResume();
      refetchNow.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (channel) {
        getRealtimeClient()?.removeChannel(channel);
      }
      releaseRealtime();
    };
  }, [user, lawFirmId, isClient, broadcastUnread]);

  // When the open conversation marks its messages read, zero THAT thread's
  // unread in the list state too. Otherwise the list-row unread (only ever reset
  // by a full refetch) stays stale, and a subsequent patch-in-place would
  // re-inflate the badge of a thread the user is actively reading. For a direct
  // thread we zero the ACTING side's count (client side for clients, firm side for
  // firm members), mirroring which side markAsRead cleared on the server; a group
  // thread has a single per-viewer count, which is the one that clears.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleMarkedRead = (e: Event) => {
      const conversationId = (e as CustomEvent<{ conversationId?: string }>)?.detail?.conversationId;
      if (!conversationId) return;
      const current = conversationsRef.current;
      const idx = current.findIndex(c => c.conversationId === conversationId);
      if (idx === -1) return;
      const existing = current[idx];
      const isGroup = existing.conversationType === 'group';
      const alreadyZero = isGroup
        ? (existing.unreadCount || 0) === 0
        : isClient
          ? (existing.unreadCountClient || 0) === 0
          : (existing.unreadCountFirm || 0) === 0;
      if (alreadyZero) return;
      const next = [...current];
      next[idx] = isGroup
        ? { ...existing, unreadCount: 0 }
        : isClient
          ? { ...existing, unreadCountClient: 0 }
          : { ...existing, unreadCountFirm: 0 };
      conversationsRef.current = next;
      setConversations(next);
      broadcastUnread();
    };

    window.addEventListener('messages-marked-read', handleMarkedRead);
    return () => window.removeEventListener('messages-marked-read', handleMarkedRead);
  }, [isClient, broadcastUnread]);

  const refresh = useCallback(async () => {
    try {
      setFetching(true);
      // Clear a previous load failure before retrying. Without this, a
      // successful refresh (whether from the retry banner or from an action
      // like archiving) leaves the old error banner on screen forever, since
      // nothing else ever clears it once set.
      setError(null);
      const page = await fetchPage();
      setConversations(page.conversations);
      setTotalItems(page.totalItems);
      broadcastUnread();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to refresh'));
    } finally {
      setFetching(false);
    }
  }, [fetchPage, broadcastUnread]);

  return {
    conversations,
    // Every conversation matching the current filters, not just the loaded ones.
    totalItems,
    // True only until the first list for this identity lands, so it can gate a
    // full-page spinner.
    loading,
    // True while any read is in flight, including a page change or a new search.
    fetching,
    error,
    refresh,
    setError,
  };
}
