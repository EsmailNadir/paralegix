"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import mattersService from "@/services/matters.service";
import tasksService from "@/services/tasks.service";
import clientsService from "@/services/clients.service";

type ParentType = 'matter' | 'task' | 'client';

/**
 * A note's reply thread: read only when expanded (a page of ten notes should
 * not fire ten thread reads on mount), and every mutation invalidates both the
 * thread and the notes page, since `replyCount` lives on the note itself.
 *
 * Matter, task, and client note replies are the same feature server-side
 * (`shared/notes/noteReplies.ts`); `parentType` just picks which service
 * hits the right URL.
 */
export default function useNoteReplies(lawFirmId: string, parentType: ParentType, parentId: string, noteId: string, enabled: boolean) {
  const queryClient = useQueryClient();

  const listReplies = (id: string) => {
    if (parentType === 'task') return tasksService.listTaskNoteReplies(lawFirmId, id, noteId);
    if (parentType === 'client') return clientsService.listClientNoteReplies(lawFirmId, id, noteId);
    return mattersService.listNoteReplies(lawFirmId, id, noteId);
  };

  const query = useQuery({
    queryKey: ["noteReplies", parentType, lawFirmId, parentId, noteId],
    queryFn: () => listReplies(parentId),
    enabled,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["noteReplies", parentType, lawFirmId, parentId, noteId] });
    void queryClient.invalidateQueries({ queryKey: ["entityNotes", parentType, lawFirmId, parentId] });
  };

  const addReply = useMutation({
    mutationFn: (reply: { content: string; contentHtml?: string; mentions?: string[]; parentReplyId?: string | null }) => {
      if (parentType === 'task') return tasksService.addTaskNoteReply(lawFirmId, parentId, noteId, reply);
      if (parentType === 'client') return clientsService.addClientNoteReply(lawFirmId, parentId, noteId, reply);
      return mattersService.addNoteReply(lawFirmId, parentId, noteId, reply);
    },
    onSuccess: invalidate,
  });

  const updateReply = useMutation({
    mutationFn: ({ replyId, reply }: { replyId: string; reply: { content: string; contentHtml?: string } }) => {
      if (parentType === 'task') return tasksService.updateTaskNoteReply(lawFirmId, parentId, noteId, replyId, reply);
      if (parentType === 'client') return clientsService.updateClientNoteReply(lawFirmId, parentId, noteId, replyId, reply);
      return mattersService.updateNoteReply(lawFirmId, parentId, noteId, replyId, reply);
    },
    onSuccess: invalidate,
  });

  const retractReply = useMutation({
    mutationFn: ({ replyId, reason }: { replyId: string; reason?: string }) => {
      if (parentType === 'task') return tasksService.retractTaskNoteReply(lawFirmId, parentId, noteId, replyId, reason);
      if (parentType === 'client') return clientsService.retractClientNoteReply(lawFirmId, parentId, noteId, replyId, reason);
      return mattersService.retractNoteReply(lawFirmId, parentId, noteId, replyId, reason);
    },
    onSuccess: invalidate,
  });

  return {
    replies: query.data?.replies ?? [],
    loading: query.isLoading,
    error: query.error,
    addReply,
    updateReply,
    retractReply,
  };
}
