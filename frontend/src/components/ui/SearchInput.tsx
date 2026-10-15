"use client";

import { Search, X } from "lucide-react";
import { INPUT_CLS } from "./inputClasses";

/**
 * A list's search box: the magnifier inside the left edge, and a clear button
 * that appears inside the right edge once there is something to clear.
 *
 * Eleven lists spelled this out. `ListToolbar` gave them the panel around it
 * but not the field itself, so each one positioned its own icons.
 *
 * `py-2`, not `py-2.5`: the filter dropdowns sit on this same row, and their
 * trigger is `px-3 py-2 text-sm`.
 */
export default function SearchInput({
  value,
  onChange,
  onClear,
  placeholder,
  className = "",
  size = "md",
  showClear,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * What the clear button does. Defaults to `onChange("")`. Two grids need it
   * separately: typing there also suppresses the row hover, and clearing did
   * not, so routing both through `onChange` would change what clearing does.
   */
  onClear?: () => void;
  placeholder?: string;
  /** Classes for the positioning wrapper. Every call site sizes its own row. */
  className?: string;
  /**
   * "md" is the entity grids (matters, tasks, clients, contacts, leads, files);
   * "sm" is the signing, template and trust lists. They differ only in the two
   * icon sizes, which is drift rather than intent, kept here so this swap
   * changes no pixels.
   */
  size?: "md" | "sm";
  /**
   * When the clear button shows. Defaults to "whenever there is a value", which
   * is what every list but the template tab wants; that one clears on its own
   * normalised query.
   */
  showClear?: boolean;
  "aria-label"?: string;
}) {
  const clearable = showClear ?? Boolean(value);

  return (
    <div className={`relative ${className}`.trim()}>
      <Search
        size={size === "md" ? 16 : 15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted"
      />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`${INPUT_CLS} w-full pl-9 pr-9 transition-colors`}
      />
      {clearable && (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange(""))}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
        >
          <X size={size === "md" ? 15 : 14} />
        </button>
      )}
    </div>
  );
}
