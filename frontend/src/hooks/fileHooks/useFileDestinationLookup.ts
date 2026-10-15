"use client";

import { useCallback } from "react";
import mattersService from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import tasksService from "@/services/tasks.service";

/** Destination callers retain their search scheduling and response adapters. */
export default function useFileDestinationLookup(lawFirmId: string) {
  return useCallback((category: "matters" | "clients" | "tasks", options: {
    search?: string; ids?: string[]; limit: number; full?: boolean;
  }) => {
    if (category === "matters") return mattersService.lookupMatters(lawFirmId, options);
    if (category === "clients") return clientsService.lookupClients(lawFirmId, options);
    return tasksService.lookupTasks(lawFirmId, options);
  }, [lawFirmId]);
}
