'use client';

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { REFRESH_ON_FOCUS } from '@/lib/query/lawFirmQueryClient';
import signaturesService from '@/services/signatures.service';
import useServerTable, { recoverOutOfRangePage, type ServerTableQueryParams } from '@/hooks/useServerTable';
import type { SigningSession } from '@/types/signature';
import { getErrorMessage } from '@/lib/utils/apiErrors';

/** Rows per page the activity list opens with. */
export const SIGNING_SESSIONS_PAGE_SIZE = 10;

/**
 * The table state the activity list opens with, as `useServerTable` builds it.
 * The signatures page seeds this page under this key on open.
 */
export const INITIAL_SIGNING_SESSIONS_PARAMS: ServerTableQueryParams = {
  page: 1,
  limit: SIGNING_SESSIONS_PAGE_SIZE,
  sort: [],
  search: '',
  filters: {},
};

export const signingSessionsQueryKey = (lawFirmId: string, queryParams: ServerTableQueryParams) =>
  ['signingSessions', lawFirmId, queryParams] as const;

/**
 * One page of the firm's signing sessions, plus the certificate-download and
 * void/cancel actions. Backs the signing-activity list on the signatures page,
 * which is the whole history with the search and status filter wired up.
 *
 * Sessions are append-only, so the history grows without bound and the server
 * owns the paging, search and status filter. `totalItems` counts the whole
 * filtered history, so the "N documents" header stays honest on any page.
 *
 * `enabled: false` holds the read back while the page's combined workspace
 * request is filling this entry.
 */
export function useSigningSessions(
  lawFirmId: string,
  onError?: (message: string) => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const [downloadingCert, setDownloadingCert] = useState<string | null>(null);
  const [cancellingSession, setCancellingSession] = useState<string | null>(null);

  const table = useServerTable({
    defaultSort: [],
    defaultRowsPerPage: SIGNING_SESSIONS_PAGE_SIZE,
  });
  const { page, rowsPerPage, setPage, setRowsPerPage, search, setSearch, filters, setFilter, queryParams } = table;

  const { data, isLoading, isFetching, isError, error: queryError, refetch } = useQuery<{
    sessions: SigningSession[];
    totalItems: number;
  }>({
    queryKey: signingSessionsQueryKey(lawFirmId, queryParams),
    queryFn: () =>
      signaturesService.listSigningSessions(lawFirmId, {
        page: queryParams.page,
        limit: queryParams.limit,
        status: queryParams.filters.status,
        search: queryParams.search || undefined,
      }) as Promise<{ sessions: SigningSession[]; totalItems: number }>,
    enabled: enabled && !!lawFirmId,
    // External signers and other members move sessions along with nothing
    // pushing that here, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
    // Only within the SAME firm. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, not just a same-firm page change,
    // so switching firms would render the previous firm's signing sessions as
    // though they belonged to the new one for as long as the new request is
    // in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  const sessions = data?.sessions ?? [];
  const totalItems = data?.totalItems ?? 0;

  recoverOutOfRangePage({
    loading: isLoading || isFetching,
    rowCount: sessions.length,
    total: totalItems,
    page,
    setPage,
  });

  // Voiding a session moves it between pages (and can drop it from the history
  // entirely), so refresh every cached page rather than just the one on screen.
  // Its status changed too, so the per-status counts beside the filters are stale
  // as well.
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['signingSessions', lawFirmId] }),
      queryClient.invalidateQueries({ queryKey: ['signingSessionSummary', lawFirmId] }),
    ]);
  }, [queryClient, lawFirmId]);

  const downloadCertificate = useCallback(async (token: string) => {
    setDownloadingCert(token);
    try {
      await signaturesService.downloadCertificate(token);
    } catch (err) {
      onError?.(getErrorMessage(err, 'Failed to download certificate'));
    } finally {
      setDownloadingCert(null);
    }
  }, [onError]);

  const cancelSession = useCallback(async (token: string) => {
    setCancellingSession(token);
    try {
      await signaturesService.cancelSigningSession(token);
      await refresh();
    } catch (err) {
      onError?.(getErrorMessage(err, 'Failed to cancel signing session'));
    } finally {
      setCancellingSession(null);
    }
  }, [onError, refresh]);

  const setStatusFilter = useCallback(
    (value: string) => setFilter('status', value || undefined),
    [setFilter]
  );

  return {
    sessions,
    totalItems,
    loading: isLoading,
    fetching: isFetching,
    error: isError ? getErrorMessage(queryError, 'Failed to load signing history') : null,
    refresh,
    refetch,
    /** 1-based. */
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    /** Raw input value, for the controlled search field. */
    search,
    setSearch,
    statusFilter: filters.status ?? '',
    setStatusFilter,
    downloadingCert,
    cancellingSession,
    downloadCertificate,
    cancelSession,
  };
}
