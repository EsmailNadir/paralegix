/**
 * `useClientShare.apply`: the share-with-portal action behind every file row and
 * every multi-file selection on the files surfaces.
 *
 * THE DEFECT THIS PINS. `apply` sent one PATCH per target. `Promise.all` first,
 * which opened the whole selection at once against an API instance whose
 * Postgres pool every other request on the instance shares; then four at a time,
 * which was bounded but still one round trip per file. `PATCH
 * /files/bulk-client-visibility` takes the whole set, so a selection of any size
 * is ONE request, and the per-file outcomes come back in its `errors` map.
 *
 * The optimistic UI is what makes the outcome map load-bearing. The rows flip
 * before the answer arrives, so a run where six of eight files shared has to put
 * back exactly two rows: rolling the whole batch back, as the original catch
 * did, left rows saying "not shared" about files the client could already see.
 *
 * `files.service` and the transport under it are real here, so the request body
 * and the `ApiError` handling execute. Only the bulk endpoint is registered with
 * the transport, so a return to a per-file loop fails as an unmatched request
 * rather than quietly passing.
 *
 * WHAT BREAKS THESE: sending one request per file (the call count, and the
 * unmatched `/client-visibility`); rolling every row back when only some ids
 * failed; dropping the `errors` map and reverting to "the request succeeded, so
 * everything shared"; replacing a single row's own server reason with a count.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import { useClientShare } from '@/hooks/fileHooks/useClientShare';
import { clientScope, matterScope } from '@/lib/files/fileScope';
import type { FileInfo } from '@/services/files.service';
import { setupApiMock, type RecordedCall } from '../support/apiMock';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';
const BULK_CLIENT_VISIBILITY = '/files/bulk-client-visibility';
const PICKED = 8;

const api = setupApiMock();

function makeFiles(count: number): FileInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `client/${CLIENT_ID}/doc-${i}.pdf`,
    objectPath: `client/${CLIENT_ID}/doc-${i}.pdf`,
    name: `doc-${i}.pdf`,
    isFolder: false,
    size: 1024,
    clientVisible: false,
    visibleClientIds: null,
  })) as unknown as FileInfo[];
}

/**
 * The server's own answer shape, built from the ids it could not apply.
 *
 * Written out here rather than hard-coded so a spec states its outcome as "these
 * two ids failed" and the envelope stays consistent with the route's contract.
 */
function bulkAnswer(call: RecordedCall, doomed: Set<string> = new Set()) {
  const { fileIds, clientVisible } = call.body as { fileIds: string[]; clientVisible: boolean };
  const failed = fileIds.filter((id) => doomed.has(id));
  return {
    message: 'Bulk visibility update completed',
    requested: fileIds.length,
    updated: fileIds.length - failed.length,
    failed,
    errors: Object.fromEntries(failed.map((id) => [id, 'File not found'])),
    clientVisible,
  };
}

/**
 * Stands in for the page's file list, applying the hook's optimistic patches so
 * a spec can read back what the rows END UP saying, which is where a wrong
 * rollback shows.
 */
function fileStore(initial: FileInfo[]) {
  let files = initial;
  return {
    get files() { return files; },
    patchFiles: (updater: (current: FileInfo[]) => FileInfo[]) => { files = updater(files); },
    visibleIds: () => files.filter((f) => f.clientVisible).map((f) => f.id),
  };
}

/** The ids carried in the one bulk PATCH body. */
const sentFileIds = () =>
  api.calls('PATCH').flatMap((call) => (call.body as { fileIds: string[] }).fileIds);

function setup(store: ReturnType<typeof fileStore>) {
  const onError = jest.fn();
  const onSuccess = jest.fn();
  const view = renderHook(() =>
    useClientShare({
      lawFirmId: LAW_FIRM_ID,
      scope: clientScope(CLIENT_ID),
      // A client's own file area has exactly one recipient with a portal
      // account, so `share` applies straight away with no picker step.
      shareClients: [{ id: CLIENT_ID, name: 'Jane Client', userId: 'user-1' }],
      patchFiles: store.patchFiles,
      onError,
      onSuccess,
    }),
  );
  return { ...view, onError, onSuccess };
}

