"use client";

import { useMemo } from "react";
import dayjs from "dayjs";
import { StickyNote } from "lucide-react";
import PageHeader from "@/components/ui/PageHeader";
import Dropdown from "@/components/ui/Dropdown";
import DateRangePicker from "@/components/ui/DateRangePicker";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import ErrorNotification from "@/components/ErrorNotification";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from "@/components/ui/ListPager";
import StatusBadge from "@/components/ui/StatusBadge";
import { STATUS_VARIANTS } from "@/constants/statusMeta";
import { NOTE_TYPE_OPTIONS, noteTypeMeta } from "@/constants/statusMeta";
import { useNavigation } from "@/contexts/NavigationContext";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import useEntityNotesPage from "@/hooks/useEntityNotesPage";
import type { NoteTimeFilter, NoteTimeStatus } from "@/types/note";

interface Props {
  lawFirmId: string;
}

const TIME_FILTER_TABS: { value: NoteTimeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'with-time', label: 'With Time' },
  { value: 'without-time', label: 'Missing time' },
];

const TIME_FILTER_COUNT_KEYS: Record<NoteTimeFilter, 'all' | 'withTime' | 'withoutTime'> = {
  'all': 'all',
  'with-time': 'withTime',
  'without-time': 'withoutTime',
};

/** Same tone mapping `NoteTimePanel` uses for a note's billing status. */
const TIME_STATUS_META: Record<Exclude<NoteTimeStatus, 'none'>, { label: string; variant: keyof typeof STATUS_VARIANTS }> = {
  unbilled: { label: "Unbilled", variant: "neutral" },
  pending: { label: "On draft invoice", variant: "warning" },
  billed: { label: "Billed", variant: "success" },
};



/**
 * Every note across every matter the caller can see, in one searchable feed.
 *
 * An ordinary firm member is narrowed server-side to the matters they belong
 * to; owners and admins see the whole firm. There is no tag dropdown here:
 * tags are read per matter, and a firm-wide tag vocabulary would mean sweeping
 * every matter's notes just to populate a filter.
 */
