"use client";

import { useEffect, useRef } from "react";
import AttachClientModal, { type AttachClientTarget } from "@/components/clientComp/AttachClientModal";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  taskId: string;
  existingClientIds: string[];
  onAfter?: () => Promise<void> | void;
};

/**
 * Attach a client to a task. The search / create / edit flow is shared with the
 * matter version. A task updates its clients list wholesale, tracking changes
 * across attach and detach callbacks so roster cleanup occurs cleanly when
 * attaching an organization client.
 */
export default function AddTaskClientModal({
  open,
  onClose,
  lawFirmId,
  taskId,
  existingClientIds,
  onAfter,
}: Props) {
  const currentClientIdsRef = useRef<string[]>(existingClientIds);

  useEffect(() => {
    if (open) {
      currentClientIdsRef.current = [...existingClientIds];
    }
  }, [open, existingClientIds]);

  const target: AttachClientTarget = {
    label: "Task",
    attachedClientIds: existingClientIds,
    attach: async ({ clientId }) => {
      const { default: TasksService } = await import("@/services/tasks.service");
      if (!currentClientIdsRef.current.includes(clientId)) {
        currentClientIdsRef.current = [...currentClientIdsRef.current, clientId];
      }
      await TasksService.updateTask({
        lawFirmId,
        taskId,
        clientIds: currentClientIdsRef.current,
      });
    },
    detach: async (clientId) => {
      const { default: TasksService } = await import("@/services/tasks.service");
      currentClientIdsRef.current = currentClientIdsRef.current.filter((id) => id !== clientId);
      await TasksService.updateTask({
        lawFirmId,
        taskId,
        clientIds: currentClientIdsRef.current,
      });
    },
    invalidateKeys: [["tasks", lawFirmId]],
  };

  return (
    <AttachClientModal
      open={open}
      onClose={onClose}
      lawFirmId={lawFirmId}
      target={target}
      onAfter={onAfter}
    />
  );
}
