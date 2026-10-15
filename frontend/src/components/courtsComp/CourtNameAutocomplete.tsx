"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import catalogService, { type CatalogCourt } from "@/services/catalog.service";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import useAnchoredMenuPosition from "@/hooks/useAnchoredMenuPosition";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSelect: (court: CatalogCourt) => void;
  lawFirmId?: string;
  containerClassName?: string;
  className?: string;
  disabled?: boolean;
}

export const formatCourtCatalogValue = (value?: string | null) =>
  (value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const directoryDetail = (court: CatalogCourt) =>
  [court.citationAbbrev || court.shortName, court.state, formatCourtCatalogValue(court.courtType)]
    .filter(Boolean)
    .join(" · ");

/** Court-name input with debounced suggestions from the global court directory. */
export default function CourtNameAutocomplete({
  value,
  onChange,
  onSelect,
  lawFirmId,
  containerClassName = "flex-1 min-w-0",
  className = "",
  disabled = false,
}: Props) {
  const params = useParams();
  const routeFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string | undefined);
  const firmId = lawFirmId || routeFirmId;
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<CatalogCourt[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Outcome of the last finished search, so an empty or failed answer can say so
  // instead of closing the menu and leaving the field looking broken.
  const [outcome, setOutcome] = useState<"none" | "empty" | "failed">("none");
  const query = value.trim();

  useEffect(() => {
    if (!focused || !firmId || query.length < 2) return;

    const currentRequest = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await catalogService.searchCourts(firmId, { search: query, limit: 8 });
        if (currentRequest !== requestId.current) return;
        const found = response.items || [];
        setItems(found);
        setOutcome(found.length ? "none" : "empty");
        setActiveIndex(-1);
      } catch {
        if (currentRequest === requestId.current) {
          setItems([]);
          setOutcome("failed");
        }
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // Depends on `value`, not the trimmed `query`: a keystroke that only adds
    // or removes leading/trailing whitespace leaves `query` unchanged, so a
    // dependency on `query` would skip the refetch that undoes the items
    // `handleChange` just cleared for that same keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmId, focused, value]);

  const choose = (court: CatalogCourt) => {
    onSelect(court);
    setItems([]);
    setFocused(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  };

  const handleChange = (nextValue: string) => {
    requestId.current += 1;
    setItems([]);
    setOutcome("none");
    setLoading(false);
    setActiveIndex(-1);
    onChange(nextValue);
  };

  const handleBlur = () => {
    requestId.current += 1;
    setFocused(false);
    setItems([]);
    setOutcome("none");
    setLoading(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setItems([]);
      setOutcome("none");
      setActiveIndex(-1);
      return;
    }
    if (!items.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? items.length - 1 : current - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      choose(items[activeIndex]);
    }
  };

  const showMenu =
    focused && query.length >= 2 && (loading || items.length > 0 || outcome !== "none");

  // The menu renders in a body portal so a settings panel's `overflow-hidden`
  // cannot clip it. 44px per two-line row, capped at the max-h-56 (224px) list.
  const menuPos = useAnchoredMenuPosition({
    open: showMenu,
    anchorRef: inputRef,
    menuRef: listRef,
    estimatedHeight: Math.min(224, Math.max(1, items.length) * 44 + 8),
    deps: [items.length, loading, outcome],
  });

  return (
    <div className={`relative ${containerClassName}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="Court name"
        aria-label="Court name"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listboxId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={disabled}
        className={`w-full ${className}`}
      />
      {showMenu && menuPos && typeof document !== "undefined" && createPortal(
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          onMouseLeave={() => setActiveIndex(-1)}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          className="z-[60] max-h-56 min-w-72 overflow-auto rounded-md border border-outline bg-surface py-1 shadow-lg styled-scrollbar"
        >
          {loading ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">Searching court directory…</li>
          ) : outcome === "empty" ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">
              No match in the court directory. You can still add it by name.
            </li>
          ) : outcome === "failed" ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">
              Could not search the court directory. You can still add it by name.
            </li>
          ) : (
            items.map((court, index) => (
              <li
                key={court.id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(court)}
                className={`cursor-pointer px-3 py-2 ${index === activeIndex ? "bg-surface-hover" : ""}`}
              >
                <div className="truncate text-xs font-medium text-on-surface">{court.fullName}</div>
                {directoryDetail(court) && (
                  <div className="truncate text-[11px] text-on-surface-secondary">{directoryDetail(court)}</div>
                )}
              </li>
            ))
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