export default function FirmNotesGrid({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const firmMembers = useFirmMembers(lawFirmId);
  const notesPage = useEntityNotesPage(lawFirmId, "firm", undefined);

  const authorOptions = useMemo(
    () => [{ value: "", label: "All Authors" }, ...firmMembers.map((m) => ({ value: m.id, label: m.name }))],
    [firmMembers],
  );

  const noteTypeFilterOptions = useMemo(
    () => [{ value: "all", label: "All Types" }, ...NOTE_TYPE_OPTIONS],
    [],
  );

  const notes = notesPage.notes as Array<typeof notesPage.notes[number] & {
    matterId?: string; matterName?: string; matterNumber?: string;
  }>;

  const hasActiveFilters = Boolean(
    notesPage.search.trim() || notesPage.noteType !== 'all' || notesPage.timeFilter !== 'all'
      || notesPage.authorId || notesPage.dateFrom || notesPage.dateTo
  );

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-5 min-w-0">
      <PageHeader
        eyebrow="Firm-wide"
        title="Notes"
        description="Every note across your matters."
      />

      <ErrorNotification error={notesPage.error} />

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <input
            type="text"
            value={notesPage.search}
            onChange={(e) => notesPage.setSearch(e.target.value)}
            placeholder="Search notes..."
            className={`${INPUT_CLS} min-w-0 flex-1`}
          />
          <Dropdown
            value={notesPage.noteType}
            onChange={notesPage.setNoteType}
            options={noteTypeFilterOptions}
            className="w-full sm:w-auto sm:min-w-[160px]"
            buttonClassName="border-input-border bg-input-bg"
          />
          <Dropdown
            value={notesPage.authorId}
            onChange={notesPage.setAuthorId}
            options={authorOptions}
            className="w-full sm:w-auto sm:min-w-[160px]"
            buttonClassName="border-input-border bg-input-bg"
          />

        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <DateRangePicker
            from={notesPage.dateFrom || undefined}
            to={notesPage.dateTo || undefined}
            onChange={({ from, to }) => {
              notesPage.setDateFrom(from || "");
              notesPage.setDateTo(to || "");
            }}
            placeholder="Notes date range"
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      <div>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-1 sm:p-1 sm:bg-surface-alt sm:rounded-lg sm:w-fit">
          {TIME_FILTER_TABS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => notesPage.setTimeFilter(value)}
              className={`w-full sm:w-auto px-4 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                notesPage.timeFilter === value
                  ? 'bg-surface text-on-surface shadow-sm border border-outline sm:border-transparent'
                  : 'text-on-surface-secondary hover:text-on-surface border border-transparent'
              }`}
            >
              {label}
              <span className="ml-1.5 text-xs text-on-surface-secondary">
                ({notesPage.counts[TIME_FILTER_COUNT_KEYS[value]]})
              </span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex h-5 items-center">
          <ListBusyIndicator busy={notesPage.fetching && !notesPage.loading} />
        </div>
      </div>

      {notesPage.loading && notes.length === 0 ? (
        <ListSkeleton rows={6} label="Loading notes" />
      ) : notes.length === 0 && !notesPage.error ? (
        <ListEmptyState
          icon={<StickyNote size={32} />}
          title={hasActiveFilters ? 'No notes match your filters' : 'No notes yet'}
          message={hasActiveFilters ? 'Try a different search term, author or date range.' : 'Notes added on any matter will show up here.'}
        />
      ) : (
        <div className="space-y-3">
          {notes.map((note) => {
            const statusMeta = note.time?.status && note.time.status !== 'none'
              ? TIME_STATUS_META[note.time.status as Exclude<NoteTimeStatus, 'none'>]
              : null;
            return (
              <button
                key={note.id}
                onClick={() => note.matterId && navigate(`/lawfirm/${lawFirmId}/matters/${note.matterId}?tab=notes&note=${note.id}`)}
                className="w-full text-left border border-outline rounded-lg p-4 bg-surface hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="text-sm font-medium text-on-surface">
                    {note.matterName || 'Untitled matter'}
                  </span>
                  {note.matterNumber && (
                    <span className="text-xs text-on-surface-muted">#{note.matterNumber}</span>
                  )}
                  <span className="text-xs text-on-surface-muted">
                    {dayjs(note.noteDate || note.createdAt).format('MMM D, YYYY')}
                  </span>
                  <StatusBadge variant={noteTypeMeta(note.noteType).variant}>
                    {noteTypeMeta(note.noteType).label}
                  </StatusBadge>
                  {statusMeta && (
                    <span className={`text-xs px-1.5 py-0.5 rounded ${statusMeta.variant === 'neutral' ? 'bg-surface-alt text-on-surface-secondary' : `${STATUS_VARIANTS[statusMeta.variant].tint} ${STATUS_VARIANTS[statusMeta.variant].text}`}`}>
                      {statusMeta.label}
                    </span>
                  )}
                </div>
                {note.subject && (
                  <div className="text-sm font-semibold text-on-surface mb-1">{note.subject}</div>
                )}
                <p className="text-sm text-on-surface-secondary line-clamp-2">{note.content}</p>
                <div className="mt-2 text-xs text-on-surface-muted">
                  By {note.createdByName || 'Unknown'}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {pagerWillRender(notesPage.total) && (
        <ListPager
          page={notesPage.page}
          totalPages={notesPage.totalPages}
          total={notesPage.total}
          rowsPerPage={notesPage.rowsPerPage}
          onPageChange={notesPage.setPage}
          busy={notesPage.fetching}
          serverPaged
          rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
          onRowsPerPageChange={notesPage.setRowsPerPage}
        />
      )}
      </div>
    </div>
  );
}
