"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileInfo } from "@/services/files.service";

export interface FileSelection {
  /** Ids of the selected rows. */
  selectedIds: Set<string>;
  /** The selected rows, resolved against what is currently on screen. */
  selectedItems: FileInfo[];
  selectedCount: number;
  /** True when every visible row is selected. */
  allSelected: boolean;
  toggle: (file: FileInfo) => void;
  toggleAll: () => void;
  clear: () => void;
}

/**
 * Which rows a bulk action will act on.
 *
 * Two rules, both learned the hard way:
 *
 *  - A selection belongs to the folder it was made in, so it clears whenever
 *    the location changes. There are eight ways to move the user (row click,
 *    breadcrumb, Back, root, a search hit jumping to its folder, a restored
 *    history entry, a scope switch), and clearing inside each handler means one
 *    of them eventually forgets. What a stale selection left behind was a
 *    toolbar counting rows the user could not see and a bulk delete that looked
 *    armed and quietly did nothing.
 *  - The selection is always intersected with the rows actually on screen.
 *    Re-deriving it from the raw folder contents ignored an active search, so
 *    "select all" while searching acted on files the user could not see and had
 *    not chosen.
 *  - A row that leaves the list is dropped from the selection, even with no
 *    location change. The selection used to hold object PATHS, which were
 *    deterministic (the parent folder plus the name), so renaming "draft.pdf"
 *    and later creating a different "draft.pdf" in the same folder made the new
 *    file phantom-selected: checked, and immediately actionable by a bulk
 *    delete the user never asked for. Ids cannot be reused that way, so this is
 *    now belt and braces rather than the thing standing between a user and a
 *    wrong delete. It still earns its place: a row deleted in another tab
 *    should not stay counted in this one's toolbar.
 *
 * @param visibleFiles the rows currently rendered
 * @param locationKey  a value that changes whenever the browser moves
 */
export function useFileSelection(visibleFiles: FileInfo[], locationKey: string): FileSelection {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- selection is location-scoped, so moving invalidates it
    setSelected(new Set());
  }, [locationKey]);

  // Keyed on the actual paths on screen, not the array reference (rebuilt
  // every render), so this only runs when the file list truly changes - a
  // mutation's reload, a navigation, or a search settling - never on an
  // unrelated re-render.
  const filesKey = visibleFiles.map((f) => f.id).join("␟");
  const lastFilesKeyRef = useRef(filesKey);
  useEffect(() => {
    if (lastFilesKeyRef.current === filesKey) return;
    lastFilesKeyRef.current = filesKey;
    const visibleIds = new Set(visibleFiles.map((f) => f.id));
    // Drops selections whose row disappeared.
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // visibleIds is derived from filesKey; keying the effect on the string
    // avoids re-running on a same-content array that is merely a new reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  const selectedItems = useMemo(
    () => visibleFiles.filter((f) => selected.has(f.id)),
    [visibleFiles, selected]
  );

  const allSelected = visibleFiles.length > 0 && selectedItems.length === visibleFiles.length;

  const toggle = useCallback((file: FileInfo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const everySelected =
        visibleFiles.length > 0 && visibleFiles.every((f) => prev.has(f.id));
      return everySelected ? new Set<string>() : new Set(visibleFiles.map((f) => f.id));
    });
  }, [visibleFiles]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return {
    selectedIds: selected,
    selectedItems,
    selectedCount: selectedItems.length,
    allSelected,
    toggle,
    toggleAll,
    clear,
  };
}
