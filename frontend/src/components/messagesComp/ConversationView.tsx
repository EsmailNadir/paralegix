"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Users, Briefcase, Mail, ChevronLeft, ChevronRight } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import { useNavigation } from '@/contexts/NavigationContext';
import useHorizontalOverflow from '@/hooks/useHorizontalOverflow';
import { useConversationMessages } from '@/hooks/useConversationMessages';
import { useSendMessage } from '@/hooks/useSendMessage';
import { usePermissions } from '@/contexts/PermissionsContext';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import messagesService from '@/services/messages.service';
import clientPortalService from '@/services/client-portal.service';
import GroupParticipantsModal from './GroupParticipantsModal';
import MessagingSettingsMenu from './MessagingSettingsMenu';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import FilePreviewModal, { type PreviewableFile } from '@/components/filesComp/FilePreviewModal';
import FilesService from '@/services/files.service';
import { Avatar } from '@/components/ui/Avatar';
import type { Message, MessageAttachment } from '@/types';
import { getInitials } from '@/lib/utils/format';

// A message attachment, in the shape the preview takes. Conversation
// attachments are not part of the browsable file tree and have no row of their
// own, so the url the message carries is the only way to open one.
function attachmentToPreview(att: MessageAttachment): PreviewableFile {
  return {
    name: att.name,
    size: att.size,
    contentType: att.mimeType,
    signedUrl: att.url,
  };
}

interface ConversationViewProps {
  conversationId: string;
  lawFirmId: string;
  clientId: string;
  currentUserId: string;
  isClient: boolean;
  isGroup?: boolean;
  recipientName?: string; // Recommended prop to add for the header
  // Fired when adding a participant converts this direct thread into a group, so
  // the page can reload the view in group mode (the thread keeps its id).
  onConvertedToGroup?: () => void;
  // Fired when the first message to a client with no thread yet creates the
  // conversation, with its real id, so the page can point its url at it. The
  // view has already switched to that id itself.
  onConversationCreated?: (conversationId: string) => void;
}

