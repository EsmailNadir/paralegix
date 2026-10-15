"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { FirmMember } from "@/hooks/useFirmMembers";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import { Avatar } from "@/components/ui/Avatar";

interface MentionTextareaProps extends Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'aria-label' | 'aria-describedby' | 'aria-invalid'> {
  value: string;
  onChange: (value: string) => void;
  /** Reports the user ids currently @mentioned in the text (deduped). */
  onMentionsChange?: (ids: string[]) => void;
  members: FirmMember[];
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Called on Enter (without Shift) only when the mention popup is closed. */
  onEnter?: () => void;
  /** Shared ref so callers can auto-resize / focus the underlying textarea. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

const MAX_SUGGESTIONS = 6;
// Matches a `@token` immediately before the cursor (token = letters/digits/_,
// no whitespace). Unicode-aware so non-ASCII names trigger the picker too.
const TRIGGER_RE = /(^|\s)@([\p{L}\p{N}_]*)$/u;

/**
 * A textarea with lightweight @mention autocomplete for plain-text inputs
 * (messages, task notes). Typing `@` opens a firm-member picker; selecting a
 * member inserts `@Full Name` and records their id. The reported mention ids are
 * exactly the selected members whose `@Name` text still appears, so deleting the
 * inserted text drops the mention. The text stored stays plain (the `@Name`
 * literal); ids are sent alongside it to drive notifications.
 */
export default function MentionTextarea({
  value,
  onChange,
  onMentionsChange,
  members,
  placeholder,
  disabled,
  rows = 1,
  className = "",
  style,
  onEnter,
  textareaRef,
  ...fieldAttributes
}: MentionTextareaProps) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? internalRef;

  // Members the user explicitly picked, by id. Kept in a ref so it survives
  // re-renders without re-triggering effects.
  const selectedRef = useRef<Map<string, string>>(new Map());

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const tokenStartRef = useRef<number>(-1);

  const suggestions = useMemo(() => {
    if (!open) return [];
    const q = query.toLowerCase();
    return members
      .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [open, query, members]);

  // Keep the suggestion popup mounted through its close animation, showing the
  // rows it had when it closed. `suggestions` empties the moment the popup is
  // dismissed, so rendering it live would collapse the popup to nothing and fade
  // out an empty box instead of the list the user just picked from.
  const showSuggestions = open && suggestions.length > 0;
  const { mounted: popupMounted, exiting: popupExiting } = useMountTransition(showSuggestions, 150);
  const popupRows = useLastOpenValue(showSuggestions, suggestions);

  // Recompute which selected members are still present in the text and report.
  const reportMentions = (text: string) => {
    if (!onMentionsChange) return;
    const ids: string[] = [];
    selectedRef.current.forEach((name, id) => {
      if (text.includes(`@${name}`)) ids.push(id);
    });
    onMentionsChange(Array.from(new Set(ids)));
  };

  const detectTrigger = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = before.match(TRIGGER_RE);
    if (m && members.length) {
      setQuery(m[2]);
      tokenStartRef.current = caret - m[2].length - 1; // index of the '@'
      setActiveIndex(0);
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    onChange(text);
    detectTrigger(text, e.target.selectionStart ?? text.length);
    reportMentions(text);
  };

  const selectMember = (member: FirmMember) => {
    const el = ref.current;
    const text = value;
    const caret = el?.selectionStart ?? text.length;
    const start = tokenStartRef.current;
    if (start < 0) return;
    const inserted = `@${member.name} `;
    const next = text.slice(0, start) + inserted + text.slice(caret);
    selectedRef.current.set(member.id, member.name);
    onChange(next);
    setOpen(false);
    reportMentions(next);
    // Restore focus + place the caret right after the inserted mention.
    const newCaret = start + inserted.length;
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(newCaret, newCaret);
      }
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && suggestions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMember(suggestions[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };

  // Keep reported mentions in sync if the value is cleared/reset externally
  // (e.g. after sending a message).
  useEffect(() => {
    if (value === "") {
      selectedRef.current.clear();
      onMentionsChange?.([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative flex-1 min-w-0">
      {popupMounted && (
        <div className={`absolute bottom-full mb-1 left-0 z-50 w-64 max-h-56 overflow-y-auto overflow-x-hidden styled-scrollbar rounded-lg border border-outline bg-surface shadow-xl origin-bottom ${menuAnim(popupExiting)}`}>
          {popupRows.map((m, i) => (
            <button
              key={m.id}
              type="button"
              // onMouseDown (not onClick) so selection fires before the textarea blurs.
              onMouseDown={(e) => { e.preventDefault(); selectMember(m); }}
              className={`w-full text-left px-3 py-2 cursor-pointer flex items-center gap-2.5 ${i === activeIndex ? "bg-surface-hover" : "hover:bg-surface-hover"}`}
            >
              <Avatar size="sm" photoUrl={m.photoUrl} name={m.name} email={m.email} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-on-surface truncate">{m.name}</span>
                {m.email && <span className="block text-xs text-on-surface-muted truncate">{m.email}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        {...fieldAttributes}
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={className}
        style={style}
      />
    </div>
  );
}
