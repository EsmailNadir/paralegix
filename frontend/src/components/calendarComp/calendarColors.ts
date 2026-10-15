import type { Task } from "@/types";

/** Tailwind class fragments for a task's calendar color, keyed off its status/priority. */
export interface TaskColor {
  bg: string;
  /** Stronger fill used when an all-day chip is selected, where the outward
   * offset ring/shadow the timed blocks use would be clipped by the row's
   * `overflow-hidden`, so the selected state has to read from within the chip. */
  selectedBg: string;
  border: string;
  text: string;
  dot: string;
  ring: string;
}

/**
 * Single source of truth for task coloring across the calendar grid and the side
 * panel, so the same task reads as the same color in both places. Completed wins
 * over everything, then urgent priority, then the remaining statuses.
 */
export const getTaskColor = (task: Task): TaskColor => {
  if (task.status === 'completed') return { bg: 'bg-emerald-500/15 dark:bg-emerald-500/20', selectedBg: 'bg-emerald-500/30 dark:bg-emerald-500/40', border: 'border-l-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', ring: 'ring-emerald-500' };
  if (task.priority === 'urgent') return { bg: 'bg-rose-500/15 dark:bg-rose-500/20', selectedBg: 'bg-rose-500/30 dark:bg-rose-500/40', border: 'border-l-rose-500', text: 'text-rose-700 dark:text-rose-300', dot: 'bg-rose-500', ring: 'ring-rose-500' };
  if (task.status === 'in_progress') return { bg: 'bg-amber-500/15 dark:bg-amber-500/20', selectedBg: 'bg-amber-500/30 dark:bg-amber-500/40', border: 'border-l-amber-500', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500', ring: 'ring-amber-500' };
  if (task.status === 'blocked') return { bg: 'bg-purple-500/15 dark:bg-purple-500/20', selectedBg: 'bg-purple-500/30 dark:bg-purple-500/40', border: 'border-l-purple-500', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500', ring: 'ring-purple-500' };
  return { bg: 'bg-blue-500/15 dark:bg-blue-500/20', selectedBg: 'bg-blue-500/30 dark:bg-blue-500/40', border: 'border-l-blue-500', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500', ring: 'ring-blue-500' };
};
