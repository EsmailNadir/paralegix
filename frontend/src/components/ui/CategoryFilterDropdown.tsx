"use client";

import { useState, useEffect, useRef, useCallback, useId } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import MattersService from "@/services/matters.service";
import { useMountTransition, useResetAfterClose } from "@/hooks/useMountTransition";
import { selectMenuAnim } from "@/components/ui/transitionClasses";
import Spinner from "@/components/ui/Spinner";
import type { Category } from "@/types";
import FieldLabel from "@/components/ui/FieldLabel";

interface CategoryFilterDropdownProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  lawFirmId: string;
  className?: string;
}

export default function CategoryFilterDropdown({
  label,
  value,
  onChange,
  placeholder = "All Categories",
  disabled = false,
  lawFirmId,
  className = "",
}: CategoryFilterDropdownProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [flatCategories, setFlatCategories] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const { mounted, exiting } = useMountTransition(open && !disabled, 150);
  // Clear the search once the menu has animated away. Clearing it as the menu
  // closes re-expands the full tree inside the fading list.
  useResetAfterClose(open, () => setSearchTerm(""));

  // Build tree structure from flat list
  const buildTree = useCallback((flatList: Category[]): Category[] => {
    const categoryMap = new Map<string, Category>();
    const rootCategories: Category[] = [];

    // First pass: create all category objects
    flatList.forEach(cat => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });

    // Second pass: build tree structure
    categoryMap.forEach(category => {
      if (category.parentId && categoryMap.has(category.parentId)) {
        const parent = categoryMap.get(category.parentId)!;
        parent.children = parent.children || [];
        parent.children.push(category);
      } else {
        rootCategories.push(category);
      }
    });

    // Sort recursively
    const sortTree = (cats: Category[]) => {
      cats.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });
      cats.forEach(cat => {
        if (cat.children && cat.children.length > 0) {
          sortTree(cat.children);
        }
      });
    };

    sortTree(rootCategories);
    return rootCategories;
  }, []);

  // Filter tree recursively - keeps hierarchy but only shows matching items and their parents
  const filterTree = useCallback((cats: Category[], search: string): Category[] => {
    if (!search.trim()) return cats;

    const searchLower = search.toLowerCase();
    const matchesSearch = (cat: Category): boolean =>
      cat.name.toLowerCase().includes(searchLower) || cat.path.toLowerCase().includes(searchLower);

    const filterRecursive = (items: Category[]): Category[] =>
      items
        .map((cat): Category | null => {
          const matches = matchesSearch(cat);
          const filteredChildren = cat.children && cat.children.length > 0 ? filterRecursive(cat.children) : [];
          if (matches || filteredChildren.length > 0) {
            return { ...cat, children: filteredChildren };
          }
          return null;
        })
        .filter((cat): cat is Category => cat !== null);

    return filterRecursive(cats);
  }, []);

  // Load categories
  useEffect(() => {
    const loadCategories = async () => {
      if (!lawFirmId) return;

      try {
        setIsLoading(true);
        const flatList = await MattersService.listCategories(lawFirmId);
        setFlatCategories(flatList);
        setCategories(buildTree(flatList));
      } catch (error) {
        console.error('Failed to load categories:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadCategories();
  }, [lawFirmId, buildTree]);

  // Find selected category
  const selectedCategory = flatCategories.find(cat => cat.path === value);

  // Opening the menu with an existing selection should show it in context
  // rather than making the user hunt through a collapsed tree for it.
  useEffect(() => {
    if (!open || !value) return;
    const selected = flatCategories.find(cat => cat.path === value);
    if (!selected) return;
    const ancestorIds = new Set<string>();
    let current: Category | undefined = selected;
    while (current) {
      ancestorIds.add(current.id);
      const parentId: string | null = current.parentId;
      current = parentId ? flatCategories.find(cat => cat.id === parentId) : undefined;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- expands the selection's ancestor chain each time the menu opens
    setExpandedCategories(prev => {
      const next = new Set(prev);
      ancestorIds.forEach(id => next.add(id));
      return next;
    });
  }, [open, value, flatCategories]);

  const toggleExpand = useCallback((categoryId: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);

  // While searching, every branch left standing by filterTree is relevant, so
  // show it fully expanded instead of making the user also expand it by hand.
  const isCategoryExpanded = useCallback(
    (categoryId: string) => (searchTerm.trim() ? true : expandedCategories.has(categoryId)),
    [searchTerm, expandedCategories]
  );

  const filteredCategories = searchTerm.trim() ? filterTree(categories, searchTerm) : categories;

  // Render category tree item
  const renderCategoryItem = useCallback((category: Category, depth: number = 0): JSX.Element[] => {
    const indent = depth * 16;
    const isSelected = value === category.path;
    const hasChildren = !!category.children && category.children.length > 0;
    const isExpanded = isCategoryExpanded(category.id);

    const items: JSX.Element[] = [
      <li
        key={category.id}
        role="option"
        aria-selected={isSelected}
        className={`flex items-center transition-colors ${
          isSelected
            ? "bg-blue-50 text-blue-700 dark:bg-surface-hover dark:text-on-surface"
            : "text-on-surface hover:bg-surface-hover"
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand(category.id);
          }}
          className={`flex h-8 w-7 flex-shrink-0 items-center justify-center text-on-surface-muted transition-colors hover:text-on-surface-secondary ${
            !hasChildren ? "invisible" : ""
          }`}
          style={{ marginLeft: `${indent}px` }}
        >
          {hasChildren && (
            <ChevronRight size={14} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            onChange(category.path);
            setOpen(false);
          }}
          className="min-w-0 flex-1 truncate py-1.5 pr-3 text-left text-sm cursor-pointer"
        >
          {category.name}
        </button>
      </li>
    ];

    // Add children
    if (hasChildren && isExpanded) {
      category.children!.forEach(child => {
        items.push(...renderCategoryItem(child, depth + 1));
      });
    }

    return items;
  }, [value, onChange, isCategoryExpanded, toggleExpand]);

  // Handle click outside
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
  }, [open]);

  // Track the button's viewport rect so the fixed-positioned portal menu sits
  // flush under it and follows it on scroll/resize while open. When there
  // isn't room below (e.g. the button sits near the bottom of the viewport),
  // flip the menu above the button so it isn't clipped off-screen.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      // Prefer the rendered menu's real height; fall back to an estimate on
      // the first pass before it has mounted (capped at the max-h-60 = 240px
      // menu, plus the 44px search bar). A flat `240` guess (rather than one
      // scaled to the actual row count, as Dropdown.tsx does) made a short
      // tree's menu jump position once the real height measured in, which
      // showed up as a visibly different open animation from the other
      // filter dropdowns.
      const itemCount = 1 + flatCategories.length; // "All Categories" + every category row
      const menuH = listRef.current?.offsetHeight ?? Math.min(240, itemCount * 34 + 8 + 44);
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < menuH + 8 && r.top > spaceBelow;
      setMenuPos({
        top: openUp ? Math.max(8, r.top - menuH - 4) : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    };
    update();
    // Refine once the menu has actually rendered and we can measure its height.
    const raf = requestAnimationFrame(update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, flatCategories.length]);

  // Put the caret in the search input as soon as the menu opens, so a long
  // list can be narrowed without an extra click.
  const focusSearch = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
  }, []);

  // The trigger is a button, so the visible label is pointed at with
  // `aria-labelledby` rather than associated with `for`. See Dropdown.tsx.
  const labelId = useId();

  return (
    <div className={`w-full ${className}`}>
      {label && (
        <FieldLabel id={labelId}>{label}</FieldLabel>
      )}

      <div className="relative">
        <button
          ref={btnRef}
          type="button"
          disabled={disabled}
          aria-busy={isLoading || undefined}
          aria-labelledby={label ? labelId : undefined}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => !disabled && setOpen((s) => !s)}
          className={`w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
            disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
          }`}
        >
          <span className={`flex min-w-0 items-center gap-1 pr-4 ${selectedCategory || !value ? "text-on-surface" : "text-on-surface-muted"}`}>
            {selectedCategory ? (
              selectedCategory.path.split(" > ").map((part, index, parts) => {
                const isLast = index === parts.length - 1;
                return (
                  <span key={index} className={`flex items-center gap-1 ${isLast ? "min-w-0 flex-1" : "shrink-0"}`}>
                    <span
                      className={`rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-accent-emphasis ${
                        isLast ? "block truncate" : ""
                      }`}
                    >
                      {part}
                    </span>
                    {!isLast && <ChevronRight size={12} className="shrink-0 text-on-surface-muted" />}
                  </span>
                );
              })
            ) : (
              <span className="truncate">{value || placeholder}</span>
            )}
          </span>
          <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-on-surface-muted">
            {isLoading ? <Spinner size={14} /> : "▾"}
          </span>
        </button>

        {mounted && menuPos && createPortal(
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            className={`z-[9999] max-h-72 overflow-auto rounded-md border border-outline bg-surface shadow-lg styled-scrollbar origin-top ${selectMenuAnim(exiting)}`}
          >
            <li role="presentation" className="sticky top-0 z-10 bg-surface border-b border-outline-subtle p-2">
              <input
                ref={focusSearch}
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search categories…"
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </li>

            {isLoading ? (
              <li role="presentation" className="px-3 py-1.5 text-sm text-on-surface-secondary">
                Loading categories…
              </li>
            ) : (
              <>
                <li
                  role="option"
                  aria-selected={!value}
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                  className={`px-3 py-1.5 text-sm hover:bg-surface-hover cursor-pointer transition-colors ${
                    !value
                      ? "bg-blue-50 text-blue-700 dark:bg-surface-hover dark:text-on-surface"
                      : "text-on-surface"
                  }`}
                >
                  All Categories
                </li>
                {categories.length === 0 ? (
                  <li role="presentation" className="px-3 py-1.5 text-sm text-on-surface-secondary">
                    No categories available
                  </li>
                ) : filteredCategories.length > 0 ? (
                  filteredCategories.map(category => renderCategoryItem(category))
                ) : (
                  <li role="presentation" className="px-3 py-1.5 text-sm text-on-surface-secondary">
                    No matching categories
                  </li>
                )}
              </>
            )}
          </ul>,
          document.body
        )}
      </div>
    </div>
  );
}
