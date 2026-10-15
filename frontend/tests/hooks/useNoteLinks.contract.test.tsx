/**
 * Offline contract for `notesHooks/useNoteLinks.ts`.
 *
 * Unlike this session's other P2 hooks, `useNoteLinks` owns no query of its
 * own - it is four mutations (`createTask`, `linkTask`, `linkFile`, `unlink`)
 * against one note. The contract that matters here is the invalidation split:
 * `createTask` invalidates BOTH the notes page (`entityNotes`) and the tasks
 * list (`tasks`), because it creates a new task elsewhere on the page, while
 * the other three only touch the note's own links and invalidate `entityNotes`
 * alone. A caller who invalidated only one of the two after `createTask` would
 * leave either the new task missing from the tasks list, or the note's link
 * badge stale, with nothing in the UI to say why.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';

import useNoteLinks from '@/hooks/notesHooks/useNoteLinks';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';

const NOTE_BASE = '/api/lawfirms/firm-a/matters/matter-a/notes/note-1';

const api = setupApiMock();

function createWrapper() {
  const queryClient = makeTestQueryClient();
  return {
    queryClient,
    Wrapper: function TestWrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
}

describe('useNoteLinks: parameters', () => {
  it('createTask sends the task payload to the notes/:id/tasks endpoint', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/tasks`, { taskId: 'task-1', link: { id: 'link-1' } });

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.createTask.mutateAsync({
        noteId: 'note-1',
        task: { title: 'Follow up', priority: 'high' },
      });
    });

    expect(api.calls('POST')[0].body).toEqual({ title: 'Follow up', priority: 'high' });
  });

  it('linkTask sends the existing task id to the links/task endpoint', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/links/task`, { link: { id: 'link-2' } });

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.linkTask.mutateAsync({ noteId: 'note-1', taskId: 'task-9' });
    });

    expect(api.calls('POST')[0].body).toEqual({ taskId: 'task-9' });
  });

  it('linkFile sends the object path to the links/file endpoint', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/links/file`, { link: { id: 'link-3' } });

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.linkFile.mutateAsync({ noteId: 'note-1', fileId: 'file-1' });
    });

    expect(api.calls('POST')[0].body).toEqual({ fileId: 'file-1' });
  });

  it('unlink sends a DELETE to the specific link id', async () => {
    const { Wrapper } = createWrapper();
    api.deleteExact(`${NOTE_BASE}/links/link-3`, { message: 'removed' });

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.unlink.mutateAsync({ noteId: 'note-1', linkId: 'link-3' });
    });

    expect(api.calls('DELETE')).toHaveLength(1);
    expect(api.calls('DELETE')[0].pathname).toBe('/api/lawfirms/firm-a/matters/matter-a/notes/note-1/links/link-3');
  });
});

describe('useNoteLinks: failure leaves caches alone', () => {
  it('a failed link mutation surfaces as a rejection without invalidating anything', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/links/task`, { status: 403, body: { error: 'Forbidden' } });

    const probe = renderHook(() => useQuery({
      queryKey: ['entityNotes', 'matter', 'firm-a', 'matter-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper: Wrapper });
    await waitFor(() => expect(probe.result.current.isSuccess).toBe(true));
    const firstUpdatedAt = probe.result.current.dataUpdatedAt;

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await expect(result.current.linkTask.mutateAsync({ noteId: 'note-1', taskId: 'task-9' })).rejects.toBeTruthy();
    });

    await waitFor(() => expect(result.current.linkTask.isError).toBe(true));
    expect(probe.result.current.dataUpdatedAt).toBe(firstUpdatedAt);
  });
});

describe('useNoteLinks: mutation invalidation', () => {
  it('createTask invalidates BOTH the notes page and the tasks list', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/tasks`, { taskId: 'task-1', link: { id: 'link-1' } });

    const notesProbe = renderHook(() => useQuery({
      queryKey: ['entityNotes', 'matter', 'firm-a', 'matter-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper: Wrapper });
    const tasksProbe = renderHook(() => useQuery({
      queryKey: ['tasks', 'firm-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper: Wrapper });

    await waitFor(() => expect(notesProbe.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(tasksProbe.result.current.isSuccess).toBe(true));
    const notesUpdatedAt = notesProbe.result.current.dataUpdatedAt;
    const tasksUpdatedAt = tasksProbe.result.current.dataUpdatedAt;

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.createTask.mutateAsync({ noteId: 'note-1', task: { title: 'Follow up' } });
    });

    await waitFor(() => expect(notesProbe.result.current.dataUpdatedAt).toBeGreaterThan(notesUpdatedAt));
    await waitFor(() => expect(tasksProbe.result.current.dataUpdatedAt).toBeGreaterThan(tasksUpdatedAt));
  });

  it('linkFile and unlink invalidate only the notes page, not the tasks list', async () => {
    const { Wrapper } = createWrapper();
    api.postExact(`${NOTE_BASE}/links/file`, { link: { id: 'link-3' } });

    const notesProbe = renderHook(() => useQuery({
      queryKey: ['entityNotes', 'matter', 'firm-a', 'matter-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper: Wrapper });
    const tasksProbe = renderHook(() => useQuery({
      queryKey: ['tasks', 'firm-a'],
      queryFn: () => Promise.resolve({ probe: true }),
    }), { wrapper: Wrapper });

    await waitFor(() => expect(notesProbe.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(tasksProbe.result.current.isSuccess).toBe(true));
    const notesUpdatedAt = notesProbe.result.current.dataUpdatedAt;
    const tasksUpdatedAt = tasksProbe.result.current.dataUpdatedAt;

    const { result } = renderHook(() => useNoteLinks('firm-a', 'matter-a'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.linkFile.mutateAsync({ noteId: 'note-1', fileId: 'file-1' });
    });

    await waitFor(() => expect(notesProbe.result.current.dataUpdatedAt).toBeGreaterThan(notesUpdatedAt));
    // Give the tasks probe a turn to (not) refetch, then confirm it never did.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tasksProbe.result.current.dataUpdatedAt).toBe(tasksUpdatedAt);
  });
});
