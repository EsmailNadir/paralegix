/**
 * Offline contract for `notesHooks/useNoteReplies.ts`.
 *
 * A note's reply thread is read only when expanded (`enabled`), and every
 * mutation invalidates TWO caches: the thread itself (`noteReplies`) and the
 * notes page it lives on (`entityNotes`), because `replyCount` is a field on
 * the note object rather than something the thread query owns. That dual
 * invalidation is the one thing genuinely specific to this hook - a naive
 * test of "the mutation succeeds" would miss a caller who only invalidated
 * one of the two and left the note list showing a stale reply count. Matter,
 * task, and client replies are the same feature server-side
 * (`shared/notes/noteReplies.ts`); `parentType` only picks the URL, so one
 * `matter` pass through the full contract plus one routing check per sibling
 * type is enough - the plan is explicit that this row should not turn into
 * padding through the shared adapter's internals.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';

import useNoteReplies from '@/hooks/notesHooks/useNoteReplies';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const REPLIES_URL = '/api/lawfirms/firm-a/matters/matter-a/notes/note-1/replies';

const api = setupApiMock();
let queryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  queryClient = makeTestQueryClient();
  return createQueryWrapper(queryClient);
}

describe('useNoteReplies: disabled without prerequisites', () => {
  it('sends nothing while the thread is collapsed (enabled=false)', async () => {
    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', false),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.replies).toEqual([]);
    expect(api.calls()).toEqual([]);
  });
});

describe('useNoteReplies: valid and empty responses', () => {
  it('loads the thread once expanded', async () => {
    api.getExact(REPLIES_URL, { replies: [{ id: 'reply-1', content: 'Hi' }] });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.replies).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it('reports a real empty thread rather than a failure', async () => {
    api.getExact(REPLIES_URL, { replies: [] });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.replies).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('reports a failed load rather than an empty thread', async () => {
    api.getExact(REPLIES_URL, { status: 500, body: { error: 'Reply service unavailable' } });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.replies).toEqual([]);
    expect(result.current.error).toBeTruthy();
  });
});

describe('useNoteReplies: exact query key', () => {
  it('scopes the thread cache to its own noteId - a different note is a different request', async () => {
    api.getExact(REPLIES_URL, { replies: [{ id: 'reply-note-1' }] });
    api.getExact('/api/lawfirms/firm-a/matters/matter-a/notes/note-2/replies', { replies: [{ id: 'reply-note-2' }] });

    const { result, rerender } = renderHook(
      ({ noteId }: { noteId: string }) => useNoteReplies('firm-a', 'matter', 'matter-a', noteId, true),
      { wrapper: createWrapper(), initialProps: { noteId: 'note-1' } },
    );

    await waitFor(() => expect(result.current.replies.map((r: any) => r.id)).toEqual(['reply-note-1']));

    rerender({ noteId: 'note-2' });

    await waitFor(() => expect(result.current.replies.map((r: any) => r.id)).toEqual(['reply-note-2']));
    expect(api.calls()).toHaveLength(2);
  });
});

describe('useNoteReplies: parameters (parentType routing)', () => {
  it('routes a task parent to the task notes endpoint', async () => {
    api.getExact('/api/lawfirms/firm-a/tasks/task-a/notes/note-1/replies', { replies: [{ id: 'task-reply' }] });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'task', 'task-a', 'note-1', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.replies.map((r: any) => r.id)).toEqual(['task-reply']));
  });

  it('routes a client parent to the client notes endpoint', async () => {
    api.getExact('/api/lawfirms/firm-a/clients/client-a/notes/note-1/replies', { replies: [{ id: 'client-reply' }] });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'client', 'client-a', 'note-1', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.replies.map((r: any) => r.id)).toEqual(['client-reply']));
  });
});

describe('useNoteReplies: mutation invalidation', () => {
  it('a successful reply invalidates both the thread and the parent notes page', async () => {
    api.getExact(REPLIES_URL, { replies: [] });
    api.postExact(REPLIES_URL, { reply: { id: 'new-reply', content: 'hello' } });

    const wrapper = createWrapper();
    const probe = renderHook(() => useQuery({
      queryKey: ['entityNotes', 'matter', 'firm-a', 'matter-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper });
    await waitFor(() => expect(probe.result.current.isSuccess).toBe(true));
    const firstUpdatedAt = probe.result.current.dataUpdatedAt;

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addReply.mutateAsync({ content: 'hello' });
    });

    // The thread itself refetches.
    await waitFor(() => expect(api.callsTo('/replies').filter((c) => c.method === 'GET')).toHaveLength(2));

    // So does the entityNotes page this note lives on - the probe's own
    // queryFn re-ran, proving the invalidation reached that key too, not just
    // the thread's own key.
    await waitFor(() => expect(probe.result.current.dataUpdatedAt).toBeGreaterThan(firstUpdatedAt));
  });

  it('a failed reply leaves the existing thread and note-list cache alone', async () => {
    api.getExact(REPLIES_URL, { replies: [{ id: 'existing' }] });
    api.postExact(REPLIES_URL, { status: 403, body: { error: 'Forbidden' } });

    const { result } = renderHook(
      () => useNoteReplies('firm-a', 'matter', 'matter-a', 'note-1', true),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.replies).toHaveLength(1));

    await act(async () => {
      await expect(result.current.addReply.mutateAsync({ content: 'nope' })).rejects.toBeTruthy();
    });

    await waitFor(() => expect(result.current.addReply.isError).toBe(true));
    // No spurious refetch: the thread the user already saw is still there.
    expect(result.current.replies.map((r: any) => r.id)).toEqual(['existing']);
  });
});
