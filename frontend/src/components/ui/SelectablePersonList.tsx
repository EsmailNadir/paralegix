"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";

export interface SelectablePerson {
  id: string;
  name?: string | null;
  email?: string | null;
  photoUrl?: string | null;
  /** Optional note about this person, drawn between their name and the check. */
  meta?: ReactNode;
  /** Plain text drawn right after the name, e.g. " (you)". Kept out of `name` so the avatar initials stay the person's own. */
  nameSuffix?: string;
  /** Always selected and not toggleable, e.g. someone included automatically. */
  locked?: boolean;
}

interface SelectablePersonListProps {
  people: SelectablePerson[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}

/**
 * The canonical multi-select list of people used across the app (group
 * participants, new-group creation, etc.): a vertical list where each row is
 * `avatar · name / email · check`, and clicking a row toggles it. Renders only
 * the `<ul>` of rows, so callers own the surrounding surface (a bordered,
 * scrollable box), any section headings, and - for searchable pickers - a
 * search input above it that pre-filters `people`.
 */
export default function SelectablePersonList({
  people,
  selectedIds,
  onToggle,
  disabled = false,
}: SelectablePersonListProps) {
  const selected = new Set(selectedIds);
  return (
    <ul className="divide-y divide-outline-subtle">
      {people.map((p) => {
        const isSelected = !!p.locked || selected.has(p.id);
        return (
          <li key={p.id}>
            <button
              type="button"
              disabled={disabled || p.locked}
              onClick={() => onToggle(p.id)}
              aria-pressed={isSelected}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Avatar size="sm" name={p.name} email={p.email} photoUrl={p.photoUrl} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-on-surface truncate">
                  {p.name || p.email}
                  {p.nameSuffix}
                </div>
                {p.name && p.email && (
                  <div className="text-xs text-on-surface-muted truncate">{p.email}</div>
                )}
              </div>
              {p.meta && <span className="shrink-0">{p.meta}</span>}
              <span
                className={`shrink-0 flex items-center justify-center h-5 w-5 rounded-md border transition-colors ${
                  isSelected
                    ? "bg-accent-solid border-accent-solid text-accent-foreground"
                    : "border-outline text-transparent"
                }`}
              >
                <Check size={13} strokeWidth={3} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
