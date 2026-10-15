import { useState } from "react";
import { Search } from "lucide-react";
import SelectablePersonList from "@/components/ui/SelectablePersonList";
import { useAuth } from "@/hooks/useAuth";
import FieldLabel from "@/components/ui/FieldLabel";

type SimpleUser = { id: string; name?: string | null; email?: string | null };

/**
 * Searchable team-member picker shared by the create and edit task modals.
 * It uses the same person-row treatment as client pickers: avatar, identity,
 * and a right-aligned selection control.
 */
export default function TaskAssigneePicker({
  users,
  selectedIds,
  onToggle,
}: {
  users: SimpleUser[];
  selectedIds: string[];
  onToggle: (userId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { user: currentUser } = useAuth();
  const query = search.trim().toLowerCase();
  const visibleUsers = query
    ? users.filter(
        (u) =>
          (u.name || "").toLowerCase().includes(query) ||
          (u.email || "").toLowerCase().includes(query)
      )
    : [
        ...users.filter((u) => u.id === currentUser?.uid),
        ...users.filter((u) => u.id !== currentUser?.uid),
      ];

  return (
    <div>
      <FieldLabel>Assigned To</FieldLabel>
      <div className="overflow-hidden rounded-md border border-input-border bg-input-bg">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted"
          />
          <input
            className="w-full bg-transparent py-2 pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search team members..."
          />
        </div>
        <div className="max-h-36 overflow-y-auto overflow-x-hidden border-t border-outline-subtle styled-scrollbar">
          {visibleUsers.length > 0 ? (
            <SelectablePersonList
              people={visibleUsers}
              selectedIds={selectedIds}
              onToggle={onToggle}
            />
          ) : (
            <p className="px-3 py-6 text-center text-sm text-on-surface-muted">
              No members found
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
