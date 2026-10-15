'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Check, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ErrorNotification from '@/components/ErrorNotification';
import { useResetAfterClose } from "@/hooks/useMountTransition";

interface RowState {
  selected: boolean;
  alreadyAdded: boolean;
}

interface BaseProps<T> {
  open: boolean;
  onClose: () => void;
  /** Called after a successful adopt, before the modal closes. */
  onAdopted: () => void;
  title: string;
  description: string;
  searchPlaceholder: string;
  getId: (item: T) => string;
  /** Renders a row's content to the right of the checkbox (badge/label, "already added" marker, etc). */
  renderRow: (item: T, state: RowState) => ReactNode;
  /** Items for which the row is inert and cannot be toggled. Defaults to none. */
  isAlreadyAdded?: (item: T) => boolean;
  loadingLabel: string;
  emptyLabel: string;
  /** Adopt-button label for the current selection count (button is disabled at 0, so the 0 case never surfaces). */
  adoptLabel: (count: number) => string;
  /** Fallback error message when a load/search call rejects without one. */
  errorFallback: string;
  /** Fallback error message when the adopt call rejects without one. */
  adoptErrorFallback: string;
  onAdopt: (selectedIds: string[]) => Promise<void>;
  /** Render above another open dialog, e.g. when opened from inside a form modal. */
  stacked?: boolean;
}

type ModeProps<T> =
  | {
      /** Debounced server-side search: called again on every query change. */
      mode: 'search';
      search: (query: string) => Promise<{ items: T[]; total?: number }>;
      debounceMs?: number;
    }
  | {
      /** Fetch once on open, then filter the cached list client-side as the user types. */
      mode: 'filter';
      loadItems: () => Promise<T[]>;
      filterItem: (item: T, query: string) => boolean;
    };

type CatalogPickerModalProps<T> = BaseProps<T> & ModeProps<T>;

/**
 * Browse a catalog and adopt selected rows into the firm (UTBMS codes, court
 * directory, and similar "copy-on-adopt" catalogs). Two ways to source rows:
 * `mode="search"` re-queries on every (debounced) keystroke; `mode="filter"`
 * loads the catalog once on open and filters it client-side with no debounce.
 * Owns the shared shell: header, search box, checkbox rows, selection-count
 * footer. Callers own copy, row content, and how rows are fetched/adopted.
 */
