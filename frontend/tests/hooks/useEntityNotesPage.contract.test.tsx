/**
 * Offline contract coverage for the shared notes-panel hook.
 *
 * `useEntityNotesPage` backs the notes panel on matters, tasks, clients, and
 * (with `parentType: "firm"`) the firm-wide notes list - one implementation
 * shared across all four, per the "matters/tasks/clients grow the same
 * features" rule. It shares the `[..., lawFirmId, parentId, ...]` query-key
 * shape and bare `placeholderData: keepPreviousData` already found and fixed
 * as a cross-entity leak in `useClientLedger`/`useMatterLedger`/`useTasks`.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import useEntityNotesPage from '@/hooks/useEntityNotesPage';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useEntityNotesPage offline contract', () => {
  it('does not request notes before a firm and parent exist', async () => {
    const { result } = renderHook(
      () => useEntityNotesPage(undefined, 'matter', undefined),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact matter notes endpoint', async () => {
    api.get('/lawfirms/firm-a/matters/matter-a/notes', { notes: [{ id: 'note-a' }], totalNotes: 1 });

    const { result } = renderHook(
      () => useEntityNotesPage('firm-a', 'matter', 'matter-a'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['note-a']));
  });

  // Matter B's notes request is still pending here. Matter A's notes must not
  // render as though they belong to matter B while it loads - the same
  // cross-entity `keepPreviousData` leak already fixed in `useClientLedger`
  // and `useMatterLedger`, here between two different matters' notes.
  itKeepsScopeIsolated({
    title: 'does not show one matter the notes of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ matterId }: { matterId: string }) => useEntityNotesPage('firm-a', 'matter', matterId),
    ids: (r) => r.notes.map((n) => n.id),
    a: { props: { matterId: 'matter-a' }, url: '/lawfirms/firm-a/matters/matter-a/notes', body: { notes: [{ id: 'matter-a-note' }], totalNotes: 1 }, ids: ['matter-a-note'] },
    b: { props: { matterId: 'matter-b' }, url: '/lawfirms/firm-a/matters/matter-b/notes', body: { notes: [{ id: 'matter-b-note' }], totalNotes: 1 }, ids: ['matter-b-note'] },
  });
});

type NotesParent = 'matter' | 'task' | 'client';

// Each parent's notes live under its own url segment (`createNotesApi` in
// `services/notesApi.ts`), and the first request carries only the default page
// window: every other filter is at its "all" value and so is left off the url.
const NOTES_PARENTS: Array<{ parentType: NotesParent; segment: string; other: NotesParent; otherSegment: string }> = [
  { parentType: 'matter', segment: 'matters', other: 'task', otherSegment: 'tasks' },
  { parentType: 'task', segment: 'tasks', other: 'client', otherSegment: 'clients' },
  { parentType: 'client', segment: 'clients', other: 'matter', otherSegment: 'matters' },
];

const notesUrl = (segment: string, parentId: string) =>
  `/api/lawfirms/firm-a/${segment}/${parentId}/notes?page=1&limit=10`;

describe.each(NOTES_PARENTS)(
  'useEntityNotesPage per parent: $parentType',
  ({ parentType, segment, other, otherSegment }) => {
    it(`requests exactly the ${parentType} notes endpoint with the default page window`, async () => {
      api.getExact(notesUrl(segment, `${parentType}-endpoint`), {
        notes: [{ id: `${parentType}-endpoint-note` }],
        totalNotes: 1,
      });

      const { result } = renderHook(
        () => useEntityNotesPage('firm-a', parentType, `${parentType}-endpoint`),
        { wrapper: createQueryWrapper() },
      );

      await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual([`${parentType}-endpoint-note`]));
      const calls = api.calls('GET');
      expect(calls).toHaveLength(1);
      expect(calls[0].pathname).toBe(`/api/lawfirms/firm-a/${segment}/${parentType}-endpoint/notes`);
      expect(calls[0].query).toEqual({ page: ['1'], limit: ['10'] });
    });

    // Two different parents of the same type: the first one's notes must not
    // stand in for the second's while the second request is in flight.
    itKeepsScopeIsolated({
      title: `does not show one ${parentType} the notes of another ${parentType} after a scope change`,
      mode: 'pending',
      match: 'exact',
      api: () => api,
      useHook: ({ parentId }: { parentId: string }) => useEntityNotesPage('firm-a', parentType, parentId),
      ids: (r) => r.notes.map((n) => n.id),
      a: {
        props: { parentId: `${parentType}-one` },
        url: notesUrl(segment, `${parentType}-one`),
        body: { notes: [{ id: `${parentType}-one-note` }], totalNotes: 1 },
        ids: [`${parentType}-one-note`],
      },
      b: {
        props: { parentId: `${parentType}-two` },
        url: notesUrl(segment, `${parentType}-two`),
        body: { notes: [{ id: `${parentType}-two-note` }], totalNotes: 1 },
        ids: [`${parentType}-two-note`],
      },
    });

    // Ids are uuids, but nothing stops a matter and a task from sharing one in
    // a test fixture or a migrated row. The cache key has to carry the parent
    // type, or the second panel would be handed the first panel's notes.
    it(`keeps a ${parentType} and a ${other} with the same id in separate cache entries`, async () => {
      const sharedId = `shared-${parentType}-${other}`;
      api.getExact(notesUrl(segment, sharedId), {
        notes: [{ id: `${parentType}-note` }],
        totalNotes: 1,
      });
      api.getExact(notesUrl(otherSegment, sharedId), {
        notes: [{ id: `${other}-note` }],
        totalNotes: 1,
      });

      const { result } = renderHook(
        () => ({
          first: useEntityNotesPage('firm-a', parentType, sharedId),
          second: useEntityNotesPage('firm-a', other, sharedId),
        }),
        { wrapper: createQueryWrapper() },
      );

      await waitFor(() => {
        expect(result.current.first.notes.map((n) => n.id)).toEqual([`${parentType}-note`]);
        expect(result.current.second.notes.map((n) => n.id)).toEqual([`${other}-note`]);
      });
      expect(api.calls('GET').map((c) => c.pathname).sort()).toEqual([
        `/api/lawfirms/firm-a/${segment}/${sharedId}/notes`,
        `/api/lawfirms/firm-a/${otherSegment}/${sharedId}/notes`,
      ].sort());
    });
  },
);
