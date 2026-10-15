'use client';

import useFileDestinationLookup from "@/hooks/fileHooks/useFileDestinationLookup";

import { useState, useEffect, useId } from 'react';
import { X, FolderOpen, Briefcase, Users, ListTodo, ChevronRight, Check, ArrowLeft, Search } from 'lucide-react';

import Modal from '@/components/ui/Modal';
import { lookupOverflowNote } from '@/lib/constants/search';
import ListSkeleton from '@/components/ui/ListSkeleton';

interface DestinationPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string, label: string) => void;
  lawFirmId: string;
  currentPath: string;
}

type Category = 'main' | 'matters' | 'clients' | 'tasks';

interface ListItem {
  id: string;
  name: string;
  path: string;
  sublabel?: string | null;
}

export default function DestinationPickerModal({
  isOpen,
  onClose,
  onSelect,
  lawFirmId,
  currentPath,
}: DestinationPickerModalProps) {
  const [category, setCategory] = useState<Category>('main');
  const [items, setItems] = useState<ListItem[]>([]);
  // Set from the lookup response so a capped result can say so.
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const titleId = useId();
  const lookupDestination = useFileDestinationLookup(lawFirmId);

  // Reset to main when opened
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets picker state each time the modal opens
      setCategory('main');
      setItems([]);
      setHasMore(false);
      setError(null);
      setSearchQuery('');
    }
  }, [isOpen]);

  const loadCategory = (cat: Category) => {
    setCategory(cat);
    setError(null);
    setSearchQuery('');
    setHasMore(false);
  };

  useEffect(() => {
    if (!isOpen || category === 'main') return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const opts = { search: searchQuery.trim() || undefined, limit: 50 };
        const result = await lookupDestination(category, opts);
        if (!cancelled) {
          setItems(result.items.map((item) => ({
            id: item.id,
            name: item.label,
            path: category === 'matters'
              ? `lawfirmids/${lawFirmId}/${item.id}/`
              : `lawfirmids/${lawFirmId}/${category}/${item.id}/`,
            sublabel: item.sublabel,
          })));
          setHasMore(result.hasMore);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load items');
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, searchQuery.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [category, isOpen, lawFirmId, searchQuery, lookupDestination]);

  const handleSelect = (path: string, label: string) => {
    onSelect(path, label);
    onClose();
  };

  const overflowNote = lookupOverflowNote(hasMore, searchQuery);

  const categories = [
    {
      id: 'general' as const,
      icon: FolderOpen,
      label: 'General Files',
      description: 'Firm-wide shared files',
      color: 'text-on-surface-secondary',
      bgColor: 'bg-surface-alt',
      path: `lawfirmids/${lawFirmId}/general/`,
    },
    {
      id: 'matters' as const,
      icon: Briefcase,
      label: 'Matter Files',
      description: 'Choose a matter',
      color: 'text-accent-emphasis',
      bgColor: 'bg-blue-50 dark:bg-blue-900/30',
    },
    {
      id: 'clients' as const,
      icon: Users,
      label: 'Client Files',
      description: 'Choose a client',
      color: 'text-emerald-600 dark:text-emerald-400',
      bgColor: 'bg-emerald-50 dark:bg-emerald-900/30',
    },
    {
      id: 'tasks' as const,
      icon: ListTodo,
      label: 'Task Files',
      description: 'Choose a task',
      color: 'text-orange-600 dark:text-orange-400',
      bgColor: 'bg-orange-50 dark:bg-orange-900/30',
    },
  ];

  return (
    // Opened from inside the signing dialogs, so it stacks above them.
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      stacked
      size="sm"
      showClose={false}
      labelledBy={titleId}
      bodyClassName={null}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-outline-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          {category !== 'main' && (
            <button
              onClick={() => { setCategory('main'); setItems([]); setHasMore(false); setError(null); setSearchQuery(''); }}
              className="flex items-center gap-1.5 text-sm text-on-surface-secondary hover:text-on-surface transition-colors cursor-pointer mr-1"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          )}
          <h3 id={titleId} className="text-sm font-semibold text-on-surface">
            {category === 'main' ? 'Choose Destination' : categories.find(c => c.id === category)?.label}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      {/* Content */}
      <div className="overflow-y-auto overflow-x-hidden styled-scrollbar flex-1">
        {category === 'main' ? (
          <div className="p-3 space-y-1.5">
            {categories.map((cat) => {
              const Icon = cat.icon;
              const isSelected = cat.id === 'general' && currentPath === cat.path;

              if (cat.id === 'general') {
                return (
                  <button
                    key={cat.id}
                    onClick={() => handleSelect(cat.path!, cat.label)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-accent-border-soft bg-accent-soft'
                        : 'border-outline-subtle hover:border-outline hover:bg-surface-hover'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-lg ${cat.bgColor} flex items-center justify-center flex-shrink-0`}>
                      <Icon size={16} className={cat.color} />
                    </div>
                    <div className="text-left flex-1">
                      <p className="text-sm font-medium text-on-surface">{cat.label}</p>
                      <p className="text-[11px] text-on-surface-muted">{cat.description}</p>
                    </div>
                    {isSelected && <Check size={16} className="text-accent-emphasis flex-shrink-0" />}
                  </button>
                );
              }

              return (
                <button
                  key={cat.id}
                  onClick={() => loadCategory(cat.id as Category)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border border-outline-subtle hover:border-outline hover:bg-surface-hover transition-all cursor-pointer"
                >
                  <div className={`w-8 h-8 rounded-lg ${cat.bgColor} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={16} className={cat.color} />
                  </div>
                  <div className="text-left flex-1">
                    <p className="text-sm font-medium text-on-surface">{cat.label}</p>
                    <p className="text-[11px] text-on-surface-muted">{cat.description}</p>
                  </div>
                  <ChevronRight size={16} className="text-on-surface-muted flex-shrink-0" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Search bar, fixed at top. It stays mounted while a search
                loads and when a query matches nothing, so typing keeps
                focus and a query that found nothing can be corrected. */}
            <div className="relative px-3 pt-3 pb-2 flex-shrink-0">
              <Search size={14} className="absolute left-6 top-1/2 -translate-y-[1px] text-on-surface-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={`Search ${category}...`}
                aria-label={`Search ${category}`}
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                autoFocus
              />
            </div>
            {/* Scrollable list */}
            <div className="overflow-y-auto overflow-x-hidden styled-scrollbar h-[40vh] sm:h-[280px] px-3 pb-3">
              {loading ? (
                <ListSkeleton rows={4} label={`Loading ${category}`} bordered={false} />
              ) : error ? (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
                  {error}
                </div>
              ) : items.length === 0 ? (
                searchQuery.trim() ? (
                  <p className="text-sm text-on-surface-muted text-center py-4">
                    No matching {category} found
                  </p>
                ) : (
                  <p className="text-sm text-on-surface-muted text-center py-8">
                    No {category} found
                  </p>
                )
              ) : (
                <div className="space-y-1">
                  {items.map((item) => {
                    const isSelected = currentPath === item.path;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleSelect(item.path, item.name)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${
                          isSelected
                            ? 'border-accent-border-soft bg-accent-soft'
                            : 'border-transparent hover:bg-surface-hover'
                        }`}
                      >
                        <span className="flex-1 min-w-0 text-left">
                          <span className="block text-sm text-on-surface truncate">{item.name}</span>
                          {item.sublabel && (
                            <span className="block text-[11px] text-on-surface-muted truncate">{item.sublabel}</span>
                          )}
                        </span>
                        {isSelected && <Check size={14} className="text-accent-emphasis flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Truncation note: it scrolls with the rows instead of being
                  pinned above them, so it reads as the end of the list. */}
              {!loading && !error && overflowNote && items.length > 0 && (
                <p className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle bg-surface-alt">
                  {overflowNote}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
