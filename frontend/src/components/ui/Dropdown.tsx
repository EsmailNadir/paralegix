"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { selectMenuAnim } from "@/components/ui/transitionClasses";
import Spinner from "@/components/ui/Spinner";
import useAnchoredMenuPosition from "@/hooks/useAnchoredMenuPosition";
import { DROPDOWN_MAX_RENDERED, DROPDOWN_SEARCH_THRESHOLD } from "@/lib/constants/search";

export interface DropdownOption {
  label: string;
  value: string;
  /** Tailwind fill class (e.g. "bg-blue-500") for a leading color dot. */
  dotClassName?: string;
  /**
   * Inline hex color for a leading dot, for options whose color comes from
   * per-firm data (e.g. a custom matter/lead stage color) rather than a fixed
   * Tailwind palette. Takes precedence over `dotClassName` when both are set.
   */
  dotColor?: string;
  /**
   * Leading icon shown before the label, for a list mixing option kinds that
   * need a stronger marker than a color dot (e.g. a company recipient among
   * person recipients in a signer picker). Takes precedence over
   * `dotClassName`/`dotColor` when set.
   */
  icon?: LucideIcon;
}

interface DropdownOptionRowProps {
  option: DropdownOption;
  index: number;
  id: string;
  selected: boolean;
  active: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

/**
 * One option row. Memoized because the menu tracks its keyboard/hover position
 * in state: without this, moving the mouse across a long list re-renders every
 * row on every pointer move. With it, only the two rows whose `active` value
 * actually changed re-render.
 */
const DropdownOptionRow = memo(function DropdownOptionRow({
  option,
  index,
  id,
  selected,
  active,
  onSelect,
  onHover,
}: DropdownOptionRowProps) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(event) => {
        // Keep any active editor selection intact while choosing an option.
        event.preventDefault();
      }}
      onClick={(event) => {
        // Filter rows wrap this dropdown in a <label>. A click on a non-interactive
        // descendant of a label is forwarded by the browser to the labelled control,
        // here the trigger button, which would immediately reopen the menu that
        // selecting an option just closed. Cancelling the click stops that forwarding.
        event.preventDefault();
        event.stopPropagation();
        onSelect(index);
      }}
      className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${active ? "bg-surface-hover" : ""} ${
        selected
          ? "bg-blue-50 text-blue-700 dark:bg-surface-hover dark:text-on-surface"
          : "text-on-surface"
      }`}
    >
      {option.icon ? (
        <option.icon className="size-3.5 shrink-0 text-on-surface-muted" />
      ) : option.dotColor ? (
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: option.dotColor }} />
      ) : (
        option.dotClassName && <span className={`size-1.5 shrink-0 rounded-full ${option.dotClassName}`} />
      )}
      <span className="truncate">{option.label}</span>
    </li>
  );
});

type DropdownProps =
  | (DropdownBaseProps & {
      disabled: true;
      onChange?: (value: string) => void;
    })
  | (DropdownBaseProps & {
      disabled?: false;
      onChange: (value: string) => void;
    });

interface DropdownBaseProps {
  name?: string;
  ariaRequired?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  label?: string;
  value: string;
  options: DropdownOption[];
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  /**
   * Icon rendered inside the trigger, left of the value. Purely decorative, so
   * it is hidden from assistive tech and ignores pointer events.
   */
  leading?: ReactNode;
  labelClassName?: string;
  listClassName?: string;
  title?: string;
  ariaLabel?: string;
  /**
   * Id of a visible `<label>` rendered by the CALLER rather than by this
   * component's own `label` prop. Same purpose and same precedence as
   * `DatePicker.ariaLabelledBy`: the trigger is a button, so a caller's
   * `<label htmlFor>` has nothing to bind to.
   */
  ariaLabelledBy?: string;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  /**
   * Render the menu in a document.body portal (fixed-positioned to the button)
   * so a scrolling or clipping ancestor (a modal, a `Card`, any
   * `overflow-hidden` panel) cannot cut it off. On by default; pass
   * `portal={false}` only where the menu must scroll with an inner container.
   */
  portal?: boolean;
  /** Gap in px between the button and the portal menu. Portal mode only. */
  menuOffset?: number;
  /**
   * Whether the menu offers a filter input. "auto" (the default) turns it on
   * once the option count passes DROPDOWN_SEARCH_THRESHOLD.
   */
  searchable?: boolean | "auto";
  /** Placeholder for the filter input. */
  searchPlaceholder?: string;
  /**
   * Controlled search. When `onSearchChange` is supplied the menu stops
   * filtering `options` itself and just reports what was typed, so a parent can
   * fetch matches from the server.
   */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Notifies the parent when the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Shows a loading row in place of "No matches" while results are in flight. */
  loading?: boolean;
  /** Controlled server search: hide stale placeholder results while loading. */
  clearOptionsWhileLoading?: boolean;
  /**
   * A save kicked off by the last selection is still in flight. Swaps the
   * trigger's chevron for a spinner and blocks further selections until it
   * settles, so a dropdown that writes straight to the server on change does
   * not look frozen. Distinct from `loading`, which is about fetching options.
   */
  busy?: boolean;
  /** Muted note pinned under the option list. */
  footerNote?: string;
}

export default function Dropdown({
  label,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "",
  buttonClassName = "",
  leading,
  labelClassName = "",
  listClassName = "",
  title,
  ariaLabel,
  ariaLabelledBy,
  name,
  ariaRequired,
  ariaInvalid,
  ariaDescribedBy,
  onMouseDown,
  portal = true,
  menuOffset = 4,
  searchable = "auto",
  searchPlaceholder = "Search…",
  searchValue,
  onSearchChange,
  onOpenChange,
  loading = false,
  clearOptionsWhileLoading = false,
  busy = false,
  footerNote,
}: DropdownProps) {
  // A selection being saved locks the trigger exactly like `disabled` does, but
  // the two are kept apart so the spinner only shows for the in-flight case.
  const locked = disabled || busy;
  const [open, setOpenState] = useState(false);
  // Index of the keyboard-focused option within `visibleOptions` (the filtered,
  // capped list actually in the DOM), tracked via aria-activedescendant.
  // -1 means no option is active yet.
  const [activeIndex, setActiveIndex] = useState(-1);
  const [filter, setFilter] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // A parent that handles the search owns the matching too, so the local filter
  // steps aside entirely.
  const searchControlled = typeof onSearchChange === "function";

  // Kept in a ref so `setOpen` can stay referentially stable, which in turn
  // keeps the memoized keyboard handlers from re-creating on every render.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const openRef = useRef(false);
  const setOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(openRef.current) : next;
    if (value === openRef.current) return;
    openRef.current = value;
    setOpenState(value);
    onOpenChangeRef.current?.(value);
  }, []);

  const showSearch =
    searchControlled ||
    searchable === true ||
    (searchable === "auto" && options.length > DROPDOWN_SEARCH_THRESHOLD);

  const searchText = searchControlled ? searchValue ?? "" : filter;

  // Options after the local filter. `current` is resolved against the full
  // `options` list (below), so filtering never blanks the trigger's label.
  // Under controlled search `options` already IS the match list the parent
  // fetched, so filtering it again here would hide server results whose label
  // does not literally contain the typed term.
  const matches = useMemo(() => {
    if (searchControlled && loading && clearOptionsWhileLoading) return [];
    if (searchControlled) return options;
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, filter, searchControlled, loading, clearOptionsWhileLoading]);

  // Only this slice goes into the DOM. The remainder is surfaced as a count so
  // a long list stays responsive without silently hiding results.
  const visibleOptions = useMemo(() => matches.slice(0, DROPDOWN_MAX_RENDERED), [matches]);
  const hiddenCount = matches.length - visibleOptions.length;

  // Read by `selectOption` at click time rather than closed over, so that
  // callback stays referentially stable while the list changes. Filtering
  // rebuilds `visibleOptions` on every keystroke; a callback that depended on
  // it would take a new identity each time and re-render all 100 memoized rows
  // per character, including the keystrokes that leave the visible slice
  // untouched.
  const visibleOptionsRef = useRef(visibleOptions);
  visibleOptionsRef.current = visibleOptions;

  const current = options.find((o) => o.value === value);
  // What the menu is on screen for. Distinct from `open`, which stays true while
  // a selection saves: the menu is already gone by then.
  const menuOpen = open && !locked;
  const { mounted, exiting } = useMountTransition(menuOpen, 150);

  // Everything the menu shows is frozen at the moment it closes, because a
  // selection changes all of it while the menu is still on screen playing its
  // exit animation: the picked row takes the selected highlight, a
  // server-backed parent clears the search state it was told to reset on close,
  // and its option list re-sorts once the selection resolves. Left live, the
  // user watches the list rewrite and re-order itself under the cursor for the
  // length of the fade. Only the rendered menu reads this; the open menu's
  // behaviour (keyboard, positioning, selection) reads the live values.
  const menuView = useLastOpenValue(menuOpen, {
    options: visibleOptions,
    hiddenCount,
    searchText,
    loading,
    footerNote,
    value,
    activeIndex,
  });

  // Stable base for per-option ids so the trigger can point at the active
  // option through aria-activedescendant.
  const baseId = useId();
  // Memoized on `baseId` so the scroll-into-view effect below can depend on it
  // without re-running on every render.
  const optionId = useCallback((index: number) => `${baseId}-option-${index}`, [baseId]);
  // The trigger is a button, not a native select, so the visible label has to be
  // pointed at rather than associated with `for`: `aria-labelledby` names the
  // control without the click-forwarding a `for` would add, which on a listbox
  // trigger would open the menu from a stray label click.
  //
  // It lists the label AND the button, in that order, so the accessible name is
  // "Type Deposit" rather than just "Type". A button whose content IS the
  // current value loses that value from its name if the label alone is pointed
  // at, and a screen-reader user is then told what the field is called but not
  // what it says.
  const labelId = `${baseId}-label`;
  const triggerId = `${baseId}-trigger`;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, setOpen]);

  // Portal mode: the fixed-positioned menu sits flush under the button and flips
  // above it when there is no room below. Before the menu mounts, its height is
  // estimated (capped at the max-h-60 = 240px menu) including the sticky filter
  // header when present, so the open-up/open-down choice doesn't flip once the
  // menu measures.
  const menuPos = useAnchoredMenuPosition({
    open: open && portal,
    anchorRef: btnRef,
    menuRef: listRef,
    estimatedHeight: Math.min(240, visibleOptions.length * 34 + 8 + (showSearch ? 44 : 0)),
    offset: menuOffset,
    deps: [visibleOptions.length, showSearch],
  });

  // When the menu opens, start the active option on the current selection (or
  // the first option). Reset to -1 once closed so the next open re-seeds.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the keyboard active option and filter when the menu closes so the next open re-seeds
      setActiveIndex(-1);
      setFilter("");
      return;
    }
    const selectedIndex = visibleOptions.findIndex((o) => o.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : visibleOptions.length > 0 ? 0 : -1);
  }, [open, value, visibleOptions]);

  // Put the caret in the filter input as soon as the menu opens, so a long
  // list can be narrowed without an extra click. Done through a callback ref
  // rather than an effect because the menu mounts a render after `open` flips
  // (and later still in portal mode, which waits on its first measurement), so
  // an effect keyed on `open` would run while the input is not in the DOM yet.
  const focusSearch = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
  }, []);

  // Keep the active option scrolled into view as it changes via the keyboard.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLLIElement>(`#${CSS.escape(optionId(activeIndex))}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, optionId]);

