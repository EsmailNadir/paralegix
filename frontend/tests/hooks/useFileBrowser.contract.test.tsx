/**
 * `useFileBrowser` / `useFileActions` contract: folder navigation and the
 * reload a mutation issues afterward.
 *
 * `useFileBrowser`'s own effect-driven fetch is properly cancellable - each
 * run closes over a `{ cancelled: boolean }` flag that the effect's cleanup
 * flips, and `load` checks it before calling `setFiles`. But `reload()` (what
 * `useFileActions` calls after a delete/move/rename succeeds) invokes that same
 * `load` with NO signal, so its result is applied unconditionally. `reload` is
 * captured once per render inside `useFileActions`'s closure, so a mutation
 * that is already in flight when the user navigates elsewhere keeps a
 * reference to the OLD folder's `load`. When its (slow) response finally
 * lands, it can overwrite the rows on screen with the folder the user is no
 * longer looking at - the same "apply a stale response after an await without
 * checking whether the subject is still current" shape as the sibling
 * `useConversationMessages` pagination bug, just via `reload()` instead of the
 * effect path.
 */
jest.unmock('@/services/files.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import { useFileBrowser } from '@/hooks/fileHooks/useFileBrowser';
import { useFileActions } from '@/hooks/fileHooks/useFileActions';
import { FIRM_SCOPE, matterScope, type FileScope } from '@/lib/files/fileScope';
import type { FileInfo } from '@/services/files.service';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const LAW_FIRM_ID = 'firm-1';

const FOLDER_A: FileInfo = {
  id: 'folder-a',
  parentId: null,
  name: 'A',
  objectPath: '',
  size: 0,
  contentType: 'folder',
  updated: '2026-08-31T00:00:00.000Z',
  signedUrl: '',
  isFolder: true,
};

const KEEP_FILE: FileInfo = {
  id: 'file-keep',
  parentId: 'folder-a',
  name: 'keep.txt',
  objectPath: 'lawfirmids/firm-1/objects/file-keep',
  size: 10,
  contentType: 'text/plain',
  updated: '2026-08-31T00:00:00.000Z',
  signedUrl: '',
  isFolder: false,
};

const api = setupApiMock();

function useHarness() {
  const browser = useFileBrowser({ lawFirmId: LAW_FIRM_ID, scope: FIRM_SCOPE });
  const actions = useFileActions({
    lawFirmId: LAW_FIRM_ID,
    scope: FIRM_SCOPE,
    currentFolderId: browser.currentFolderId,
    reload: browser.reload,
  });
  return { browser, actions };
}

describe('useFileBrowser reload-after-mutation contract', () => {
  it('does not let a stale delete-reload for the folder just left overwrite the folder navigated to', async () => {
    let folderACalls = 0;
    let releaseStaleReload: ((value: unknown) => void) | undefined;

    api.get('/files/list-folder', (call) => {
      const folderId = call.query.folderId?.[0];
      if (folderId === FOLDER_A.id) {
        folderACalls += 1;
        // First call: the real navigation into A. Second call: the reload
        // `useFileActions` issues after the delete resolves - held open so the
        // test controls exactly when it lands.
        if (folderACalls === 1) return { files: [KEEP_FILE] };
        return new Promise((resolve) => { releaseStaleReload = resolve; });
      }
      // Root listing, requested both on mount and again after navigating back.
      return { files: [FOLDER_A] };
    });
    api.delete('/files/delete', { message: 'Deleted' });

    const { result } = renderHook(() => useHarness());

    await waitFor(() => expect(result.current.browser.loading).toBe(false));
    expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']);

    act(() => result.current.browser.openFolder(FOLDER_A));
    await waitFor(() => expect(result.current.browser.currentFolderId).toBe(FOLDER_A.id));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['keep.txt']));

    // Delete the file in A. `useFileActions.removeMany` awaits the DELETE, then
    // calls `reload()` - which is folder A's second `list-folder` call, held
    // open above. Fire it without awaiting: the point is what happens while it
    // is still pending.
    const fileToDelete = result.current.browser.files[0];
    act(() => {
      void result.current.actions.remove(fileToDelete);
    });
    await waitFor(() => expect(folderACalls).toBe(2));
    await waitFor(() => expect(releaseStaleReload).toBeDefined());

    // Leave folder A for the root while that reload is still in flight.
    act(() => result.current.browser.goToTrail([]));
    await waitFor(() => expect(result.current.browser.currentFolderId).toBeNull());
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));

    // Now let the stale reload for A resolve (an empty folder, reflecting the
    // successful delete).
    await act(async () => {
      releaseStaleReload?.({ files: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The browser is on root, showing root's folder. The late answer for a
    // folder the user is no longer viewing must not have replaced it.
    expect(result.current.browser.currentFolderId).toBeNull();
    expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']);
  });
});

describe('useFileBrowser reload started after the user navigated', () => {
  // A mutation's reload is the `reload` captured by the render the action
  // started in. When the mutation resolves after the user has moved, that
  // reload STARTS after the navigation's own load, so the request-id guard
  // treats it as the newest answer. It has to fetch where the browser is now,
  // not where it was when the action began.
  //
  // Goes red if `reload` closes over the render's folder/query instead of
  // reading the latest location when it runs.
  it('fetches the folder on screen, not the folder the mutation started in', async () => {
    const heldDelete = holdResponse();

    api.get('/files/list-folder', (call) => {
      const folderId = call.query.folderId?.[0];
      if (folderId === FOLDER_A.id) return { files: [KEEP_FILE] };
      return { files: [FOLDER_A] };
    });
    // The DELETE is held open, so the reload after it runs only once the test
    // releases it, by which point the user has already left folder A.
    api.delete('/files/delete', heldDelete.handler);

    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));

    act(() => result.current.browser.openFolder(FOLDER_A));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['keep.txt']));

    const fileToDelete = result.current.browser.files[0];
    let removal: Promise<void> | undefined;
    act(() => {
      removal = result.current.actions.remove(fileToDelete);
    });
    await heldDelete.untilRequested();

    act(() => result.current.browser.goToTrail([]));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));
    const listCallsBeforeRelease = api.calls('GET').filter((c) => c.pathname.endsWith('/files/list-folder')).length;

    await act(async () => {
      heldDelete.release({ message: 'Deleted' });
      await removal;
    });

    // The reload ran (proves the assertion below is about its answer)...
    const reloads = api.calls('GET')
      .filter((c) => c.pathname.endsWith('/files/list-folder'))
      .slice(listCallsBeforeRelease);
    expect(reloads).toHaveLength(1);
    // ...and it asked for the root, where the browser now is.
    expect(reloads[0].query.folderId).toBeUndefined();
    expect(result.current.browser.currentFolderId).toBeNull();
    expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']);
  });
});

