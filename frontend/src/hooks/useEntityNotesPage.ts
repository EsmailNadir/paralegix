"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import mattersService from "@/services/matters.service";
import tasksService from "@/services/tasks.service";
import clientsService from "@/services/clients.service";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import type { Note, NotesPageResult, NoteTimeCounts, NoteTimeFilter } from "@/types/note";

const DEFAULT_PAGE_SIZE = 10;

// Stable references for the empty state so a consumer feeding these into a
// dependency array doesn't re-run on every render while data is undefined.
const EMPTY_NOTES: Note[] = [];
const EMPTY_TAGS: string[] = [];
const EMPTY_COUNTS: NoteTimeCounts = { all: 0, withTime: 0, withoutTime: 0 };

export interface EntityNotesPage {
  notes: Note[];
  /** Size of the whole filtered set, not the page. */
  total: number;
  totalPages: number;
  page: number;
  setPage: (page: number) => void;
  rowsPerPage: number;
  setRowsPerPage: (rowsPerPage: number) => void;
  /** Raw input value, for the controlled search field. */
  search: string;
  setSearch: (value: string) => void;
  noteType: string;
  setNoteType: (value: string) => void;
  timeFilter: NoteTimeFilter;
  setTimeFilter: (value: NoteTimeFilter) => void;
  tag: string;
  setTag: (value: string) => void;
  authorId: string;
  setAuthorId: (value: string) => void;
  dateFrom: string;
  setDateFrom: (value: string) => void;
  dateTo: string;
  setDateTo: (value: string) => void;
  /** Every `#tag` used across the entity's notes, not just the page. */
  tags: string[];
  /**
   * Counts for the time tabs, taken over every other filter but NOT the time
   * filter - so selecting one tab cannot zero the other two.
   */
  counts: NoteTimeCounts;
  loading: boolean;
  fetching: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * The notes panel's data: one server page of a matter's, a task's, a
 * client's, or (with `parentType: "firm"`) the whole firm's notes, plus the
 * filter state that selects it.
 *
 * Every filter runs in Postgres. They used to run in the browser over the
 * entity's whole note history, which worked only because the history was
 * downloaded whole - a read that grows for the life of the matter. Now that the
 * panel holds one page, a filter that ran here would only ever narrow the rows
 * already on screen, so searching from page 3 would miss every match above it.
 *
 * Changing any filter, the page size or the search term resets to page 1, so a
 * change can never strand the view on a page past the end of the new result set.
 */
export default function useEntityNotesPage(
  lawFirmId: string | undefined,
  parentType: "matter" | "task" | "client" | "firm",
  parentId: string | undefined,
  enabled = true,
  /**
   * A deep-linked note (e.g. from Copy Link or the activity feed) that may not
   * be on page 1. Sent to the server once; when the response reports which
   * page the note actually falls on, the hook jumps there itself so the
   * caller never has to know the note's page ahead of time.
   */
  jumpToNoteId?: string,
): EntityNotesPage {
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPageState] = useState(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState("");
  const [noteType, setNoteTypeState] = useState("all");
  const [timeFilter, setTimeFilterState] = useState<NoteTimeFilter>("all");
  const [tag, setTagState] = useState("");
  const [authorId, setAuthorIdState] = useState("");
  const [dateFrom, setDateFromState] = useState("");
  const [dateTo, setDateToState] = useState("");

  // Only the debounced term reaches the network; the raw value keeps the
  // controlled field snappy on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Each of these re-cuts the list, so the current page number no longer points
  // at the same notes.
  const resetTo = useCallback(<T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  }, []);

  const setRowsPerPage = useMemo(() => resetTo(setRowsPerPageState), [resetTo]);
  const setNoteType = useMemo(() => resetTo(setNoteTypeState), [resetTo]);
  const setTimeFilter = useMemo(() => resetTo(setTimeFilterState), [resetTo]);
  const setTag = useMemo(() => resetTo(setTagState), [resetTo]);
  const setSearch = useMemo(() => resetTo(setSearchInput), [resetTo]);
  const setAuthorId = useMemo(() => resetTo(setAuthorIdState), [resetTo]);
  const setDateFrom = useMemo(() => resetTo(setDateFromState), [resetTo]);
  const setDateTo = useMemo(() => resetTo(setDateToState), [resetTo]);

  // Tracks the jump target once its page has been resolved (found or not), so
  // it's sent to the server exactly once rather than on every subsequent
  // request for the rest of the panel's life.
  const [resolvedJumpId, setResolvedJumpId] = useState<string | undefined>(undefined);
  const [lastJumpData, setLastJumpData] = useState<NotesPageResult | undefined>(undefined);

  const params = useMemo(
    () => ({
      page, limit: rowsPerPage, search: debouncedSearch, noteType, timeFilter, tag,
      authorId: authorId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      jumpToNoteId: jumpToNoteId && resolvedJumpId !== jumpToNoteId ? jumpToNoteId : undefined,
    }),
    [
      page, rowsPerPage, debouncedSearch, noteType, timeFilter, tag, authorId, dateFrom, dateTo,
    ],
  );

  const query = useQuery<NotesPageResult>({
    queryKey: ["entityNotes", parentType, lawFirmId, parentId, params],
    queryFn: () => {
      if (parentType === "firm") return mattersService.listFirmNotes(lawFirmId!, params);
      if (parentType === "matter") return mattersService.listMatterNotes(lawFirmId!, parentId!, params);
      if (parentType === "client") return clientsService.listClientNotes(lawFirmId!, parentId!, params);
      return tasksService.listTaskNotes(lawFirmId!, parentId!, params);
    },
    enabled: enabled && !!lawFirmId && (parentType === "firm" || !!parentId),
    // Hold the previous page on screen while the next one loads, so paging and
    // typing don't blank the list between frames - but only within the SAME
    // parent. Bare `keepPreviousData` hands over the last successful result on
    // ANY key change, not just a same-parent page change, so switching from one
    // matter's (or task's/client's) notes to another's would render the first
    // entity's notes as though they belonged to the second for as long as the
    // new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === parentType
        && prevQuery?.queryKey?.[2] === lawFirmId
        && prevQuery?.queryKey?.[3] === parentId
        ? prev
        : undefined
    ),
  });

  // Once the server has said which page the jump target is actually on, land
  // there. A note already on the requested page (or not found at all) still
  // marks the jump resolved, so it isn't retried on every future request.
  // Adjusted during render rather than in an effect (React's recommended way
  // to react to a changed value without the extra render an effect costs):
  // `lastJumpData` tracks the last response object seen, so this only fires
  // once per fresh response rather than on every render.
  if (
    jumpToNoteId && resolvedJumpId !== jumpToNoteId &&
    query.data !== lastJumpData && query.data?.resolvedPage !== undefined
  ) {
    setLastJumpData(query.data);
    setResolvedJumpId(jumpToNoteId);
    const targetPage = query.data.resolvedPage;
    if (targetPage && targetPage !== page) setPage(targetPage);
  }

  const total = query.data?.totalNotes ?? 0;

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    notes: query.data?.notes ?? EMPTY_NOTES,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, rowsPerPage))),
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    search: searchInput,
    setSearch,
    noteType,
    setNoteType,
    timeFilter,
    setTimeFilter,
    tag,
    setTag,
    authorId,
    setAuthorId,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    tags: query.data?.tags ?? EMPTY_TAGS,
    counts: query.data?.counts ?? EMPTY_COUNTS,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error,
    refresh,
  };
}
