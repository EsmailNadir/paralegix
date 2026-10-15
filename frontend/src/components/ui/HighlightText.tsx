import React from "react";

/**
 * Bolds every case-insensitive occurrence of `query` inside `text` so search
 * matches stand out in list rows. Returns the plain string when there's no
 * query, so callers can use it unconditionally.
 */
export function highlightText(
  text: string | null | undefined,
  query: string | null | undefined
): React.ReactNode {
  const value = text ?? "";
  const term = (query ?? "").trim();
  if (!term || !value) return value;

  // Escape regex metacharacters so the raw query is matched literally.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = value.split(new RegExp(`(${escaped})`, "ig"));

  return parts.map((part, index) =>
    part.toLowerCase() === term.toLowerCase() ? (
      <strong key={index} className="font-bold text-on-surface">
        {part}
      </strong>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
}
