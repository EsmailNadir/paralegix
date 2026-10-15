/**
 * Offline contract coverage for one status section of a client's or a matter's
 * events (`useClientEventsPage`, `useMatterEventsPage`).
 *
 * The two are separate implementations with the same contract, so one case list
 * runs against both. Each keys its query `[..., lawFirmId, parentId, ...]` with
 * bare `placeholderData: keepPreviousData`, the pattern already found and fixed
 * as a cross-entity leak in `useClientLedger`/`useMatterLedger`/`useTasks`.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import useClientEventsPage from '@/hooks/clientHooks/useClientEventsPage';
import useMatterEventsPage from '@/hooks/matterHooks/useMatterEventsPage';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

type EventsPage = { rows: Array<{ id: string }>; loading: boolean };

const PARENTS = [
  {
    name: 'useClientEventsPage',
    parent: 'client',
    useEvents: (lawFirmId?: string, parentId?: string): EventsPage =>
      useClientEventsPage(lawFirmId, parentId, 'upcoming'),
  },
  {
    name: 'useMatterEventsPage',
    parent: 'matter',
    useEvents: (lawFirmId?: string, parentId?: string): EventsPage =>
      useMatterEventsPage(lawFirmId, parentId, 'upcoming'),
  },
];

describe.each(PARENTS)('$name offline contract', ({ parent, useEvents }) => {
  const url = (parentId: string) => `/lawfirms/firm-a/${parent}s/${parentId}/events`;
  const page = (id: string) => ({ events: [{ id }], totalEvents: 1 });
  const ids = (r: EventsPage) => r.rows.map((e) => e.id);

  itSendsNothingWithoutScope({
    title: `does not request events before a firm and ${parent} exist`,
    api: () => api,
    useHook: () => useEvents(undefined, undefined),
    settled: (r) => r.loading === false,
  });

  it(`fetches the exact ${parent} events endpoint`, async () => {
    api.get(url(`${parent}-a`), page('evt-a'));

    const { result } = renderHook(() => useEvents('firm-a', `${parent}-a`), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(ids(result.current)).toEqual(['evt-a']));
  });

  itKeepsScopeIsolated({
    title: `does not show one ${parent} the events of another after a scope change`,
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ parentId }: { parentId: string }) => useEvents('firm-a', parentId),
    ids,
    a: { props: { parentId: `${parent}-a` }, url: url(`${parent}-a`), body: page(`${parent}-a-event`), ids: [`${parent}-a-event`] },
    b: { props: { parentId: `${parent}-b` }, url: url(`${parent}-b`), body: page(`${parent}-b-event`), ids: [`${parent}-b-event`] },
  });
});
