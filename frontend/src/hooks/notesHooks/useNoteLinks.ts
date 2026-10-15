"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import mattersService from "@/services/matters.service";

/**
 * Connected-action mutations for one note: create a task from it, link an
 * existing task or document, or remove a link.
 *
 * Every mutation invalidates the notes page rather than patching the cached
 * note, since a link changes the note's `links` array and creating a task
 * also changes the tasks list elsewhere on the page.
 */
export default function useNoteLinks(lawFirmId: string, matterId: string) {
  const queryClient = useQueryClient();
  const invalidateNotes = () => {
    void queryClient.invalidateQueries({ queryKey: ["entityNotes", "matter", lawFirmId, matterId] });
  };
  const invalidateTasks = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks", lawFirmId] });
  };

  const createTask = useMutation({
    mutationFn: ({ noteId, task }: { noteId: string; task: { title?: string; description?: string; dueDate?: string; priority?: string; replyId?: string } }) =>
      mattersService.createTaskFromNote(lawFirmId, matterId, noteId, task),
    onSuccess: () => { invalidateNotes(); invalidateTasks(); },
  });

  const linkTask = useMutation({
    mutationFn: ({ noteId, taskId }: { noteId: string; taskId: string }) =>
      mattersService.linkTaskToNote(lawFirmId, matterId, noteId, taskId),
    onSuccess: invalidateNotes,
  });

  const linkFile = useMutation({
    mutationFn: ({ noteId, fileId }: { noteId: string; fileId: string }) =>
      mattersService.linkFileToNote(lawFirmId, matterId, noteId, fileId),
    onSuccess: invalidateNotes,
  });

  const unlink = useMutation({
    mutationFn: ({ noteId, linkId }: { noteId: string; linkId: string }) =>
      mattersService.unlinkFromNote(lawFirmId, matterId, noteId, linkId),
    onSuccess: invalidateNotes,
  });

  return { createTask, linkTask, linkFile, unlink };
}
