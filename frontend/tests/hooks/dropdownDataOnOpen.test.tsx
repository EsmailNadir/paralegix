/**
 * Dropdown data held back until the picker that needs it opens.
 *
 * Courts, charge codes, the firm user roster and the firm member list feed
 * pickers inside modals that are closed on page load. Loading them with the
 * page cost a request per list on every visit for a modal most visits never
 * open. Each hook takes an `enabled` flag so the caller can pass the modal's
 * open state, and keeps its cache key, so a second open, or another screen that
 * loads the same list ungated, reuses the one cache entry.
 *
 * What has to break for these to go red: `enabled` ignored (the request goes
 * out while closed), or the key changed by the flag (a second open refetches).
 */
jest.unmock('@/services/courts.service');
jest.unmock('@/services/chargeCodes.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import useCourts from '@/hooks/courtHooks/useCourts';
import useChargeCodes from '@/hooks/chargeCodeHooks/useChargeCodes';
import { useLawFirmUsers } from '@/hooks/useUsers';
import { useFirmMembers } from '@/hooks/useFirmMembers';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';
import { makeTestQueryClient } from '../support/renderWithProviders';

const FIRM = 'firm-1';

const api = setupApiMock();

beforeEach(() => {
  __resetDuplicateRequestGuard();
});

type Case = {
  name: string;
  path: string;
  body: object;
  use: (enabled: boolean) => unknown;
  loaded: (result: unknown) => boolean;
};

const cases: Case[] = [
  {
    name: 'useCourts',
    path: `/api/lawfirms/${FIRM}/courts`,
    body: { courts: [{ id: 'court-1', name: 'Superior Court' }] },
    use: (enabled) => useCourts(FIRM, enabled),
    loaded: (result) => (result as ReturnType<typeof useCourts>).courts.length === 1,
  },
  {
    name: 'useChargeCodes',
    path: `/api/lawfirms/${FIRM}/billing/charge-codes`,
    body: { chargeCodes: [{ id: 'cc-1', code: 'A100', name: 'Research' }] },
    use: (enabled) => useChargeCodes(FIRM, false, enabled),
    loaded: (result) => (result as ReturnType<typeof useChargeCodes>).chargeCodes.length === 1,
  },
  {
    name: 'useLawFirmUsers',
    path: `/api/users/lawfirm/${FIRM}/users`,
    body: [{ uid: 'user-1', name: 'Ada', email: 'ada@example.test' }],
    use: (enabled) => useLawFirmUsers(FIRM, enabled),
    loaded: (result) => (result as ReturnType<typeof useLawFirmUsers>).users.length === 1,
  },
  {
    name: 'useFirmMembers',
    path: `/api/lawfirms/${FIRM}/members`,
    body: { members: [{ userId: 'user-1', name: 'Ada', email: 'ada@example.test' }] },
    use: (enabled) => useFirmMembers(FIRM, enabled),
    loaded: (result) => (result as ReturnType<typeof useFirmMembers>).length === 1,
  },
];

describe.each(cases)('$name', ({ path, body, use, loaded }) => {
  it('makes no request while the picker is closed, loads on open, and serves a second open from cache', async () => {
    api.get(path, body);
    const client = makeTestQueryClient();
    // Fresh for the life of the spec, as the firm client keeps it for minutes.
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, staleTime: 60_000, gcTime: 60_000 } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(({ open }: { open: boolean }) => use(open), {
      wrapper,
      initialProps: { open: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo(path)).toHaveLength(0);

    rerender({ open: true });
    await waitFor(() => expect(loaded(result.current)).toBe(true));
    expect(api.callsTo(path)).toHaveLength(1);

    rerender({ open: false });
    rerender({ open: true });
    const second = renderHook(() => use(true), { wrapper });
    expect(loaded(second.result.current)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo(path)).toHaveLength(1);
  });
});
