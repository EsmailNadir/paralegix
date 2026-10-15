/** Preset colors shared by matter and lead pipeline stages. */
export const STAGE_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#64748b", // slate
] as const;

export const DEFAULT_STAGE_COLOR = STAGE_COLORS[0];
