"use client";

import { useState } from "react";
import FieldLabel from "@/components/ui/FieldLabel";
import Checkbox from "@/components/ui/Checkbox";
import StatusBadge from "@/components/ui/StatusBadge";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";

/**
 * Picks the firm members an event is assigned to: a search box over a scrolling
 * checkbox list, with the chosen members shown as removable chips beneath.
 *
 * `MatterEventsTab` and `ClientEventsTab` each carried this, along with the
 * search state, the filter and the toggle. All three were identical.
 *
 * Names travel beside ids because the chips show a name and the list a member.
 * The two arrays are positional: `assignedToName[i]` names `assignedTo[i]`.
 */
export default function EventAssigneePicker({
  users,
  assignedTo,
  assignedToName,
  onChange,
}: {
  users: any[];
  assignedTo: string[];
  assignedToName: string[];
  onChange: (ids: string[], names: string[]) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? users.filter(
        (u) =>
          ((u as any).name || "").toLowerCase().includes(search.toLowerCase()) ||
          ((u as any).email || "").toLowerCase().includes(search.toLowerCase())
      )
    : users;

  const toggle = (userId: string, userName: string) => {
    if (assignedTo.includes(userId)) {
      const idx = assignedTo.indexOf(userId);
      onChange(
        assignedTo.filter((id) => id !== userId),
        assignedToName.filter((_, i) => i !== idx),
      );
    } else {
      onChange([...assignedTo, userId], [...assignedToName, userName]);
    }
  };

  return (
    <div>
      <FieldLabel>Assigned To</FieldLabel>
      <div className="space-y-2">
        <input
          className={FULL_INPUT_CLS}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search team members..."
        />
        <div className="max-h-36 overflow-y-auto overflow-x-hidden rounded-md border border-outline styled-scrollbar">
          {filtered.length > 0 ? (
            filtered.map((u: any) => (
              <label
                key={u.id || u.uid}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover transition-colors cursor-pointer border-b border-outline-subtle last:border-b-0"
              >
                <Checkbox
                  checked={assignedTo.includes(u.id || u.uid)}
                  onChange={() => toggle(u.id || u.uid, u.name || u.id || u.uid)}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-on-surface truncate">{u.name || u.id || u.uid}</p>
                  {u.email && <p className="text-xs text-on-surface-secondary truncate">{u.email}</p>}
                </div>
              </label>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-on-surface-muted">No members found</p>
          )}
        </div>
        {assignedTo.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {assignedTo.map((id, idx) => (
              <StatusBadge key={id} variant="info">
                {assignedToName[idx] || id}
                <button
                  type="button"
                  onClick={() => toggle(id, assignedToName[idx] || id)}
                  className="ml-0.5 text-accent-emphasis dark:text-blue-300 hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover cursor-pointer"
                >
                  &times;
                </button>
              </StatusBadge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