describe('useFileBrowser leaving a search', () => {
  const HIT: FileInfo = { ...KEEP_FILE, id: 'file-hit', name: 'hit.txt' };

  function seedSearchAndFolders() {
    api.get('/files/search', { files: [HIT] });
    api.get('/files/list-folder', (call) => {
      const folderId = call.query.folderId?.[0];
      if (folderId === FOLDER_A.id) return { files: [KEEP_FILE] };
      return { files: [FOLDER_A] };
    });
  }

  function searchCalls() {
    return api.calls('GET').filter((c) => c.pathname.endsWith('/files/search'));
  }

  // Goes red if navigating clears the search box but leaves the debounced
  // query live: the new folder's first load is then the old search again, and
  // its hits sit under the new breadcrumb until the debounce catches up.
  it('opening a folder from search results lists the folder, never re-running the search', async () => {
    seedSearchAndFolders();
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));

    act(() => result.current.browser.setSearchQuery('hit'));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['hit.txt']));
    expect(searchCalls()).toHaveLength(1);

    act(() => result.current.browser.goToTrail([{ id: FOLDER_A.id, name: FOLDER_A.name }]));

    expect(result.current.browser.isSearching).toBe(false);
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['keep.txt']));
    expect(searchCalls()).toHaveLength(1);
  });

  // Goes red if a scope switch clears only the search box, so the new scope's
  // first request is the previous scope's search.
  it('switching scope while searching lists the new scope rather than searching it', async () => {
    seedSearchAndFolders();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: FileScope }) => {
        const browser = useFileBrowser({ lawFirmId: LAW_FIRM_ID, scope });
        return { browser };
      },
      { initialProps: { scope: FIRM_SCOPE } },
    );
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));

    act(() => result.current.browser.setSearchQuery('hit'));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['hit.txt']));
    expect(searchCalls()).toHaveLength(1);

    rerender({ scope: matterScope('matter-9') });

    await waitFor(() => expect(
      api.calls('GET').some((c) => c.pathname.endsWith('/files/list-folder') && c.query.matterId?.[0] === 'matter-9'),
    ).toBe(true));
    await waitFor(() => expect(result.current.browser.files.map((f) => f.name)).toEqual(['A']));
    expect(searchCalls()).toHaveLength(1);
  });
});
