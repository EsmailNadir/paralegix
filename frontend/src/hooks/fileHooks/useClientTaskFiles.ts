"use client";

import { useQuery } from "@tanstack/react-query";

import FilesService, { type ClientTaskFiles } from "@/services/files.service";

const NO_TASKS: ClientTaskFiles[] = [];

/**
 * The standalone tasks attached to a client that hold files, for the task
 * folders on the client's Files tab. A task with no matter keeps its documents
 * in its own tree, which nothing else on the client page reaches.
 *
 * A failed read leaves the list empty rather than painting an error over the
 * client's own files, the same way the matter counts beside it fail.
 */
export default function useClientTaskFiles({
  lawFirmId,
  clientId,
  enabled,
}: {
  lawFirmId: string;
  clientId: string;
  enabled: boolean;
}) {
  const query = useQuery({
    queryKey: ["files", lawFirmId, "clientTasks", clientId],
    queryFn: () => FilesService.listClientTaskFiles(lawFirmId, clientId),
    enabled: enabled && !!lawFirmId && !!clientId,
  });
  return {
    tasks: query.data ?? NO_TASKS,
    loading: query.isLoading,
    reload: query.refetch,
  };
}
