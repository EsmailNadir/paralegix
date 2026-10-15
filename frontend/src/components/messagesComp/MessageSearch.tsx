"use client";

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import type { MessageSearchResult } from '@/types';
import SectionLabel from '@/components/ui/SectionLabel';

interface MessageSearchProps {
  // Runs the server-side search. Called with the trimmed query (>= 2 chars).
  searchFn: (q: string) => Promise<MessageSearchResult[]>;
  // Opens the conversation a result belongs to.
  onSelect: (result: MessageSearchResult) => void;
  placeholder?: string;
  // Optional controlled query. Pass both when the same term also drives another
  // filter on the page (the firm inbox filters its conversation list with it).
  value?: string;
  onValueChange?: (value: string) => void;
}

// The messages search box. A debounced query hits the server-side search endpoint
// (content-only, masked snippets) and the hits render directly below the input;
// clicking one opens that conversation. Rendering inline rather than as an overlay
// keeps the conversation list underneath visible, since the same term filters it.
export default function MessageSearch({
  searchFn,
  onSelect,
  placeholder = 'Search messages...',
  value,
  onValueChange,
}: MessageSearchProps) {
  const [internalQuery, setInternalQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const query = value !== undefined ? value : internalQuery;
  const setQuery = (next: string) => {
    if (onValueChange) onValueChange(next);
    if (value === undefined) setInternalQuery(next);
  };
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();

  // Debounced search. Only fires for queries of 2+ characters (matches the
  // server's minimum), and ignores stale responses.
  useEffect(() => {
    if (trimmed.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear results when the query falls below the search minimum
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const found = await searchFn(trimmed);
        if (cancelled) return;
        setResults(found);
      } catch (err) {
        if (cancelled) return;
        setResults([]);
        setError(getErrorMessage(err, 'Search failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchFn]);

  const clear = () => {
    setQuery('');
    setResults([]);
    setError(null);
  };

  const formatTime = (value: string | null) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // While the first results for a query are still in flight there is nothing to
  // show but the input's spinner, so the panel stays out of the layout.
  const showPanel = trimmed.length >= 2 && (!!error || results.length > 0 || !loading);

  return (
    <div className="w-full sm:max-w-md space-y-2">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
        <input
          ref={inputRef}
          aria-label="Search messages"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full border border-input-border rounded-md pl-9 pr-9 py-2 text-sm bg-input-bg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        {loading ? (
          <Spinner size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-muted" />
        ) : query ? (
          <button
            type="button"
            onClick={() => { clear(); inputRef.current?.focus(); }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted hover:text-on-surface cursor-pointer"
          >
            <X size={15} />
          </button>
        ) : null}
      </div>
      <div role="status" className="sr-only">
        {trimmed.length < 2 || error ? '' : loading ? 'Searching messages...' : results.length === 0 ? 'No messages found' : `${results.length} ${results.length === 1 ? 'message' : 'messages'} found`}
      </div>

      {showPanel && (
        <div className="max-h-80 overflow-y-auto styled-scrollbar rounded-lg border border-outline bg-surface shadow-sm">
          <SectionLabel className="px-4 pt-3 pb-2">
            In messages
          </SectionLabel>
          {error ? (
            <div role="alert" className="px-4 pb-3 text-sm text-rose-600 dark:text-rose-400">{error}</div>
          ) : results.length === 0 ? (
            <div className="px-4 pb-3 text-sm text-on-surface-muted">No messages found</div>
          ) : (
            results.map((r) => (
              <button
                key={r.messageId}
                type="button"
                onClick={() => { onSelect(r); clear(); }}
                className="w-full text-left px-4 py-2.5 hover:bg-surface-hover transition-colors border-t border-outline-subtle cursor-pointer"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-on-surface">{r.conversationTitle}</span>
                  <span className="shrink-0 text-[10px] text-on-surface-muted">{formatTime(r.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-xs text-on-surface-secondary truncate">
                  <span className="text-on-surface-muted">{r.senderName}: </span>
                  {r.snippet}
                </p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
