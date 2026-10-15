/**
 * Queries that keep refetching on window focus inside the firm workspace.
 *
 * The firm QueryClient no longer refetches on focus (see `lawFirmQueryClient`).
 * These queries show data that someone OTHER than the viewer changes, with no
 * Realtime channel or invalidation to report it: another member posting a trust
 * transaction, an external signer completing a document, a client fulfilling a
 * document request in the portal, a new message raising the unread badge. For
 * them, coming back to the tab is still the moment to re-read.
 *
 * What has to break for a row to go red: its `REFRESH_ON_FOCUS` spread removed,
 * or overridden by a later `refetchOnWindowFocus: false` or a longer staleTime.
 */
jest.mock('@/services/documentRequests.service', () => ({
  __esModule: true,
  default: {
    list: jest.fn().mockResolvedValue({ requests: [], totalItems: 0 }),
    listForClient: jest.fn().mockResolvedValue([]),
  },
}));

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { focusManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createLawFirmQueryClient } from '@/lib/query/lawFirmQueryClient';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { useSigningSessions } from '@/hooks/signatureHooks/useSigningSessions';
import { useSigningSessionSummary } from '@/hooks/signatureHooks/useSigningSessionSummary';
import { useSigningNeedsMySignature } from '@/hooks/signatureHooks/useSigningNeedsMySignature';
import useDocumentRequests from '@/hooks/documentRequestsHooks/useDocumentRequests';
import useFirmClientDocumentRequests from '@/hooks/documentRequestsHooks/useFirmClientDocumentRequests';
import useTrustAccounts from '@/hooks/trustHooks/useTrustAccounts';
import useClientBalances from '@/hooks/trustHooks/useClientBalances';
import useTrustTransactions from '@/hooks/trustHooks/useTrustTransactions';
import useMatterLedger from '@/hooks/trustHooks/useMatterLedger';
import useClientLedger from '@/hooks/trustHooks/useClientLedger';

const FIRM = 'firm-1';

/** Completed fetches, successful or not, across every query under a key root. */
function fetchesUnder(client: QueryClient, root: string): number {
  return client
    .getQueryCache()
    .findAll({ queryKey: [root] })
    .reduce((sum, query) => sum + query.state.dataUpdateCount + query.state.errorUpdateCount, 0);
}

const cases: Array<[string, string, () => unknown]> = [
  ['useUnreadCount', 'unreadCount', () => useUnreadCount(FIRM)],
  ['useSigningSessions', 'signingSessions', () => useSigningSessions(FIRM)],
  ['useSigningSessionSummary', 'signingSessionSummary', () => useSigningSessionSummary(FIRM)],
  ['useSigningNeedsMySignature', 'signingNeedsMySignature', () => useSigningNeedsMySignature(FIRM)],
  ['useDocumentRequests', 'document-requests', () => useDocumentRequests(FIRM, 'matter-1')],
  ['useFirmClientDocumentRequests', 'document-requests', () => useFirmClientDocumentRequests(FIRM, 'client-1')],
  ['useTrustAccounts', 'trustAccounts', () => useTrustAccounts(FIRM)],
  ['useClientBalances', 'clientTrustBalances', () => useClientBalances(FIRM)],
  ['useTrustTransactions', 'trustTransactions', () => useTrustTransactions(FIRM)],
  ['useMatterLedger', 'matterLedger', () => useMatterLedger(FIRM, 'matter-1')],
  ['useClientLedger', 'clientLedger', () => useClientLedger(FIRM, 'client-1')],
];

afterEach(() => {
  focusManager.setFocused(undefined);
  jest.restoreAllMocks();
});

describe.each(cases)('%s', (_name, keyRoot, useSubject) => {
  it('refetches when the window regains focus after 30 seconds', async () => {
    const client = createLawFirmQueryClient();
    // A mocked service answers `{}`, which some query functions reject; a retry
    // would count as a second fetch and hide whether focus caused one.
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(useSubject, { wrapper });
    await waitFor(() => expect(fetchesUnder(client, keyRoot)).toBe(1));

    const later = Date.now() + 31_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(fetchesUnder(client, keyRoot)).toBe(2));
  });
});