export default function CatalogPickerModal<T>(props: CatalogPickerModalProps<T>) {
  const {
    open, onClose, onAdopted, title, description, searchPlaceholder,
    getId, renderRow, isAlreadyAdded, loadingLabel, emptyLabel, adoptLabel,
    errorFallback, adoptErrorFallback, onAdopt, stacked,
  } = props;

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetAfterClose(open, () => setError(null));

  // mode="search" state: the server already returns the filtered/paged set.
  const [searchItems, setSearchItems] = useState<T[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `clearTimeout` on the debounce only cancels a pending, not-yet-fired
  // timer; once a search is actually in flight, typing more can't stop it.
  // This guards against an earlier query's slower response landing after a
  // later query's and silently replacing what the visible query now shows.
  const searchRequestIdRef = useRef(0);

  // mode="filter" state: the full catalog, fetched once, filtered locally.
  const [allItems, setAllItems] = useState<T[]>([]);
  const [filterLoading, setFilterLoading] = useState(false);

  const runSearch = useCallback(async (q: string) => {
    if (props.mode !== 'search') return;
    const requestId = ++searchRequestIdRef.current;
    setSearchLoading(true);
    setError(null);
    try {
      const res = await props.search(q);
      if (requestId !== searchRequestIdRef.current) return;
      setSearchItems(res.items || []);
      setSearchTotal(res.total ?? (res.items || []).length);
    } catch (e: any) {
      if (requestId !== searchRequestIdRef.current) return;
      setError(e?.message || errorFallback);
    } finally {
      if (requestId === searchRequestIdRef.current) setSearchLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `props` is not a stable dep; mode/search/errorFallback cover it
  }, [props.mode, props.mode === 'search' ? props.search : undefined, errorFallback]);

  const loadAll = useCallback(async () => {
    if (props.mode !== 'filter') return;
    setFilterLoading(true);
    setError(null);
    try {
      const items = await props.loadItems();
      setAllItems(items || []);
    } catch (e: any) {
      setError(e?.message || errorFallback);
    } finally {
      setFilterLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `props` is not a stable dep; mode/loadItems/errorFallback cover it
  }, [props.mode, props.mode === 'filter' ? props.loadItems : undefined, errorFallback]);

  // Reset when the modal opens. Filter-mode catalogs load here; search-mode
  // catalogs load in the query effect below so the initial query only runs once.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets query/selection and kicks off the initial load when the modal opens
    setQuery('');
    setSelected(new Set());
    if (props.mode === 'filter') loadAll();
  }, [open, props.mode, loadAll]);

  // Load the initial unfiltered results immediately, then debounce searches as
  // the user types. Keeping both paths here avoids firing the opening search twice.
  useEffect(() => {
    if (!open || props.mode !== 'search') return;
    const debounceMs = query === '' ? 0 : (props.debounceMs ?? 300);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), debounceMs);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props.debounceMs is read once per timeout, not a reactive value worth tracking
  }, [query, open, props.mode, runSearch]);

  // Client-side filter of the cached catalog (mode="filter" only), no debounce.
  const filtered = useMemo(() => {
    if (props.mode !== 'filter') return allItems;
    return allItems.filter((item) => props.filterItem(item, query));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props.filterItem is not a stable dep; mode/allItems/query cover it
  }, [props.mode, props.mode === 'filter' ? props.filterItem : undefined, allItems, query]);

  const loading = props.mode === 'search' ? searchLoading : filterLoading;
  const items = props.mode === 'search' ? searchItems : filtered;
  const total = props.mode === 'search' ? searchTotal : items.length;

  const toggle = (id: string, alreadyAdded: boolean) => {
    if (alreadyAdded) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Cancel is disabled while an adopt is in flight; Escape, the backdrop and
  // the close button are the same request and are refused with it.
  const requestClose = () => {
    if (!adopting) onClose();
  };

  const handleAdopt = async () => {
    if (!selected.size) return;
    setAdopting(true);
    setError(null);
    try {
      await onAdopt(Array.from(selected));
      onAdopted();
      onClose();
    } catch (e: any) {
      setError(e?.message || adoptErrorFallback);
    } finally {
      setAdopting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={requestClose}
      title={title}
      subtitle={description}
      closeIcon={<X size={18} />}
      size="2xl"
      stacked={stacked}
      dismissible={!adopting}
      bodyClassName="px-6 py-4 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footerAlign="between"
      footer={
        <>
          <span className="text-xs text-on-surface-secondary">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button type="secondary" onClick={onClose} disabled={adopting}>Cancel</Button>
            <Button type="primary" onClick={handleAdopt} loading={adopting} disabled={!selected.size}>
              {adoptLabel(selected.size)}
            </Button>
          </div>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          autoFocus
          className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-secondary py-6 text-center">{loadingLabel}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-on-surface-secondary py-6 text-center">{emptyLabel}</p>
      ) : (
        <ul className="rounded-lg border border-outline overflow-hidden divide-y divide-outline-subtle">
          {items.map((item) => {
            const id = getId(item);
            const isSelected = selected.has(id);
            const alreadyAdded = isAlreadyAdded?.(item) ?? false;
            const checkbox = (
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  isSelected ? 'bg-accent-solid border-accent-solid text-accent-foreground' : 'border-input-border'
                }`}
              >
                {isSelected && <Check size={12} />}
              </span>
            );
            // A selectable row is a real toggle button inside its list item, so
            // the list keeps its list semantics and the row is keyboard operable
            // without hand-written key handling. An adopted row is inert text.
            return (
              <li key={id} className={isSelected ? 'bg-accent-catalog' : 'bg-surface'}>
                {alreadyAdded ? (
                  <div className="flex items-center gap-3 px-4 py-2.5 opacity-60 cursor-default">
                    {checkbox}
                    {renderRow(item, { selected: isSelected, alreadyAdded })}
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggle(id, alreadyAdded)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left cursor-pointer hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    {checkbox}
                    {renderRow(item, { selected: isSelected, alreadyAdded })}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && total > items.length && (
        <p className="text-xs text-on-surface-muted text-center">
          Showing {items.length} of {total}. Refine your search to narrow the list.
        </p>
      )}
    </Modal>
  );
}