export default function ConversationView({
  conversationId,
  lawFirmId,
  clientId,
  currentUserId,
  isClient,
  isGroup = false,
  recipientName: recipientNameProp,
  onConvertedToGroup,
  onConversationCreated,
}: ConversationViewProps) {
  // A brand-new direct thread opens on the synthetic `${lawFirmId}_${clientId}`
  // key, which the backend never resolves. Its first send answers with the real
  // conversation id, and from then on the view reads and subscribes to that id.
  // The pair stays in force whether the page keeps passing the synthetic key or
  // moves its url to the real id; any other id is a different thread.
  const [createdThread, setCreatedThread] = useState<{ from: string; to: string } | null>(null);
  const createdHere = createdThread && (conversationId === createdThread.from || conversationId === createdThread.to)
    ? createdThread
    : null;
  const liveConversationId = createdHere ? createdHere.to : conversationId;
  // Identifies the thread the viewer is in, unchanged when a new thread gains
  // its real id, so that moment keeps the composer, the pending bubble and the
  // scroll position instead of treating it as a switch.
  const threadKey = createdHere ? createdHere.from : conversationId;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  const queryClient = useQueryClient();

  const { messages, conversation, participants, removedParticipantIds, removedClientRecordIds, pendingClients, loading, loadingMore, hasMore, loadMore, error, setError, refresh } = useConversationMessages(liveConversationId, lawFirmId, isClient, isGroup);
  const { hasPermission } = usePermissions();
  const { navigate } = useNavigation();
  const [showParticipants, setShowParticipants] = useState(false);
  // Drives the arrows and edge fades on the linked-matter strip below the header.
  const matterStrip = useHorizontalOverflow<HTMLDivElement>();
  // Attachment opened in the in-app preview modal (image/PDF/doc/…).
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  // Firm members with send permission manage participants (add and remove people),
  // matter scope, and per-conversation privacy; clients cannot. This works on
  // direct threads too: adding or removing anyone converts the 1:1 to a group in
  // place (the only way to enforce who is in the conversation).
  const canManageParticipants = !isClient && hasPermission('messaging.send');
  // Adding a colleague rides on messaging.send above; adding a CLIENT lets someone
  // outside the firm into the correspondence, so it carries its own permission.
  const canAddClientsToThread = !isClient && hasPermission('messaging.manageParticipants');
  // A brand-new direct thread (started from the client selector) has no real
  // conversation row yet - its id is the synthetic `${lawFirmId}_${clientId}` key.
  // There's nothing to add people to until the first message creates it.
  const isNewDirect = !isGroup && liveConversationId.startsWith(`${lawFirmId}_`);
  // Show the participants line + roster on every group (both sides) and on
  // firm-side direct threads once they exist. A client viewing a direct thread
  // sees the firm as one entity, so no roster there.
  const showRoster = isGroup || (!isClient && !isNewDirect && participants.length > 0);
  // The header settings gear shows on every thread a firm member can send in: it
  // always offers the personal "send as firm" identity, plus (groups only) matter
  // scope and hide-client-names. Clients have no conversation settings.
  const showSettingsGear = !isClient && hasPermission('messaging.send');

  // Group header title. Clients never see the individual lawyers on a thread · 
  // the firm is presented as a single entity · so a client's untitled group is
  // named after the firm, not a roster of member first names. Firm members still
  // get the member-first-names roster when there's no explicit title.
  const groupTitle = isGroup
    ? (conversation?.title
        || (isClient
              ? (conversation?.lawFirmName || 'Group conversation')
              : participants
                  .filter((p) => p.userId !== currentUserId)
                  .map((p) => (p.name || p.email).split(' ')[0])
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(', '))
        || 'Group conversation')
    : '';
  const recipientName = isGroup
    ? groupTitle
    : (recipientNameProp || (isClient ? (conversation?.lawFirmName || 'Law Firm') : (conversation?.clientName || 'Client')));
  // For existing conversations the id is a Postgres UUID, so clientId isn't in
  // the url. Recover it from the loaded conversation. New conversations pass it
  // in via the prop (the conversation row doesn't exist yet).
  const effectiveClientId = clientId || conversation?.clientId || '';
  const { sendMessage } = useSendMessage();
  const errorRef = useRef<HTMLDivElement>(null);
  const [deliveryNotice, setDeliveryNotice] = useState('');
  const [newMessageCount, setNewMessageCount] = useState(0);
  const announcementHistory = useRef<{ thread: string; ids: Set<string>; latest: number; initialized: boolean }>({ thread: '', ids: new Set(), latest: 0, initialized: false });

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const history = announcementHistory.current;
    if (history.thread !== threadKey) {
      history.thread = threadKey;
      history.ids = new Set();
      history.latest = 0;
      history.initialized = false;
      setNewMessageCount(0);
      setDeliveryNotice('');
      return;
    }
    if (loading) return;
    let incoming = 0;
    for (const message of messages) {
      const created = new Date(message.createdAt).getTime();
      if (history.initialized && !history.ids.has(message.messageId) && created >= history.latest && message.senderId !== currentUserId && !message.deleted && message.kind !== 'system') incoming += 1;
    }
    for (const message of messages) {
      history.ids.add(message.messageId);
      history.latest = Math.max(history.latest, new Date(message.createdAt).getTime() || 0);
    }
    history.initialized = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the announcement count with newly received message rows
    if (incoming) setNewMessageCount(count => count + incoming);
  }, [messages, loading, threadKey, currentUserId]);

  // Optimistic messages shown immediately after send, cleared once the
  // server-confirmed message (correlated by its real messageId) shows up in the
  // hook's messages. See the cleanup effect below.
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  // Maps each optimistic temp id -> the server messageId returned by sendMessage,
  // so we can drop the optimistic copy deterministically (by id) the moment its
  // real row arrives via Realtime, instead of guessing with a timestamp window.
  const tempToServerIdRef = useRef<Map<string, string>>(new Map());
  // Pending bubbles belong to the thread they were sent in. The page can switch
  // thread under a view that stays mounted, so they are dropped on the switch
  // (adjusted during render, so the next thread never paints with them).
  const [localThread, setLocalThread] = useState(threadKey);
  if (localThread !== threadKey) {
    setLocalThread(threadKey);
    setLocalMessages([]);
  }
  useEffect(() => {
    tempToServerIdRef.current = new Map();
  }, [threadKey]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesInnerRef = useRef<HTMLDivElement>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  // Keep the message list hidden until it's positioned at the bottom, so the
  // user never sees it sitting at the top and then scrolling.
  const [positioned, setPositioned] = useState(false);
  const needsInitialScrollRef = useRef(false);
  // Whether the viewport is currently pinned to the bottom of the thread. Updated
  // on every scroll so that when content grows AFTER positioning (most commonly an
  // image finishing loading and expanding to its real height), we keep the newest
  // message in view instead of stranding the reader mid-image, without yanking a
  // user who has deliberately scrolled up to read history.
  const atBottomRef = useRef(true);
  // Set when a history load is started, holding the scroll geometry from just
  // before it. Older messages are prepended ABOVE the viewport, so without
  // restoring against these the reader is pushed down by the height of the batch
  // they just asked for. (The browser's own scroll anchoring can't be relied on:
  // it is suppressed at scrollTop 0, which is exactly where the auto-load fires.)
  const historyAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const previousConversationIdRef = useRef<string | null>(null);
  const previousLastMessageIdRef = useRef<string | null>(null);
  // The first message received from the other party that was still unread when
  // the conversation opened. A "New" divider is drawn just above it, and the
  // view opens scrolled to it. Frozen on open so the auto-mark-as-read flip
  // (which clears the unread flags moments later) doesn't make the divider
  // disappear or move out from under the reader.
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);
  const firstUnreadComputedRef = useRef(false);
  // Points at the first-unread message's row so we can scroll the "New" divider
  // (rendered just above it) to the top of the viewport on open.
  const firstUnreadAnchorRef = useRef<HTMLDivElement>(null);

  // Merge hook messages with local optimistic messages, deduplicating by messageId
  const allMessages = useMemo(() => {
    const hookIds = new Set(messages.map(m => m.messageId));
    const pending = localMessages.filter(lm => !hookIds.has(lm.messageId));
    return [...messages, ...pending];
  }, [messages, localMessages]);

  const participantById = useMemo(() => {
    const map = new Map<string, (typeof participants)[number]>();
    participants.forEach((p) => map.set(p.userId, p));
    return map;
  }, [participants]);

  // The client participants of this conversation, used by the matter picker to
  // flag matters that don't include them and to offer adding them to a matter.
  const groupClients = useMemo(
    () => participants
      .filter((p) => p.type === 'client')
      .map((p) => ({ userId: p.userId, name: p.name, email: p.email })),
    [participants]
  );

  // Roster shown to a CLIENT viewer: the firm side is collapsed into a single
  // "Law Firm" entry so a client never sees which individual lawyers are on the
  // thread - the roster surfaces (header count, avatar cluster, participants
  // dialog) show the firm as one participant. Firm members see the real roster.
  // Message sender names are unaffected (they still follow each member's "send as
  // firm" preference); this only governs the who's-in-this-thread lists.
  const rosterParticipants = useMemo(() => {
    if (!isClient) return participants;
    const clients = participants.filter((p) => p.type === 'client');
    const hasFirm = participants.some((p) => p.type !== 'client');
    if (!hasFirm) return clients;
    const firmEntry: (typeof participants)[number] = {
      userId: '__firm__',
      type: 'firm_member',
      name: conversation?.lawFirmName || 'Law Firm',
      email: '',
      photoUrl: conversation?.lawFirmLogoUrl ?? null,
    };
    return [...clients, firmEntry];
  }, [participants, isClient, conversation?.lawFirmName, conversation?.lawFirmLogoUrl]);

  // For group threads, resolve each sender's displayed name/avatar from the
  // (server-side privacy-masked) participants list. This makes realtime-delivered
  // messages honor the firm's client-name masking too: the raw Realtime payload
  // still carries the real sender_name, but we render the masked participant name
  // instead. Falls back to "Client" for a masked sender who has since left.
  const displayMessages = useMemo(() => {
    const firmName = conversation?.lawFirmName || 'Law Firm';
    // Direct (1:1) threads: only firm-identity masking applies, and only for a
    // client viewer. REST loads arrive already masked; this catches live rows
    // (which carry the raw sender_name) so a "send as firm" message shows the firm.
    if (!isGroup) {
      if (!isClient) return allMessages;
      return allMessages.map((m) =>
        m.sentAsFirm && m.senderType === 'firm_member'
          ? { ...m, senderName: firmName }
          : m
      );
    }
    const masked = !!conversation?.clientNamesMasked;
    return allMessages.map((m) => {
      if (m.senderId === currentUserId) return m;
      // A firm member who sent under the firm identity keeps the server-provided
      // firm name/logo for client viewers - do NOT remap to their real
      // participant name (which the client can still see for normal messages).
      if (isClient && m.sentAsFirm && m.senderType === 'firm_member') return m;
      const p = participantById.get(m.senderId);
      if (p) return { ...m, senderName: p.name || p.email || m.senderName, senderPhotoUrl: p.photoUrl ?? null };
      if (masked && m.senderType === 'client') return { ...m, senderName: 'Client', senderPhotoUrl: null };
      return m;
    });
  }, [allMessages, isGroup, isClient, participantById, conversation?.clientNamesMasked, conversation?.lawFirmName, currentUserId]);

  // Clear each optimistic message once its server-confirmed counterpart arrives
  // in the hook's messages (delivered via the Supabase Realtime subscription or
  // a refetch). Correlation is by the real messageId returned from sendMessage,
  // deterministic, so there's no momentary double-render from a timestamp window.
  useEffect(() => {
    if (localMessages.length === 0) return;
    const hookIds = new Set(messages.map(m => m.messageId));
    const map = tempToServerIdRef.current;
    const remaining = localMessages.filter(lm => {
      const serverId = map.get(lm.messageId);
      // Keep the optimistic copy until we know its server id AND that id is
      // present in the hook's messages. Pending sends (no server id yet) stay.
      const confirmed = serverId != null && hookIds.has(serverId);
      if (confirmed) map.delete(lm.messageId);
      return !confirmed;
    });
    if (remaining.length !== localMessages.length) {
      setLocalMessages(remaining);
    }
  }, [messages, localMessages]);

  const toValidDate = (value: Date | string) => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior });
    }
  };

  // Within this distance (px) of the bottom counts as "at the bottom" for the
  // purpose of following newly appended / newly grown content.
  const AT_BOTTOM_THRESHOLD = 120;

  const isNearBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_THRESHOLD;
  };

  // Scrolling within this distance (px) of the top pulls in the next batch of
  // history. Kept above zero so the batch is already on its way by the time the
  // reader reaches the oldest loaded message.
  const LOAD_HISTORY_THRESHOLD = 250;

  /**
   * Start loading the next batch of older messages, remembering where the view
   * sits so it can be restored once they render. No-op when there is nothing more
   * to load or a batch is already in flight.
   *
   * `auto` marks the scroll-triggered call, which additionally waits for the
   * thread to settle where it opened: opening parks the "New" divider at the top
   * of the viewport, which would otherwise read as the reader having scrolled up
   * to the oldest loaded message. An explicit click carries no such ambiguity.
   */
  const loadOlderMessages = ({ auto = false } = {}) => {
    const container = messagesContainerRef.current;
    if (!container || !hasMore || loadingMore || historyAnchorRef.current) return;
    if (auto && (!positioned || needsInitialScrollRef.current)) return;
    historyAnchorRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
    loadMore();
  };

  // Record the user's bottom-anchored state on every scroll. Read later by the
  // ResizeObserver so it only re-pins the view for users who were already at the
  // bottom before the content grew. Scrolling up to the top edge also pulls in
  // older messages, so history arrives by scrolling rather than only by clicking.
  const handleScroll = () => {
    atBottomRef.current = isNearBottom();
    const container = messagesContainerRef.current;
    if (container && container.scrollTop < LOAD_HISTORY_THRESHOLD) loadOlderMessages({ auto: true });
  };

  // Open the conversation scrolled so the "New" divider (just above the first
  // unread message) sits near the top of the viewport, so a fresh batch of
  // unread messages is read from its start. Falls back to the bottom when
  // nothing is unread. The browser clamps scrollTop to its max, so a short
  // unread block that fits in the viewport still ends up showing the bottom.
  const scrollToAnchor = (behavior: ScrollBehavior) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const target = firstUnreadAnchorRef.current;
    if (!target) {
      scrollToBottom(behavior);
      return;
    }
    // Distance to move so the target's top sits at the container's top, minus a
    // little breathing room so the divider isn't glued to the very edge.
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = Math.max(0, container.scrollTop + delta - 16);
    if (behavior === 'auto') {
      container.scrollTop = top;
    } else {
      container.scrollTo({ top, behavior });
    }
  };

  // Helper: Date Logic
  const isSameDay = (d1: Date, d2: Date) => {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  };

  const formatDateLabel = (date: Date) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (isSameDay(date, today)) return 'Today';
    if (isSameDay(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  };

  useEffect(() => {
    if (previousConversationIdRef.current !== threadKey) {
      previousConversationIdRef.current = threadKey;
      previousLastMessageIdRef.current = null;
      firstUnreadComputedRef.current = false;
      setFirstUnreadId(null);
      setInitialLoadComplete(false);
      setPositioned(false);
      needsInitialScrollRef.current = false;
    }
  }, [threadKey]);

  // ResizeObserver: re-run the initial positioning whenever content height grows
  // during the initial-load window. Catches late-rendering elements like date
  // dividers and sign-document cards so the anchor stays put as they appear.
  //
  // Installed from a callback ref rather than a mount effect: the list is not in
  // the DOM on mount (a spinner renders until the first page arrives), so an
  // effect with no dependencies found no node and never ran again.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const attachMessagesInner = useCallback((node: HTMLDivElement | null) => {
    messagesInnerRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (needsInitialScrollRef.current) {
        scrollToAnchor('auto');
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToAnchor only reads refs, so the instance captured here stays correct
  }, []);

  // Put the reader back where they were once a batch of history has rendered:
  // the list grew upwards, so the content they were looking at moved down by
  // exactly the height that was added. Runs before paint, so the jump is never
  // visible. Guarded on the batch having actually landed (`!loadingMore`) so a
  // re-render mid-flight doesn't consume the anchor early.
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const container = messagesContainerRef.current;
    if (!anchor || !container || loadingMore) return;
    historyAnchorRef.current = null;
    const grownBy = container.scrollHeight - anchor.scrollHeight;
    if (grownBy > 0) container.scrollTop = anchor.scrollTop + grownBy;
  }, [allMessages, loadingMore]);

  // Inline images have no reserved height until they decode, so they expand the
  // thread AFTER the initial scroll has run, otherwise stranding the reader in the
  // middle of a picture. When one finishes loading, re-assert the scroll position:
  // re-anchor during the initial-load window, or keep the newest message in view
  // if the user was already at the bottom. A user who has scrolled up to read
  // history (not at the bottom) is left undisturbed.
  const handleAttachmentLoad = () => {
    if (needsInitialScrollRef.current) {
      scrollToAnchor('auto');
    } else if (atBottomRef.current) {
      scrollToBottom('auto');
    }
  };

  // Initial positioning, pass 1: freeze where the "New" divider sits, the first
  // still-unread message from the other party in the initially-loaded batch,
  // and mark the data loaded. Computed once, before the auto-mark-as-read
  // round-trip flips the flags. We don't scroll or reveal yet: the divider and
  // its anchor aren't in the DOM until the re-render this triggers. Pass 2 does
  // the actual positioning.
  useLayoutEffect(() => {
    if (loading || allMessages.length === 0 || initialLoadComplete) return;

    if (!firstUnreadComputedRef.current) {
      firstUnreadComputedRef.current = true;
      const firstUnread = allMessages.find(m => m.senderId !== currentUserId && !m.read && m.kind !== 'system');
      setFirstUnreadId(firstUnread ? firstUnread.messageId : null);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time gate to release pass 2 once the divider/anchor are renderable
    setInitialLoadComplete(true);
  }, [allMessages, loading, initialLoadComplete, currentUserId]);

  // Initial positioning, pass 2: now that the "New" divider and its anchor are
  // rendered, scroll the divider to the top of the viewport (or the bottom when
  // nothing's unread) BEFORE the browser paints, then reveal the list. Runs once
  // per conversation; the list stays hidden (invisible) until it's positioned.
  useLayoutEffect(() => {
    if (!initialLoadComplete || positioned || allMessages.length === 0) return;

    needsInitialScrollRef.current = true;
    scrollToAnchor('auto');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal the now-positioned list
    setPositioned(true);
    previousLastMessageIdRef.current = allMessages[allMessages.length - 1]?.messageId ?? null;
    // Keep correcting (instantly, no animation) for ~1s as late content renders.
    setTimeout(() => { needsInitialScrollRef.current = false; }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per conversation (gated by `positioned`); scrollToAnchor only reads refs, so it needs no dependency entry
  }, [initialLoadComplete, positioned, allMessages]);

  // Scroll to the newest message as it arrives (our own sends or live messages).
  useEffect(() => {
    if (loading || allMessages.length === 0 || !initialLoadComplete) return;

    const lastMessageId = allMessages[allMessages.length - 1]?.messageId ?? null;
    if (lastMessageId && previousLastMessageIdRef.current !== lastMessageId) {
      scrollToBottom('smooth');
    }
    previousLastMessageIdRef.current = lastMessageId;
  }, [allMessages, loading, initialLoadComplete]);

  // Edit / soft-delete one of the viewer's OWN messages. The change propagates to
  // every open viewer over Realtime (postgres_changes for direct threads, the
  // group broadcast ping for groups), the same way a send does, so no manual
  // refetch is needed here. Errors are surfaced and re-thrown so the bubble keeps
  // its editor / confirm dialog open for a retry.
  const handleEditMessage = async (messageId: string, content: string) => {
    if (isClient) await clientPortalService.editMessage(messageId, content);
    else await messagesService.editMessage(lawFirmId, messageId, content);
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (isClient) await clientPortalService.deleteMessage(messageId);
    else await messagesService.deleteMessage(lawFirmId, messageId);
  };

  // Resolves true once the server has the message and false when the send
  // failed (the error is already shown), so the composer can hand the draft back.
  const handleSend = async (content: string, attachments: MessageAttachment[], mentions: string[] = []): Promise<boolean> => {
    setError(null);
    setDeliveryNotice('Sending message...');
    const isNewConversation = allMessages.length === 0;
    const sentFromThread = threadKey;
    const sentFromNewDirect = isNewDirect && !isClient;
    let tempId: string | null = null;
    try {
      const result = await sendMessage({
        lawFirmId,
        clientId: effectiveClientId,
        content,
        attachments,
        mentions,
        isClient: isClient,
        isGroup,
        conversationId: liveConversationId,
        onSuccess: (optimisticMsg) => {
          // Show the message immediately before the server / Realtime event
          // confirms it. Remember its temp id so we can correlate the real id.
          tempId = optimisticMsg.messageId;
          setLocalMessages(prev => [...prev, optimisticMsg]);
          requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom('smooth')));
        },
        onError: (err) => console.error('Send error:', err),
      });
      // The viewer left this thread while the send was out: its bubble went
      // with it, and nothing here may touch the thread now showing.
      if (threadKeyRef.current !== sentFromThread) return true;
      // Record the optimistic temp id -> server messageId mapping so the cleanup
      // effect can drop the optimistic copy the instant the real row arrives.
      if (tempId && result?.messageId) {
        tempToServerIdRef.current.set(tempId, result.messageId);
      }
      const createdId = (result as { conversationId?: string } | undefined)?.conversationId;
      if (sentFromNewDirect && createdId && createdId !== liveConversationId) {
        // The send created the thread: read and subscribe to its real id, and
        // let the inbox list pick the new row up.
        setCreatedThread({ from: sentFromThread, to: createdId });
        queryClient.invalidateQueries({ queryKey: ['firmConversations', lawFirmId] });
        onConversationCreated?.(createdId);
      } else if (isNewConversation) {
        // Re-initialize for new conversations to open the Realtime subscription.
        refresh();
      }
      setDeliveryNotice('Message sent.');
      return true;
    } catch (err) {
      // Remove only the failed optimistic message, preserving other queued sends.
      if (tempId) {
        const failedId = tempId;
        tempToServerIdRef.current.delete(failedId);
        setLocalMessages(prev => prev.filter(message => message.messageId !== failedId));
      }
      console.error('Failed to send:', err);
      if (threadKeyRef.current !== sentFromThread) return false;
      setDeliveryNotice('');
      setError(getErrorMessage(err, 'Failed to send message'));
      return false;
    }
  };

  if (loading && allMessages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-messages-area">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface relative">
      {/* 1. Professional Header */}
      <div className="flex items-center justify-between px-4 md:px-6 py-3 bg-surface border-b border-outline-subtle shadow-sm z-10 shrink-0 h-16">
        <div className="flex items-center gap-3 min-w-0">
          {isGroup ? (
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shadow-sm shrink-0">
              <Users size={18} />
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-on-surface text-surface flex items-center justify-center text-sm font-medium shadow-sm shrink-0">
              {getInitials(recipientName)}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-on-surface truncate">{recipientName}</h2>
            {showRoster && (
              <button
                type="button"
                onClick={() => setShowParticipants(true)}
                className="text-xs text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis hover:underline truncate cursor-pointer text-left"
              >
                {rosterParticipants.length} participant{rosterParticipants.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>
        {(showRoster || showSettingsGear) && (
          <div className="flex items-center gap-3 shrink-0">
            {showRoster && (
              // Compact avatar cluster of the thread's participants; opens the
              // participants dialog, same as the header count.
              <button
                type="button"
                onClick={() => setShowParticipants(true)}
                aria-label="View participants"
                className="hidden sm:flex -space-x-2 cursor-pointer"
              >
                {rosterParticipants.slice(0, 4).map((p) => (
                  <Avatar
                    key={p.userId}
                    size="sm"
                    name={p.name}
                    email={p.email}
                    photoUrl={p.photoUrl}
                    // The collapsed firm entry (client viewers) uses the firm's
                    // logo/wordmark, which must be letterboxed, not cropped in half.
                    fit={p.userId === '__firm__' ? 'contain' : 'cover'}
                    className="ring-2 ring-surface"
                  />
                ))}
                {rosterParticipants.length > 4 && (
                  <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-surface-alt text-on-surface-secondary text-xs font-medium ring-2 ring-surface">
                    +{rosterParticipants.length - 4}
                  </span>
                )}
              </button>
            )}
            {showSettingsGear && (
              <MessagingSettingsMenu
                lawFirmId={lawFirmId}
                conversationId={liveConversationId}
                isGroup={isGroup}
                matterIds={conversation?.matterIds || []}
                groupClients={groupClients}
                hideClientNames={!!conversation?.hideClientNames}
                onChanged={refresh}
              />
            )}
          </div>
        )}
      </div>

      {/* Linked matter(s): a slim strip under the header showing which matter(s)
          this thread is scoped to. Firm members get click-through to the matter;
          clients see a read-only label (their matter route differs and a client
          may not have access to every linked matter). */}
      {isGroup && (conversation?.matters?.length ?? 0) > 0 && (
        <div className="flex items-center gap-2 px-4 md:px-6 py-1.5 bg-surface border-b border-outline-subtle shrink-0">
          <Briefcase size={13} className="text-on-surface-muted shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted shrink-0">
            {(conversation!.matters!.length) > 1 ? 'Matters' : 'Matter'}
          </span>
          {/* Chips keep their natural width and the row scrolls once they stop
              fitting, rather than every chip shrinking toward its matter number.
              The margin is a gutter on top of the strip's own padding, so the
              last chip clips well inside the pane instead of running up to the
              same edge the header's avatar cluster sits on - it's a margin and
              not padding because trailing padding on a flex scroll container is
              dropped at the scroll end in some browsers. The scrollbar is hidden
              (as on every other horizontal strip here) so it can't add height to
              a 28px row and knock the chips out of line with the label; the
              arrows below are what makes the hidden overflow reachable. */}
          <div className="relative min-w-0 flex-1 mr-4 md:mr-8">
            {matterStrip.overflow.left && (
              <>
                <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-surface to-transparent" />
                <button
                  type="button"
                  onClick={() => matterStrip.scrollStep(-1)}
                  aria-label="Scroll matters left"
                  className="absolute inset-y-0 left-0 z-20 flex items-center text-on-surface-muted hover:text-on-surface cursor-pointer"
                >
                  <ChevronLeft size={14} />
                </button>
              </>
            )}
            <div
              ref={matterStrip.ref}
              onWheel={matterStrip.onWheel}
              className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide"
            >
            {conversation!.matters!.map((m) => {
              const label = m.matterNumber ? `${m.matterNumber} · ${m.name}` : m.name;
              // 360px fits a typical "number · name" whole while keeping a long
              // name from stretching across the pane; on a narrow pane the chip
              // is capped by the strip instead. Chips keep that width and the
              // row scrolls once several stop fitting. Within a chip only the
              // name clips - the number identifies the matter, so it never
              // shrinks.
              const base =
                'inline-flex items-center gap-1 shrink-0 max-w-[min(360px,100%)] overflow-hidden px-2 py-0.5 rounded-full text-xs bg-surface-hover text-on-surface-secondary border border-outline-subtle';
              const inner = (
                <>
                  {m.matterNumber && <span className="shrink-0 font-medium">{m.matterNumber}</span>}
                  {m.matterNumber && m.name && <span className="shrink-0 text-on-surface-muted">·</span>}
                  {m.name && <span className="truncate">{m.name}</span>}
                </>
              );
              return (
                <Tooltip key={m.id} title={label} enterDelay={300}>
                  {isClient ? (
                    <span className={base}>{inner}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${m.id}`)}
                      className={`${base} hover:text-accent-emphasis dark:hover:text-accent-emphasis hover:border-accent-border-soft transition-[color,border-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer`}
                    >
                      {inner}
                    </button>
                  )}
                </Tooltip>
              );
            })}
            </div>
            {matterStrip.overflow.right && (
              <>
                <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-surface to-transparent" />
                <button
                  type="button"
                  onClick={() => matterStrip.scrollStep(1)}
                  aria-label="Scroll matters right"
                  className="absolute inset-y-0 right-0 z-20 flex items-center text-on-surface-muted hover:text-on-surface cursor-pointer"
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showRoster && (
        <GroupParticipantsModal
          open={showParticipants}
          onClose={() => setShowParticipants(false)}
          lawFirmId={lawFirmId}
          conversationId={liveConversationId}
          participants={rosterParticipants}
          canManage={canManageParticipants}
          canAddClients={canAddClientsToThread}
          currentUserId={currentUserId}
          removedParticipantIds={removedParticipantIds}
          removedClientRecordIds={removedClientRecordIds}
          pendingClients={pendingClients}
          isGroupThread={isGroup}
          groupHasMatter={(conversation?.matterIds?.length ?? 0) > 0}
          onChanged={refresh}
          onConverted={() => {
            setShowParticipants(false);
            onConvertedToGroup?.();
          }}
        />
      )}

      <FilePreviewModal
        file={previewFile}
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        onDownload={() => {
          if (previewFile?.signedUrl) {
            FilesService.downloadFile(previewFile.signedUrl, previewFile.name);
          }
        }}
      />

      <div ref={errorRef} tabIndex={-1}>
        <ErrorNotification error={error} onClose={() => {
          setError(null);
          messagesContainerRef.current?.parentElement?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        }} onRetry={refresh} />
      </div>
      <div role="status" aria-label="New messages" className="sr-only">
        {newMessageCount > 0 ? `${newMessageCount} new ${newMessageCount === 1 ? 'message' : 'messages'} in this conversation.` : ''}
      </div>
      <div role="status" aria-label="Message delivery" className="sr-only">{deliveryNotice}</div>

      {/* 2. Messages Container */}
      <div
        ref={messagesContainerRef}
        role="region"
        aria-label="Conversation messages"
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 md:px-4 md:py-6 bg-messages-area styled-scrollbar"
      >
        <div
          ref={attachMessagesInner}
          // Hidden until positioned at the bottom (anti-scroll-jump on open). Uses
          // opacity, NOT `invisible`: visibility inherits, and each message wrapper's
          // `transition-all` would transition that inherited visibility and get stuck
          // hidden when the container reveals. Opacity doesn't inherit, so it can't.
          className={`max-w-3xl mx-auto flex flex-col ${positioned || allMessages.length === 0 ? '' : 'opacity-0'}`}
        >
          
          {/* Load More Trigger. Scrolling near the top pulls history in on its
              own; this stays as the affordance for a thread whose loaded batch
              doesn't fill the viewport, where there is no scrolling to do. */}
          {hasMore && (
            <div className="flex justify-center mb-6">
              <button
                onClick={() => loadOlderMessages()}
                disabled={loadingMore}
                className="px-4 py-1.5 text-xs font-medium text-on-surface-secondary bg-surface border border-outline-subtle rounded-full shadow-sm hover:bg-surface-hover hover:text-on-surface transition active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50"
              >
                {loadingMore ? 'Loading history...' : 'Load older messages'}
              </button>
            </div>
          )}

          {/* Empty State */}
          {allMessages.length === 0 && !loading && (
            <div className="text-center py-20">
              <div className="w-16 h-16 bg-surface-hover rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-on-surface-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-on-surface-secondary text-sm">This is the start of your conversation.</p>
            </div>
          )}

          {/* Messages Loop */}
          {displayMessages.map((message, index) => {
            const isOwn = message.senderId === currentUserId;
            const prevMessage = index > 0 ? displayMessages[index - 1] : null;
            const nextMessage = index < displayMessages.length - 1 ? displayMessages[index + 1] : null;
            const currentDate = toValidDate(message.createdAt);
            const previousDate = prevMessage ? toValidDate(prevMessage.createdAt) : null;
            const nextDate = nextMessage ? toValidDate(nextMessage.createdAt) : null;

            // Date Divider Logic
            const showDateDivider =
              !prevMessage
              || !currentDate
              || !previousDate
              || !isSameDay(currentDate, previousDate);

            // Inline participant add/remove events render as a centered activity
            // line, not a chat bubble. The date divider still applies so they sit
            // under the right day. Text comes from systemEvent (masked/filtered
            // server-side), falling back to the stored content string.
            if (message.kind === 'system') {
              const ev = message.systemEvent;
              const label = ev
                ? `${ev.subjectName || 'Someone'} ${
                    ev.action === 'participant_removed' ? 'was removed from' : 'was added to'
                  } the conversation`
                : message.content;
              return (
                <div key={message.messageId} className="min-w-0">
                  {showDateDivider && (
                    <div className="flex items-center justify-center my-6">
                      <span className="px-3 py-1 text-xs font-medium text-on-surface-muted bg-surface-hover rounded-full">
                        {currentDate ? formatDateLabel(currentDate) : 'Recent'}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-center my-3">
                    <span className="px-3 py-1 max-w-[85%] text-center text-[11px] text-on-surface-muted bg-surface-hover rounded-full">
                      {label}
                    </span>
                  </div>
                </div>
              );
            }

            const showNewDivider = message.messageId === firstUnreadId;

            // Consecutive messages from one sender are bunched into a visual
            // group: the name + avatar render once at the top, the timestamp once
            // at the bottom, and the bubbles stack tightly. A group is broken only
            // by a sender change or a date divider - NOT by a time gap.
            const sameSenderAsPrev = !!prevMessage && prevMessage.senderId === message.senderId;
            const nextStartsNewDay =
              !!nextMessage && (!currentDate || !nextDate || !isSameDay(currentDate, nextDate));
            const isFirstInGroup = !sameSenderAsPrev || showDateDivider;
            const isLastInGroup =
              !nextMessage
              || nextMessage.senderId !== message.senderId
              || nextStartsNewDay;

            // A long pause between two same-sender messages adds breathing room
            // between the bubbles, but never a repeated name/avatar or a timestamp.
            const GROUP_GAP_MS = 10 * 60 * 1000;
            const pauseToNext = !!(
              nextMessage
              && nextMessage.senderId === message.senderId
              && !nextStartsNewDay
              && currentDate
              && nextDate
              && nextDate.getTime() - currentDate.getTime() > GROUP_GAP_MS
            );
            const bottomMargin = isLastInGroup ? 'mb-4' : pauseToNext ? 'mb-3' : 'mb-0.5';

            return (
              <div
                key={message.messageId}
                ref={message.messageId === firstUnreadId ? firstUnreadAnchorRef : undefined}
                className="min-w-0"
              >
                {/* Date Divider */}
                {showDateDivider && (
                  <div className="flex items-center justify-center my-6">
                    <span className="px-3 py-1 text-xs font-medium text-on-surface-muted bg-surface-hover rounded-full">
                      {currentDate ? formatDateLabel(currentDate) : 'Recent'}
                    </span>
                  </div>
                )}

                {/* New (unread) Divider */}
                {showNewDivider && (
                  <div className="flex items-center gap-3 my-4 select-none">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-rose-400/40 to-rose-500/70 dark:via-rose-500/40 dark:to-rose-400/70" />
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-600 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 rounded-full ring-1 ring-rose-200/70 dark:ring-rose-500/25 shadow-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400" />
                      New
                    </span>
                    <div className="h-px flex-1 bg-gradient-to-l from-transparent via-rose-400/40 to-rose-500/70 dark:via-rose-500/40 dark:to-rose-400/70" />
                  </div>
                )}

                <div className={`${bottomMargin} transition-all duration-200`}>
                  <MessageBubble
                    message={message}
                    isOwn={isOwn}
                    showSenderName={!isOwn && isFirstInGroup}
                    showAvatar={!isOwn && isLastInGroup}
                    showTimestamp={isLastInGroup}
                    onAttachmentLoad={handleAttachmentLoad}
                    onOpenAttachment={(att) => setPreviewFile(attachmentToPreview(att))}
                    onEdit={isOwn ? handleEditMessage : undefined}
                    onDelete={isOwn ? handleDeleteMessage : undefined}
                  />

                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 3. Input Area */}
      <div className="shrink-0 bg-surface border-t border-outline-subtle p-3 md:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.02)] z-10">
        <div className="max-w-3xl mx-auto">
          <MessageInput
            onSend={handleSend}
            lawFirmId={lawFirmId}
            clientId={effectiveClientId}
            conversationId={threadKey}
            isClient={isClient}
          />
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-on-surface-muted">
            {!isClient && !isGroup && (
              <>
                <Mail size={11} className="shrink-0" />
                <span>The client is notified by email.</span>
              </>
            )}
            <span className="hidden md:inline">
              {!isClient && !isGroup && <span className="mx-1 text-on-surface-muted/50">·</span>}
              Press Enter to send. Shift + Enter for new line.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
