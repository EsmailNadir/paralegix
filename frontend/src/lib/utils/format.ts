/** Human-readable file size ("980 B", "1.5 KB", "12 MB"). Zero, negative, or missing sizes render "-". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** File size in the firm-side file browser's format ("1.25 MB", zero renders "0 Bytes"). */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Split decimal hours into whole hours and minutes, rounded to the nearest minute.
 * 1.5 -> { h: 1, m: 30 }, 0.333 -> { h: 0, m: 20 }. Negative/missing values clamp to zero.
 * Rounds total minutes first so values like 0.999 never yield "60m".
 */
export function hoursToHm(hours: number | null | undefined): { h: number; m: number } {
  const totalMinutes = Math.max(0, Math.round((hours ?? 0) * 60));
  return { h: Math.floor(totalMinutes / 60), m: totalMinutes % 60 };
}

/** Combine whole hours and minutes into decimal hours. (1, 30) -> 1.5. */
export function hmToHours(h: number | string | null | undefined, m: number | string | null | undefined): number {
  const hn = parseFloat(String(h ?? "")) || 0;
  const mn = parseFloat(String(m ?? "")) || 0;
  return hn + mn / 60;
}

/**
 * Format decimal hours for display as hours and minutes: 1.5 -> "1h 30m", 2 -> "2h",
 * 0.25 -> "15m", 0 -> "0m". This is how time is shown to users everywhere in the app,
 * so they never have to read or reason about decimal hours.
 */
export function formatHoursMinutes(hours: number | null | undefined): string {
  const { h, m } = hoursToHm(hours);
  if (h === 0 && m === 0) return "0m";
  if (m === 0) return `${h}h`;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * First + last initial, uppercased ("Jane Doe" -> "JD"). A single word keeps its
 * first two letters ("Acme" -> "AC") and a blank/missing name falls back to "?"
 * rather than throwing. `Avatar` delegates to this so a name renders the same
 * initials whether it backs an avatar chip or plain text.
 */
export function getInitials(name?: string | null): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
