import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import type { User } from "@/types";
import useAnchoredMenuPosition from "@/hooks/useAnchoredMenuPosition";
import TextInput from "@/components/ui/TextInput";

/**
 * Team-members picker shared by the create and edit matter modals: a search
 * dropdown to add members plus a list of member cards with a lead (responsible
 * attorney) toggle and remove. The acting user is pinned to the team. The empty
 * state and subtitle differ slightly per modal, so both are passed in.
 */
export default function MatterMemberPicker({
  users,
  memberUserIds,
  leadUserIds,
  currentUserId,
  onAdd,
  onRemove,
  onToggleLead,
  onToggleAll,
  subtitle,
  emptyState,
  disabled = false,
}: {
  users: User[];
  memberUserIds: string[];
  leadUserIds: string[];
  currentUserId?: string;
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
  onToggleLead: (userId: string) => void;
  onToggleAll: () => void;
  subtitle: string;
  emptyState: ReactNode;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mounted: dropdownMounted, exiting: dropdownExiting } = useMountTransition(showDropdown, 150);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu lives in a body portal, so a click on it is outside `searchRef`.
      if (menuRef.current?.contains(target)) return;
      if (searchRef.current && !searchRef.current.contains(target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const matchesSearch = (u: User) =>
    !!u.uid &&
    !memberUserIds.includes(u.uid) &&
    (search.trim() === "" ||
      (u.name || "").toLowerCase().includes(search.toLowerCase()) ||
      (u.email || "").toLowerCase().includes(search.toLowerCase()));
  const candidates = users.filter(matchesSearch);
  // Picking a member clears the search and adds them in the same click, which
  // would swap the list under the closing menu. Keep the rows it showed.
  const shownCandidates = useLastOpenValue(showDropdown, candidates);

  // Rendered in a body portal so the matter form's scrolling modal body cannot
  // clip it. 44px per two-line row, capped at the max-h-48 (192px) list.
  const menuPos = useAnchoredMenuPosition({
    open: dropdownMounted,
    anchorRef: searchRef,
    menuRef,
    estimatedHeight: Math.min(192, Math.max(1, shownCandidates.length) * 44 + 8),
    deps: [shownCandidates.length],
  });

  return (
    <div className="rounded-lg border border-outline p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Team Members</h3>
          <p className="text-xs text-on-surface-secondary mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="secondary" size="small" onClick={onToggleAll} disabled={disabled}>
            {memberUserIds.length === users.length ? "Deselect All" : "Select All"}
          </Button>
        </div>
      </div>

      <div ref={searchRef} className="relative">
        <TextInput
          placeholder="Search members..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setShowDropdown(true); }}
          onFocus={() => setShowDropdown(true)}
          disabled={disabled}
        />
        {dropdownMounted && menuPos && typeof document !== "undefined" && createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            className={`z-[60] rounded-md border border-outline bg-surface shadow-lg max-h-48 overflow-y-auto overflow-x-hidden styled-scrollbar origin-top ${menuAnim(dropdownExiting)}`}>
            {shownCandidates.map((u) => (
              <button
                key={u.uid}
                type="button"
                className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-hover transition-colors text-left cursor-pointer"
                onMouseDown={(e) => { e.preventDefault(); if (!showDropdown) return; onAdd(u.uid); setSearch(""); setShowDropdown(false); }}
              >
                <div className="w-7 h-7 rounded-full bg-accent-selection flex items-center justify-center shrink-0">
                  <span className="text-white text-xs font-semibold">{(u.name || u.email || u.uid).charAt(0).toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-on-surface truncate">{u.name || u.uid}</p>
                  {u.email && <p className="text-xs text-on-surface-muted truncate">{u.email}</p>}
                </div>
              </button>
            ))}
            {candidates.length === 0 && (
              <p className="px-3 py-2 text-sm text-on-surface-muted">
                {search.trim() ? "No members found" : "All members already added"}
              </p>
            )}
          </div>,
          document.body,
        )}
      </div>

      {memberUserIds.length === 0 && emptyState}

      {memberUserIds.length > 0 && (
        <div className="max-h-50 overflow-y-auto overflow-x-hidden styled-scrollbar space-y-2 pr-2">
          {memberUserIds.map((memberId, index) => {
            const member = users.find((u) => u.uid === memberId);
            const isCurrentUser = memberId === currentUserId;
            const isLead = leadUserIds.includes(memberId);

            return (
              <div key={memberId || `member-${index}`} className={`group flex items-center justify-between p-3 rounded-lg border shadow-sm hover:shadow-md dark:hover:shadow-none dark:hover:ring-1 dark:hover:ring-white/10 transition-all duration-200 ${
                isLead
                  ? 'bg-gradient-to-r from-purple-50 to-violet-50 border-purple-200 dark:from-purple-500/20 dark:to-violet-500/20 dark:border-purple-700/50 dark:hover:ring-purple-500/30'
                  : isCurrentUser
                    ? 'bg-gradient-to-r from-green-50 to-emerald-50 border-green-200 dark:from-emerald-500/20 dark:to-emerald-500/20 dark:border-emerald-700/50 dark:hover:ring-emerald-500/30'
                    : 'bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200 dark:from-indigo-500/20 dark:to-indigo-500/20 dark:border-accent-border-soft dark:hover:ring-focus-ring'
              }`}>
                <div className="flex items-center space-x-3 min-w-0">
                  <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center shadow-sm ${
                    isLead
                      ? 'bg-gradient-to-br from-purple-500 to-violet-600'
                      : isCurrentUser
                        ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                        : 'bg-gradient-to-br from-blue-500 to-indigo-600'
                  }`}>
                    <span className="text-white text-sm font-semibold">
                      {(member?.name || member?.email || memberId || 'U').charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-on-surface truncate">
                      {member?.name || member?.email || memberId}
                      {isCurrentUser && <span className="text-xs text-green-600 dark:text-emerald-400 font-medium ml-1">(You)</span>}
                      {isLead && <span className="text-xs text-purple-600 dark:text-purple-400 font-medium ml-1">(Lead)</span>}
                    </p>
                    <p className="text-xs text-on-surface-secondary flex items-center min-w-0">
                      <svg className="w-3 h-3 mr-1 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="truncate">{isLead ? 'Lead & Team Member' : 'Team Member'}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <button
                    type="button"
                    onClick={() => onToggleLead(memberId)}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full border whitespace-nowrap transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                      isLead
                        ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/20 dark:text-purple-300 dark:border-purple-700/50'
                        : 'bg-surface text-on-surface-secondary border-outline hover:bg-surface-hover'
                    }`}
                  >
                    {isLead ? 'Lead' : 'Make Lead'}
                  </button>
                  {isCurrentUser ? (
                    <div className="text-xs text-on-surface-muted px-3 py-1 bg-surface-alt rounded-full whitespace-nowrap">
                      Required
                    </div>
                  ) : (
                    <Button
                      type="danger"
                      size="small"
                      onClick={() => onRemove(memberId)}
                      className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-200"
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
