"use client";

import { useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import messagesService from '@/services/messages.service';
import clientPortalService from '@/services/client-portal.service';
import type { Message, MessageAttachment } from '@/types';
import { track } from "@/lib/analytics/analytics";

interface SendMessageOptions {
  lawFirmId: string;
  clientId: string;
  content: string;
  matterId?: string;
  attachments?: MessageAttachment[];
  mentions?: string[];
  onSuccess?: (message: Message) => void;
  onError?: (error: Error) => void;
  isClient?: boolean; // Explicitly pass if known
  // Group threads route to the group send endpoints. `conversationId` is the
  // real conversation uuid (required when isGroup is true).
  isGroup?: boolean;
  conversationId?: string;
}

export function useSendMessage() {
  const { user } = useAuth();
  // Tail of the in-flight send chain. Each send waits for the previous one to
  // finish before hitting the network, so concurrently-typed messages are
  // delivered to the server one-by-one in the order they were composed, while
  // the optimistic UI for every one of them shows instantly (the input never
  // blocks waiting for a round-trip).
  const sendQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  // A monotonic counter so each optimistic message gets a unique temp id even
  // when several are composed within the same millisecond.
  const tempIdCounterRef = useRef(0);

  const sendMessage = useCallback(async (options: SendMessageOptions) => {
    if (!user) throw new Error('Not authenticated');
    if (!options.content.trim() && (!options.attachments || options.attachments.length === 0)) {
      throw new Error('Message cannot be empty');
    }

    // Determine sender type from the explicit isClient flag the call site
    // passes (ConversationView always provides it). Defaults to firm_member
    // when omitted, matching the prior fallback behavior.
    const senderType = options.isClient ? 'client' : 'firm_member';

    // Optimistic update: Create temporary message and surface it immediately,
    // before this send waits its turn in the queue or touches the network.
    const optimisticMessage: Message = {
      messageId: `temp-${Date.now()}-${tempIdCounterRef.current++}`,
      senderId: user.uid,
      senderType: senderType,
      senderName: user.displayName || 'You',
      content: options.content,
      attachments: options.attachments || [],
      status: 'sending',
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    options.onSuccess?.(optimisticMessage);

    // Chain the network call after any previous in-flight send so the server
    // receives messages in composition order. The server creates the real row;
    // the Supabase Realtime subscription picks it up and replaces this
    // optimistic copy (correlated by messageId).
    const run = sendQueueRef.current.then(() => {
      if (options.isGroup) {
        if (!options.conversationId) throw new Error('Missing group conversation id');
        return options.isClient
          ? clientPortalService.sendGroupMessage(options.conversationId, options.content, options.attachments)
          : messagesService.sendGroupMessage(options.lawFirmId, options.conversationId, {
              content: options.content,
              attachments: options.attachments,
              mentions: options.mentions,
            });
      }
      return options.isClient
        ? clientPortalService.sendMessage(options.lawFirmId, options.content, options.matterId, options.attachments)
        : messagesService.sendMessage({
            lawFirmId: options.lawFirmId,
            clientId: options.clientId,
            content: options.content,
            matterId: options.matterId,
            attachments: options.attachments,
            mentions: options.mentions,
          });
    });

    // Keep the chain alive even if this send fails, so a single failure doesn't
    // wedge every later message behind a rejected promise.
    sendQueueRef.current = run.catch(() => {});

    try {
      const result = await run;
      track("message_sent", {
        sender_type: senderType,
        has_matter: Boolean(options.matterId),
        attachment_count: options.attachments?.length ?? 0,
      });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to send message');
      options.onError?.(err);
      throw err;
    }
  }, [user]);

  return {
    sendMessage,
  };
}
