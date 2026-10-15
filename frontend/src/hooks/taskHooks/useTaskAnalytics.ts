"use client";

import { useQuery } from "@tanstack/react-query";
import tasksService from "@/services/tasks.service";
import type { TaskAnalyticsResponse } from "@/services/tasks.service";

export function useTaskAnalytics(lawFirmId?: string, dateRange: string = "all") {
  const { data, isLoading, error, refetch } = useQuery<TaskAnalyticsResponse>({
    queryKey: ["taskAnalytics", lawFirmId, dateRange],
    queryFn: () => tasksService.getTaskAnalytics(lawFirmId!, dateRange),
    enabled: !!lawFirmId,
  });

  return {
    data: data ?? null,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load analytics") : null,
    refresh: refetch,
  };
}
