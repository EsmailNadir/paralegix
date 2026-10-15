"use client";

import { useQuery } from "@tanstack/react-query";
import messagesService from "@/services/messages.service";
import type { Conversation, ConversationListQuery } from "@/types";

// Shared read of the firm-side conversation list. Keyed on
// ["firmConversations", lawFirmId] so every caller on a client detail page
// (the header/tab badge in ClientDetail and the list in ClientMessagesTab)
// dedupes to a single fetch.
export default function useFirmConversations(
  lawFirmId?: string,
  enabled = true,
  scope: Pick<ConversationListQuery, "clientId" | "clientIds"> = {},
) {
  const { data, isLoading, error, refetch } = useQuery<Conversation[]>({
    queryKey: ["firmConversations", lawFirmId, scope],
    queryFn: () => messagesService.getFirmConversations(lawFirmId!, scope),
    enabled: !!lawFirmId && enabled,
    staleTime: 30_000,
  });
  return { conversations: data ?? [], loading: isLoading, error, refresh: refetch };
}
