import { useEffect, useRef } from "react";

export interface PrunableFilter {
  /** Filter key; the property removed from the filter object when orphaned. */
  key: string;
  /** Current filter value ("" / null / undefined means this key isn't filtering). */
  value: string | null | undefined;
  /**
   * The dropdown's current options. Readiness is inferred from these: pruning
   * only runs once at least one real (non-empty-value) option has loaded, so a
   * valid filter is never wiped during the initial load, when the list holds
   * only the "All …" placeholder entry.
   */
  options: ReadonlyArray<{ value: string }>;
  /** localStorage key the value is persisted under, if any. */
  storageKey?: string;
}

/**
 * Removes persisted filter values that no longer match any available option.
 *
 * The list pages restore their filter selections from localStorage on load. When
 * a saved value points at something since removed - a deleted matter, a member
 * who left the firm, a renamed practice area - the plain <Dropdown> falls back to
 * its placeholder (showing no selection) while the filter keeps hiding every row,
 * so the list looks empty with no on-screen cause. This drops those orphaned
 * values once their option lists have populated and clears them from localStorage
 * so they don't come back.
 *
 * `clearKeys` receives the orphaned keys and should delete them from the filter
 * state, e.g.
 *   setFilters(prev => { const n = { ...prev }; keys.forEach(k => delete n[k]); return n; })
 */
export function usePruneStaleFilters(
  filters: ReadonlyArray<PrunableFilter>,
  clearKeys: (keys: string[]) => void,
): void {
  const clearRef = useRef(clearKeys);
  clearRef.current = clearKeys;

  // A key is orphaned when it has a value, its option list has loaded real
  // entries, and none of them match the value.
  const orphaned = filters.filter((f) => {
    if (!f.value) return false;
    const hasRealOptions = f.options.some((o) => o.value !== "");
    if (!hasRealOptions) return false;
    return !f.options.some((o) => o.value === f.value);
  });

  const storageByKey = new Map(filters.map((f) => [f.key, f.storageKey] as const));
  // Primitive signature so the effect fires only when the set of orphaned keys
  // actually changes, not on every render (the option/filter arrays are rebuilt
  // each render).
  const orphanSignature = orphaned.map((f) => f.key).join(",");

  useEffect(() => {
    if (!orphanSignature) return;
    const keys = orphanSignature.split(",");
    for (const k of keys) {
      const storageKey = storageByKey.get(k);
      if (storageKey) {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // localStorage can be unavailable (private mode / disabled); ignore.
        }
      }
    }
    clearRef.current(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the orphan signature; storageByKey/clearKeys are read via the current render's closure and a ref
  }, [orphanSignature]);
}
