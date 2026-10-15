"use client";

import { useState, useEffect, useCallback } from "react";
import FilesService, { type StorageUsageResponse } from "@/services/files.service";

interface StorageUsageBarProps {
  lawFirmId: string;
  refreshTrigger?: number;
}

export default function StorageUsageBar({ lawFirmId, refreshTrigger }: StorageUsageBarProps) {
  const [usage, setUsage] = useState<StorageUsageResponse | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const data = await FilesService.getStorageUsage(lawFirmId);
      setUsage(data);
    } catch (err) {
      console.error("Failed to load storage usage:", err);
    }
  }, [lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: loading/usage state is set as the request progresses; no render-time equivalent
    loadUsage();
  }, [loadUsage, refreshTrigger]);

  if (!usage || usage.percentUsed < 95) return null;

  const isCritical = usage.percentUsed >= 100;
  const barColor = isCritical ? "bg-red-600" : "bg-red-500";
  const textColor = "text-red-600 dark:text-red-400";

  return (
    <div className="bg-surface rounded-xl border border-outline shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-on-surface-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
          </svg>
          <span className="text-sm font-medium text-on-surface">Law Firm Storage</span>
        </div>
        <span className={`text-xs font-medium ${textColor}`}>
          {usage.usedFormatted} / {usage.limitFormatted}
        </span>
      </div>
      <div className="w-full bg-surface-alt rounded-full h-2">
        <div
          className={`${barColor} h-2 rounded-full transition-all duration-500`}
          style={{ width: `${Math.min(100, usage.percentUsed)}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-xs text-on-surface-muted">{usage.fileCount} file{usage.fileCount !== 1 ? 's' : ''}</span>
        <span className={`text-xs ${textColor}`}>{usage.percentUsed}% used</span>
      </div>
      <p className="text-xs mt-2 text-red-600 dark:text-red-400">
        Storage is almost full. Delete files to free up space.
      </p>
    </div>
  );
}