  const selectOption = useCallback(
    (index: number) => {
      const opt = visibleOptionsRef.current[index];
      if (!opt) return;
      onChange?.(opt.value);
      setOpen(false);
    },
    [onChange, setOpen]
  );

  const handleHover = useCallback((index: number) => setActiveIndex(index), []);

  // The ARIA listbox key model for an already-open menu: move with
  // arrows/Home/End, commit with Enter (and Space from the trigger), dismiss
  // with Escape. Shared by the trigger button and the filter input so both
  // drive the same list; the input opts out of Space-to-commit because a space
  // is a legitimate search character there.
  const handleOpenMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, spaceSelects: boolean) => {
      const count = visibleOptions.length;
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (count === 0) return;
          setActiveIndex((i) => (i < 0 ? 0 : Math.min(i + 1, count - 1)));
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (count === 0) return;
          setActiveIndex((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
          break;
        }
        case "Home": {
          e.preventDefault();
          if (count > 0) setActiveIndex(0);
          break;
        }
        case "End": {
          e.preventDefault();
          if (count > 0) setActiveIndex(count - 1);
          break;
        }
        case " ": {
          if (!spaceSelects) break;
          e.preventDefault();
          if (activeIndex >= 0) selectOption(activeIndex);
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (activeIndex >= 0) selectOption(activeIndex);
          break;
        }
        case "Escape": {
          e.preventDefault();
          setOpen(false);
          btnRef.current?.focus();
          break;
        }
        case "Tab": {
          // Allow focus to leave, but hand it back to the trigger first. The
          // filter input is auto-focused on open, and in portal mode it lives
          // in a node appended to the end of <body>, so tabbing straight out of
          // it would resume document order from there instead of from the
          // trigger (escaping an enclosing modal's focus trap). Close after, so
          // the menu doesn't linger detached.
          btnRef.current?.focus();
          setOpen(false);
          break;
        }
        default:
          break;
      }
    },
    [visibleOptions.length, activeIndex, selectOption, setOpen]
  );

  // Opening keys live on the trigger; once open it defers to the shared model.
  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked) return;
    const key = e.key;

    if (!open) {
      if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    handleOpenMenuKeyDown(e, /* spaceSelects */ true);
  };

  return (
    <div className={className || "w-full"}>
      {label && (
        <label
          id={labelId}
          className={`block text-sm font-medium text-on-surface mb-1 ${labelClassName}`}
        >
          {label}
        </label>
      )}

      <div className="relative">
        <button
          ref={btnRef}
          type="button"
          disabled={locked}
          aria-busy={busy || undefined}
          title={title}
          aria-label={ariaLabel}
          // Only when nothing more specific was given: an explicit `ariaLabel`
          // is the caller saying the visible text is not the whole name.
          id={triggerId}
          name={name}
          aria-required={ariaRequired}
          aria-invalid={ariaInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          aria-labelledby={
            ariaLabel
              ? undefined
              : label
                ? `${labelId} ${triggerId}`
                : ariaLabelledBy
                  ? `${ariaLabelledBy} ${triggerId}`
                  : undefined
          }
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${baseId}-listbox` : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          onMouseDown={onMouseDown}
          onKeyDown={onTriggerKeyDown}
          onClick={() => !locked && setOpen((s) => !s)}
          className={`w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
            locked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
          } ${buttonClassName}`}
        >
          {leading ? (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-on-surface-muted"
            >
              {leading}
            </span>
          ) : null}
          <span
            className={`flex min-w-0 items-center gap-2 ${leading ? "pl-6" : ""} ${
              current ? "text-on-surface" : "text-on-surface-muted"
            }`}
          >
            {current?.dotColor ? (
              <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: current.dotColor }} />
            ) : (
              current?.dotClassName && <span className={`size-1.5 shrink-0 rounded-full ${current.dotClassName}`} />
            )}
            <span className="truncate">{current ? current.label : placeholder}</span>
          </span>
          <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-on-surface-muted">
            {busy ? (
              <Spinner size={14} />
            ) : (
              "▾"
            )}
          </span>
        </button>

        {mounted && (() => {
          const optionItems = (
            <>
              {/*
                The filter, empty-state, and overflow rows are structural, not
                selectable. role="presentation" drops their implicit listitem
                role so a listbox only owns `option` children and assistive
                tech counts the options correctly.
              */}
              {showSearch && (
                <li
                  role="presentation"
                  className="sticky top-0 z-10 bg-surface border-b border-outline-subtle p-2"
                >
                  <input
                    ref={focusSearch}
                    type="search"
                    value={menuView.searchText}
                    aria-controls={`${baseId}-listbox`}
                    aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                    onChange={(e) =>
                      searchControlled ? onSearchChange?.(e.target.value) : setFilter(e.target.value)
                    }
                    onKeyDown={(e) => handleOpenMenuKeyDown(e, /* spaceSelects */ false)}
                    placeholder={searchPlaceholder}
                    className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </li>
              )}
              {menuView.options.length === 0 && (
                <li role="presentation" className="px-3 py-1.5 text-sm text-on-surface-secondary">
                  {menuView.loading ? "Searching…" : menuView.searchText.trim() ? "No matches" : "No options"}
                </li>
              )}
              {menuView.options.map((opt, index) => (
                <DropdownOptionRow
                  key={opt.value || `option-${index}`}
                  option={opt}
                  index={index}
                  id={optionId(index)}
                  selected={opt.value === menuView.value}
                  active={index === menuView.activeIndex}
                  onSelect={selectOption}
                  onHover={handleHover}
                />
              ))}
              {/*
                A caller-supplied note replaces the hidden-count row: when the
                server truncated the result set, the local count is meaningless.
              */}
              {menuView.footerNote ? (
                <li
                  role="presentation"
                  className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle"
                >
                  {menuView.footerNote}
                </li>
              ) : (
                menuView.hiddenCount > 0 && (
                  <li
                    role="presentation"
                    className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle"
                  >
                    {menuView.hiddenCount} more. Keep typing to narrow.
                  </li>
                )
              )}
            </>
          );

          if (portal) {
            // Wait for the first position measurement so the menu doesn't flash
            // at (0,0) before the rect is read.
            if (!menuPos) return null;
            return createPortal(
              <ul
                ref={listRef}
                id={`${baseId}-listbox`}
                role="listbox"
                tabIndex={-1}
                onMouseLeave={() => setActiveIndex(-1)}
                style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
                className={`z-[60] max-h-60 overflow-auto rounded-md border border-outline bg-surface shadow-lg styled-scrollbar origin-top ${selectMenuAnim(exiting)} ${listClassName}`}
              >
                {optionItems}
              </ul>,
              document.body
            );
          }

          return (
            <ul
              ref={listRef}
              id={`${baseId}-listbox`}
              role="listbox"
              tabIndex={-1}
              onMouseLeave={() => setActiveIndex(-1)}
              className={`absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-outline bg-surface shadow-lg styled-scrollbar origin-top ${selectMenuAnim(exiting)} ${listClassName}`}
            >
              {optionItems}
            </ul>
          );
        })()}
      </div>
    </div>
  );
}