describe('useClientShare bulk share', () => {
  it('sends the whole selection as one request rather than one per file', async () => {
    const files = makeFiles(PICKED);
    const store = fileStore(files);
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call));

    const { result, onSuccess, onError } = setup(store);
    act(() => { result.current.share(files, true); });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('Shared with client portal'));
    // The whole point. A per-file loop reads 8 here, and its `/client-visibility`
    // requests are not registered at all, so it cannot pass by accident.
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(new Set(sentFileIds())).toEqual(new Set(files.map((f) => f.id)));
    expect((api.calls('PATCH')[0].body as { clientVisible: boolean }).clientVisible).toBe(true);

    expect(onError).not.toHaveBeenCalled();
    // Every row ends up shared, and none is left showing a request in flight.
    expect(store.visibleIds()).toHaveLength(PICKED);
    await waitFor(() => expect(result.current.pendingIds.size).toBe(0));
  });

  it('rolls back only the ids the server reported, and says how many did go', async () => {
    const files = makeFiles(PICKED);
    const store = fileStore(files);
    const doomed = new Set([files[1].id, files[4].id]);
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call, doomed));

    const { result, onError, onSuccess } = setup(store);
    act(() => { result.current.share(files, true); });

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        `${PICKED - doomed.size} of ${PICKED} files shared. ${doomed.size} could not be shared and stayed unchanged.`,
      ),
    );
    // One request, and every id was in it: a partial answer is the server's
    // per-file report, not the client giving up part way.
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(new Set(sentFileIds())).toEqual(new Set(files.map((f) => f.id)));

    // The six that went through stay shared. Rolling them back with the two
    // that failed is what made the rows lie about what the client can see.
    expect(new Set(store.visibleIds())).toEqual(
      new Set(files.filter((f) => !doomed.has(f.id)).map((f) => f.id)),
    );
    // Not a success as well: a partial run is reported once, as a partial run.
    expect(onSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pendingIds.size).toBe(0));
  });

  it("keeps a single row's own server reason rather than counting to one", async () => {
    const files = makeFiles(1);
    const store = fileStore(files);
    api.patch(BULK_CLIENT_VISIBILITY, {
      message: 'Bulk visibility update completed',
      requested: 1,
      updated: 0,
      failed: [files[0].id],
      errors: { [files[0].id]: 'File not found' },
      clientVisible: true,
    });

    const { result, onError } = setup(store);
    act(() => { result.current.share(files, true); });

    // The row toggle is the common case, and "None of the 1 files could be
    // shared" tells the user less than the server already did.
    await waitFor(() => expect(onError).toHaveBeenCalledWith('File not found'));
    expect(store.visibleIds()).toEqual([]);
  });

  it("surfaces a single row's transport error too, not a count", async () => {
    const files = makeFiles(1);
    const store = fileStore(files);
    api.patch(BULK_CLIENT_VISIBILITY, { status: 403, body: { error: 'Not allowed to share this file' } });

    const { result, onError } = setup(store);
    act(() => { result.current.share(files, true); });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Not allowed to share this file'));
    expect(store.visibleIds()).toEqual([]);
  });

  it('reports an unshare run in its own words when the request itself fails', async () => {
    const files = makeFiles(4).map((f) => ({ ...f, clientVisible: true }));
    const store = fileStore(files);
    api.patch(BULK_CLIENT_VISIBILITY, { status: 500, body: { error: 'Server error' } });

    const { result, onError } = setup(store);
    act(() => { result.current.share(files, false); });

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('None of the 4 files could be removed from the portal.'),
    );
    expect(api.calls('PATCH')).toHaveLength(1);
    // A failed request applied nothing, so every row goes back to shared.
    expect(store.visibleIds()).toHaveLength(4);
  });
});

/**
 * What a failed share or unshare puts back. A row's sharing state is two
 * fields, whether the client portal shows it and which clients on the matter
 * it is restricted to, and a selection can mix rows that differ in both.
 *
 * WHAT BREAKS THESE: rolling a failed row back to `!visible` instead of to its
 * own state (an already-hidden row in an unshare turns visible to the client),
 * or dropping the row's `visibleClientIds` on the way back (a file restricted
 * to one client on a matter reads as shared with every client on it).
 */
describe('useClientShare rollback restores each row as it was', () => {
  const MATTER_ID = 'matter-1';
  const CLIENTS = [
    { id: 'client-a', name: 'Ann', userId: 'user-a' },
    { id: 'client-b', name: 'Ben', userId: 'user-b' },
  ];

  /** A file shared with Ben only, and one the portal does not show at all. */
  function mixedRows(): FileInfo[] {
    return [
      { ...makeFiles(1)[0], id: 'restricted', name: 'restricted.pdf', clientVisible: true, visibleClientIds: ['client-b'] },
      { ...makeFiles(1)[0], id: 'hidden', name: 'hidden.pdf', clientVisible: false, visibleClientIds: null },
    ] as FileInfo[];
  }

  const stateOf = (store: ReturnType<typeof fileStore>) =>
    Object.fromEntries(store.files.map((f) => [f.id, { clientVisible: f.clientVisible, visibleClientIds: f.visibleClientIds }]));

  function setupMatter(store: ReturnType<typeof fileStore>) {
    const onError = jest.fn();
    const view = renderHook(() =>
      useClientShare({
        lawFirmId: LAW_FIRM_ID,
        scope: matterScope(MATTER_ID),
        shareClients: CLIENTS,
        patchFiles: store.patchFiles,
        onError,
      }),
    );
    return { ...view, onError };
  }

  it('puts back a hidden row as hidden and a restricted row with its restriction when an unshare request fails', async () => {
    const rows = mixedRows();
    const store = fileStore(rows);
    api.patch(BULK_CLIENT_VISIBILITY, { status: 500, body: { error: 'Server error' } });

    const { result, onError } = setupMatter(store);
    act(() => { result.current.share(rows, false); });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    // The request went out, so the optimistic patch ran and was then undone.
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(stateOf(store)).toEqual({
      restricted: { clientVisible: true, visibleClientIds: ['client-b'] },
      hidden: { clientVisible: false, visibleClientIds: null },
    });
  });

  it('puts back only the rows the server named, each to its own prior state, on a partial share', async () => {
    const rows = mixedRows();
    const store = fileStore(rows);
    // Sharing both with Ann only: the restricted row fails, the hidden one goes.
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call, new Set(['restricted'])));

    const { result, onError } = setupMatter(store);
    act(() => { result.current.share(rows, true); });
    await waitFor(() => expect(result.current.picker.open).toBe(true));
    act(() => { result.current.picker.confirm(['client-a'], false); });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect((api.calls('PATCH')[0].body as { visibleClientIds: string[] }).visibleClientIds).toEqual(['client-a']);
    expect(stateOf(store)).toEqual({
      // Still shared with Ben, as it was before the attempt.
      restricted: { clientVisible: true, visibleClientIds: ['client-b'] },
      // Went through, so it keeps the new audience.
      hidden: { clientVisible: true, visibleClientIds: ['client-a'] },
    });
  });
});
