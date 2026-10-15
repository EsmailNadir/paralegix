"use client";

import Tooltip from "@/components/ui/Tooltip";
import { Pause, Play, Square, Trash2 } from "lucide-react";

interface TimerWidgetProps {
  isActive: boolean;
  isRunning: boolean;
  targetLabel: string;
  formattedTime: string;
  description: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onUpdateDescription: (desc: string) => void;
  variant?: "floating" | "inline";
}

export default function TimerWidget({
  isActive,
  isRunning,
  targetLabel,
  formattedTime,
  description,
  onPause,
  onResume,
  onStop,
  onDiscard,
  onUpdateDescription,
  variant = "floating",
}: TimerWidgetProps) {
  if (!isActive) return null;

  const containerClassName =
    variant === "inline"
      ? "bg-surface border border-outline rounded-xl shadow-sm p-4"
      : "fixed bottom-6 right-6 z-40 bg-surface border border-outline rounded-xl shadow-lg p-4 min-w-[280px] max-w-[360px]";

  return (
    <div className={containerClassName}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {isRunning && (
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
          )}
          <span className="text-sm font-medium text-on-surface truncate">
            {targetLabel}
          </span>
        </div>
        <span className="text-lg font-mono font-semibold text-on-surface ml-3 tabular-nums">
          {formattedTime}
        </span>
      </div>

      <input
        type="text"
        value={description}
        onChange={(e) => onUpdateDescription(e.target.value)}
        placeholder="What are you working on?"
        className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring mb-3"
      />

      <div className="flex items-center gap-2">
        {isRunning ? (
          <button
            type="button"
            onClick={onPause}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
          >
            <Pause size={13} />
            Pause
          </button>
        ) : (
          <button
            type="button"
            onClick={onResume}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
          >
            <Play size={13} />
            Resume
          </button>
        )}
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-accent-emphasis hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
        >
          <Square size={13} />
          Stop
        </button>
        <Tooltip title="Discard timer" enterDelay={300}>
          <button aria-label="Discard timer"
            type="button"
            onClick={onDiscard}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-on-surface-muted hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 dark:hover:text-red-400 transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ml-auto"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
