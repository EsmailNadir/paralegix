"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Plus, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ActionIconButton from "@/components/ui/ActionIconButton";
import MattersService from "@/services/matters.service";
import ErrorToast from "@/components/ui/ErrorToast";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import type { Category } from "@/types";

interface CategoryTreeSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  lawFirmId: string;
  allowCreate?: boolean;
}

export default function CategoryTreeSelect({
  value,
  onChange,
  placeholder = "Select a category",
  disabled = false,
  lawFirmId,
  allowCreate = true,
}: CategoryTreeSelectProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [flatCategories, setFlatCategories] = useState<Category[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [creatingUnderParentId, setCreatingUnderParentId] = useState<string | null>(null);
  const [inlineSubcategoryName, setInlineSubcategoryName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

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

    const matchesSearch = (cat: Category): boolean => {
      return (
        cat.name.toLowerCase().includes(searchLower) ||
        cat.path.toLowerCase().includes(searchLower)
      );
    };

    const filterRecursive = (items: Category[]): Category[] => {
      return items
        .map((cat): Category | null => {
          const matches = matchesSearch(cat);
          const filteredChildren = cat.children && cat.children.length > 0 
            ? filterRecursive(cat.children) 
            : [];

          // Include if it matches, or if it has matching children
          if (matches || filteredChildren.length > 0) {
            return {
              ...cat,
              children: filteredChildren,
            };
          }
          return null;
        })
        .filter((cat): cat is Category => cat !== null);
    };

    return filterRecursive(cats);
  }, []);

  // Load categories - only load flat list, build tree in memory
  const loadCategories = useCallback(async () => {
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
  }, [lawFirmId, buildTree]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers an async category fetch on mount/dependency change
    loadCategories();
  }, [loadCategories]);

  // Auto-expand all categories when searching
  useEffect(() => {
    if (searchTerm.trim()) {
      const allCategoryIds = new Set(flatCategories.map(cat => cat.id));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-expands the independently-toggleable tree based on search/selection
      setExpandedCategories(allCategoryIds);
    } else {
      // When not searching, keep expanded state but auto-expand selected category's path
      if (value) {
        const selectedCategory = flatCategories.find(cat => cat.path === value);
        if (selectedCategory) {
          const pathIds = new Set<string>();
          let current: Category | undefined = selectedCategory;
          while (current) {
            pathIds.add(current.id);
            const parentId: string | null = current.parentId;
            if (parentId) {
              const parent: Category | undefined = flatCategories.find(cat => cat.id === parentId);
              if (parent) {
                current = parent;
              } else {
                break;
              }
            } else {
              break;
            }
          }
          setExpandedCategories(pathIds);
        }
      }
    }
  }, [searchTerm, value, flatCategories]);

  // Get filtered categories (maintains tree structure)
  const filteredCategories = searchTerm
    ? filterTree(categories, searchTerm)
    : categories;

  // Toggle expand/collapse
  const toggleExpand = useCallback((categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setSearchTerm(newValue);
    setShowDropdown(true);
    setCreatingUnderParentId(null); // Clear inline creation when typing in main input
  };

  // Handle category selection
  const handleSelectCategory = useCallback((categoryPath: string) => {
    onChange(categoryPath);
    setSearchTerm("");
    setShowDropdown(false);
    setCreatingUnderParentId(null);
    setInlineSubcategoryName("");
    inputRef.current?.blur();
  }, [onChange]);

  // Handle starting inline subcategory creation
  const handleStartCreateSubcategory = useCallback((categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCreatingUnderParentId(categoryId);
    setInlineSubcategoryName("");
    // Expand parent to show the input
    setExpandedCategories(prev => new Set(prev).add(categoryId));
    // Focus the inline input after a brief delay to ensure it's rendered
    setTimeout(() => {
      inlineInputRef.current?.focus();
    }, 0);
  }, []);

  // Handle creating subcategory via inline input
  const handleCreateSubcategoryInline = useCallback(async (parentId: string, name: string) => {
    if (!name.trim() || isCreating) return;

    try {
      setIsCreating(true);
      
      const parentCategory = flatCategories.find(cat => cat.id === parentId);
      if (!parentCategory) return;

      // Check if subcategory already exists
      const existing = flatCategories.find(
        cat => cat.parentId === parentId && cat.name.toLowerCase() === name.trim().toLowerCase()
      );

      if (existing) {
        handleSelectCategory(existing.path);
        return;
      }

      // Create category
      const result = await MattersService.createCategory(lawFirmId, name.trim(), parentId);
      
      // Add new category to flat list and rebuild tree
      const updatedFlat = [...flatCategories, result.category];
      setFlatCategories(updatedFlat);
      setCategories(buildTree(updatedFlat));
      
      // Select the newly created category
      handleSelectCategory(result.category.path);
    } catch (error) {
      console.error('Failed to create subcategory:', error);
      setCreateError(getErrorMessage(error, 'Failed to create subcategory'));
    } finally {
      setIsCreating(false);
      setCreatingUnderParentId(null);
      setInlineSubcategoryName("");
    }
  }, [isCreating, flatCategories, lawFirmId, buildTree, handleSelectCategory]);

  // Parse search term - supports " > " syntax for backward compatibility
  const parseCategoryInput = useCallback((input: string): { name: string; parentId: string | null } => {
    const trimmed = input.trim();
    const parts = trimmed.split(' > ').map(p => p.trim()).filter(p => p);
    
    if (parts.length === 1) {
      // Top-level category
      return { name: parts[0], parentId: null };
    }
    
    // Subcategory: find parent by path
    const parentPath = parts.slice(0, -1).join(' > ');
    const parentCategory = flatCategories.find(
      cat => cat.path.toLowerCase() === parentPath.toLowerCase()
    );
    
    if (parentCategory) {
      return { name: parts[parts.length - 1], parentId: parentCategory.id };
    }
    
    // Parent not found, create as top-level
    return { name: trimmed, parentId: null };
  }, [flatCategories]);

  // Handle creating new category
  const handleCreateCategory = useCallback(async () => {
    if (!searchTerm.trim() || isCreating) return;

    try {
      setIsCreating(true);
      
      // Check if category already exists by path
      const existing = flatCategories.find(
        cat => cat.path.toLowerCase() === searchTerm.trim().toLowerCase()
      );

      if (existing) {
        handleSelectCategory(existing.path);
        return;
      }

      // Parse input to determine parent
      const { name, parentId } = parseCategoryInput(searchTerm.trim());

      // Create category
      const result = await MattersService.createCategory(lawFirmId, name, parentId);
      
      // Add new category to flat list and rebuild tree
      const updatedFlat = [...flatCategories, result.category];
      setFlatCategories(updatedFlat);
      setCategories(buildTree(updatedFlat));
      
      // Select the newly created category
      handleSelectCategory(result.category.path);
    } catch (error) {
      console.error('Failed to create category:', error);
      setCreateError(getErrorMessage(error, 'Failed to create category'));
    } finally {
      setIsCreating(false);
    }
  }, [searchTerm, isCreating, flatCategories, lawFirmId, parseCategoryInput, buildTree, handleSelectCategory]);

  // Render category tree item with proper hierarchy
  const renderCategoryItem = useCallback((category: Category, depth: number = 0) => {
    const isSelected = value === category.path;
    const isExpanded = expandedCategories.has(category.id);
    const hasChildren = category.children && category.children.length > 0;
    const isCreatingUnder = creatingUnderParentId === category.id;
    const indent = depth * 20;

    return (
      <div key={category.id}>
        <div
          className={`flex items-center group ${
            isSelected ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-surface-hover'
          }`}
        >
          {/* Expand/collapse button */}
          <button
            type="button"
            onClick={(e) => hasChildren && toggleExpand(category.id, e)}
            className={`flex-shrink-0 w-6 h-8 flex items-center justify-center text-on-surface-muted hover:text-on-surface-secondary transition-colors ${
              !hasChildren ? 'invisible' : ''
            }`}
            style={{ marginLeft: `${indent}px` }}
          >
            {hasChildren ? (
              <svg
                className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            ) : (
              <div className="w-4 h-4" />
            )}
          </button>

          {/* Category name button */}
          <button
            type="button"
            className={`flex-1 px-2 py-2 text-left text-sm focus:outline-none transition-colors ${
              isSelected ? 'text-blue-700 dark:text-blue-300 font-medium' : 'text-on-surface'
            }`}
            onClick={() => handleSelectCategory(category.path)}
            onDoubleClick={(e) => hasChildren && toggleExpand(category.id, e)}
          >
            <span className="flex-1">{category.name}</span>
          </button>

          {/* Create child button */}
          {allowCreate && (
            <Tooltip title="Create subcategory under this" enterDelay={300}>
              <button aria-label="Create subcategory under this"
                type="button"
                onClick={(e) => handleStartCreateSubcategory(category.id, e)}
                className="flex-shrink-0 px-2 py-2 text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover hover:bg-surface-hover transition-colors"
              >
                <Plus size={16} strokeWidth={2} />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Inline subcategory creation input */}
        {isCreatingUnder && (
          <div
            className="mx-2 my-1.5 flex items-center gap-1.5 rounded-lg border border-outline-subtle bg-surface-alt p-1.5"
            style={{ marginLeft: `${indent + 24}px` }}
          >
            <input
              ref={inlineInputRef}
              type="text"
              value={inlineSubcategoryName}
              onChange={(e) => setInlineSubcategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inlineSubcategoryName.trim()) {
                  e.preventDefault();
                  handleCreateSubcategoryInline(category.id, inlineSubcategoryName);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCreatingUnderParentId(null);
                  setInlineSubcategoryName("");
                }
              }}
              placeholder="Enter subcategory name..."
              className="min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2.5 py-1.5 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              autoFocus
            />
            <ActionIconButton
              label="Create subcategory"
              tone="info"
              emphasis
              size="sm"
              disabled={!inlineSubcategoryName.trim() || isCreating}
              onClick={() => handleCreateSubcategoryInline(category.id, inlineSubcategoryName)}
            >
              <Check size={14} />
            </ActionIconButton>
            <ActionIconButton
              label="Cancel"
              size="sm"
              onClick={() => {
                setCreatingUnderParentId(null);
                setInlineSubcategoryName("");
              }}
            >
              <X size={14} />
            </ActionIconButton>
          </div>
        )}

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>
            {category.children!.map(child => renderCategoryItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [value, creatingUnderParentId, expandedCategories, allowCreate, inlineSubcategoryName, isCreating, handleSelectCategory, handleStartCreateSubcategory, handleCreateSubcategoryInline, toggleExpand]);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // The menu is portaled to document.body, so it lives outside the
      // container subtree. Check it explicitly too.
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setShowDropdown(false);
      setSearchTerm("");
      setCreatingUnderParentId(null);
      setInlineSubcategoryName("");
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Check if search term matches existing category
  const exactMatch = flatCategories.find(
    cat => cat.path.toLowerCase() === searchTerm.trim().toLowerCase()
  );
  const showCreateOption = allowCreate && searchTerm.trim() && !exactMatch && !isLoading && !isCreating;

  const { mounted, exiting } = useMountTransition(showDropdown, 150);

  // Track the input's viewport rect so the fixed-positioned portal menu sits
  // flush under it and follows it on scroll/resize while open. When there
  // isn't room below (e.g. the input sits near the bottom of the viewport),
  // flip the menu above it so it isn't clipped off-screen.
  useEffect(() => {
    if (!showDropdown) return;
    const update = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      // Prefer the rendered menu's real height; fall back to an estimate on
      // the first pass before it has mounted (capped at the max-h-60 = 240px
      // menu).
      const menuH = menuRef.current?.offsetHeight ?? 240;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < menuH + 8 && r.top > spaceBelow;
      setMenuPos({
        top: openUp ? Math.max(8, r.top - menuH - 4) : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    };
    update();
    // Refine once the menu has actually rendered and keep the anchor accurate
    // as searching or expanding the tree changes the menu's height.
    const raf = requestAnimationFrame(update);
    const observer = menuRef.current ? new ResizeObserver(update) : null;
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showDropdown, mounted]);

  // Picking a category clears the search term and moves the selection, both of
  // which rewrite this list - while the menu is still on screen playing its exit
  // animation. Freezing the rendered body means it fades out showing the
  // filtered list the user chose from, instead of visibly re-expanding to every
  // category on the way out.
  const menuBody = useLastOpenValue(
    showDropdown,
    isLoading ? (
      <div className="px-3 py-2 text-sm text-on-surface-secondary">Loading categories...</div>
    ) : isCreating ? (
      <div className="px-3 py-2 text-sm text-on-surface-secondary">Creating category...</div>
    ) : filteredCategories.length > 0 ? (
      <>
        {filteredCategories.map(category => renderCategoryItem(category))}
        {showCreateOption && (
          <div className="border-t border-outline-subtle">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-accent-emphasis hover:bg-surface-hover focus:bg-surface-hover focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleCreateCategory}
              disabled={isCreating}
            >
              + Create "{searchTerm.trim()}"
            </button>
          </div>
        )}
      </>
    ) : showCreateOption ? (
      <button
        type="button"
        className="w-full px-3 py-2 text-left text-sm text-accent-emphasis hover:bg-surface-hover focus:bg-surface-hover focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleCreateCategory}
        disabled={isCreating}
      >
        + Create "{searchTerm.trim()}"
      </button>
    ) : (
      <div className="px-3 py-2 text-sm text-on-surface-secondary">No categories found</div>
    )
  );

  return (
    <div className="relative" ref={containerRef}>
      {createError && (
        <ErrorToast message={createError} onDismiss={() => setCreateError(null)} />
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className={`w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
            !showDropdown && value ? "text-transparent cursor-pointer" : ""
          }`}
          value={showDropdown ? searchTerm : value}
          onChange={handleInputChange}
          onFocus={() => {
            setSearchTerm(value);
            setShowDropdown(true);
          }}
          placeholder={placeholder}
          disabled={disabled || isCreating}
        />
        {/* Breadcrumb rendering of the selected path, laid over the (otherwise
            plain-text) input so the control still edits/searches as a normal
            text field once focused. */}
        {!showDropdown && value && (
          <div className="pointer-events-none absolute inset-0 flex items-center gap-1 overflow-hidden px-3">
            {value.split(" > ").map((part, index, parts) => {
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
            })}
          </div>
        )}
      </div>

      {mounted && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          className={`z-[9999] bg-surface border border-outline rounded-md shadow-lg max-h-60 overflow-y-auto overflow-x-hidden origin-top ${menuAnim(exiting)}`}
        >
          {menuBody}
        </div>,
        document.body
      )}
    </div>
  );
}
