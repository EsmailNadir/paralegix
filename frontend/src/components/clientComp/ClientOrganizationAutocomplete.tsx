"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clientsService, { type LookupItem } from "@/services/clients.service";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import useAnchoredMenuPosition from "@/hooks/useAnchoredMenuPosition";

interface Props {
  id?: string;
  maxLength?: number;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Fires when an existing company client is picked from the suggestions. */
  onSelectCompany?: (company: LookupItem) => void;
  lawFirmId: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Organization input with debounced suggestions drawn from the firm's own
 * company clients. Picking a suggestion fills the field with that company's
 * exact name, so it matches the client detail page's "linked company client"
 * lookup (an exact, case-insensitive name match), the same free-text linking
 * `useClientsAtOrganization` already uses for person-to-person colleagues.
 */
export default function ClientOrganizationAutocomplete({
  id,
  maxLength,
  placeholder = "Company / Org",
  value,
  onChange,
  onSelectCompany,
  lawFirmId,
  className = "",
  disabled = false,
}: Props) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [items, setItems] = useState<LookupItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = value.trim();

  useEffect(() => {
    if (!focused || !lawFirmId || query.length < 2) return;

    const currentRequest = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await clientsService.lookupClients(lawFirmId, {
          search: query,
          clientType: "company",
          excludeArchived: true,
          limit: 8,
        });
        if (currentRequest !== requestId.current) return;
        setItems(response.items || []);
        setHasSearched(true);
        setSearchFailed(false);
        setActiveIndex(-1);
      } catch {
        if (currentRequest === requestId.current) {
          setItems([]);
          setHasSearched(true);
          setSearchFailed(true);
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
  }, [lawFirmId, focused, value]);

  const choose = (company: LookupItem) => {
    onChange(company.label);
    onSelectCompany?.(company);
    setItems([]);
    setHasSearched(false);
    setSearchFailed(false);
    setFocused(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  };

  const handleChange = (nextValue: string) => {
    requestId.current += 1;
    setItems([]);
    setHasSearched(false);
    setSearchFailed(false);
    setLoading(false);
    setActiveIndex(-1);
    onChange(nextValue);
  };

  const handleBlur = () => {
    requestId.current += 1;
    setFocused(false);
    setItems([]);
    setHasSearched(false);
    setSearchFailed(false);
    setLoading(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (!loading && !hasSearched) return;
      event.preventDefault();
      event.stopPropagation();
      requestId.current += 1;
      setItems([]);
      setHasSearched(false);
      setSearchFailed(false);
      setLoading(false);
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

  const showMenu = focused && query.length >= 2 && (loading || hasSearched);

  // Rendered in a body portal so a modal body or `Card` cannot clip it.
  const menuPos = useAnchoredMenuPosition({
    open: showMenu,
    anchorRef: inputRef,
    menuRef: listRef,
    estimatedHeight: Math.min(224, Math.max(1, items.length) * 32 + 8),
    deps: [items.length, loading],
  });

  return (
    <div className="relative">
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label="Organization"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listboxId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={disabled}
        className={`${FULL_INPUT_CLS} ${className}`}
      />
      {showMenu && menuPos && typeof document !== "undefined" && createPortal(
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          onMouseLeave={() => setActiveIndex(-1)}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          className="z-[60] max-h-56 overflow-auto rounded-md border border-outline bg-surface py-1 shadow-lg styled-scrollbar"
        >
          {loading ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">Searching organizations…</li>
          ) : searchFailed ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">Could not search organizations. Try again.</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-on-surface-secondary">No matching organizations found.</li>
          ) : (
            items.map((company, index) => (
              <li
                key={company.id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(company)}
                className={`cursor-pointer px-3 py-2 ${index === activeIndex ? "bg-surface-hover" : ""}`}
              >
                <div className="truncate text-xs font-medium text-on-surface">{company.label}</div>
              </li>
            ))
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
