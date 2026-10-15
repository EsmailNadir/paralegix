/**
 * `useFileActions` contract: what a mutation leaves behind when the server
 * refuses it.
 *
 * A bulk delete or move runs item by item, so it can stop partway: the first
 * items are already gone from the folder when a later one is refused. The list
 * on screen has to be reloaded after that too, or it keeps showing rows that no
 * longer exist there, and a retry fails at once on the first of them.
 *
 * A rename or colour change that fails has to reject, because the dialog that
 * called it closes on resolve and would throw away what the user typed.
 *
 * What has to break for these to go red: the failure path skipping the reload,
 * the error dropping the count of items that did go through, or a failed
 * rename/colour change resolving instead of rejecting.
 */
jest.unmock('@/services/files.service');

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';

import { FileExportProvider } from '@/contexts/FileExportContext';
import { useFileActions } from '@/hooks/fileHooks/useFileActions';
import { FIRM_SCOPE, matterScope } from '@/lib/files/fileScope';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import type { FileInfo } from '@/services/files.service';
import { installApiMock, type ApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const LAW_FIRM_ID = 'firm-1';

function makeFile(id: string, overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id,
    parentId: 'root-1',
    name: `${id}.pdf`,
    objectPath: `lawfirmids/firm-1/objects/${id}`,
    size: 10,
    contentType: 'application/pdf',
    updated: '2026-08-31T00:00:00.000Z',
    signedUrl: '',
    isFolder: false,
    ...overrides,
  };
}

const ITEMS = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e')];

let api: ApiMock;
let reload: jest.Mock;
let onError: jest.Mock;
let onSuccess: jest.Mock;

function renderActions() {
  return renderHook(() =>
    useFileActions({
      lawFirmId: LAW_FIRM_ID,
      scope: FIRM_SCOPE,
      currentFolderId: null,
      reload,
      onError,
      onSuccess,
    })
  );
}

beforeEach(() => {
  api = installApiMock();
  reload = jest.fn().mockResolvedValue(undefined);
  onError = jest.fn();
  onSuccess = jest.fn();
});

afterEach(() => api.restore());

describe('bulk delete that stops partway', () => {
  beforeEach(() => {
    // The third item is refused; the two before it are really deleted.
    api.delete('/files/delete', (call) =>
      call.query.fileId?.[0] === 'c'
        ? { status: 409, body: { error: 'This record is archived and cannot be deleted' } }
        : { message: 'Deleted' }
    );
  });

  it('reloads the list so the items already deleted leave the screen', async () => {
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.removeMany(ITEMS)).rejects.toThrow();
    });

    expect(api.callsTo('/files/delete').map((c) => c.query.fileId?.[0])).toEqual(['a', 'b', 'c']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('says how many items were deleted before the refusal', async () => {
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.removeMany(ITEMS)).rejects.toThrow();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'Deleted 2 of 5 items. This record is archived and cannot be deleted'
    );
  });

  it('reports a single-item failure without a count', async () => {
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.remove(makeFile('c'))).rejects.toThrow();
    });

    expect(onError).toHaveBeenCalledWith('This record is archived and cannot be deleted');
  });
});

describe('bulk move that stops partway', () => {
  beforeEach(() => {
    api.post('/files/move', (call) =>
      (call.body as { fileId: string }).fileId === 'd'
        ? { status: 409, body: { error: 'A file with that name already exists there' } }
        : { message: 'Moved' }
    );
  });

  it('reloads the list so the items already moved leave the screen', async () => {
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.move(ITEMS, 'folder-x')).rejects.toThrow();
    });

    expect(api.callsTo('/files/move')).toHaveLength(4);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('says how many items were moved before the refusal', async () => {
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.move(ITEMS, 'folder-x')).rejects.toThrow();
    });

    expect(onError).toHaveBeenCalledWith(
      'Moved 3 of 5 items. A file with that name already exists there'
    );
  });
});

describe('rename and folder colour failures', () => {
  it('rejects a rename the server refuses, after reporting it', async () => {
    api.post('/files/rename', { status: 409, body: { error: 'That name is already taken' } });
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.rename(makeFile('a'), 'taken.pdf')).rejects.toThrow(
        'That name is already taken'
      );
    });

    expect(onError).toHaveBeenCalledWith('That name is already taken');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('rejects a folder colour change the server refuses, after reporting it', async () => {
    api.post('/files/update-folder-color', { status: 403, body: { error: 'Not allowed' } });
    const { result } = renderActions();
    const folder = makeFile('f', { isFolder: true, contentType: 'folder' });

    await act(async () => {
      await expect(result.current.setFolderColor(folder, 'red')).rejects.toThrow('Not allowed');
    });

    expect(onError).toHaveBeenCalledWith('Not allowed');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

/**
 * The success paths, run in a MATTER's file browser so each request also has
 * to carry the scope. A request that dropped it would act on the firm's
 * General Files instead, with the same success message.
 */
const MATTER = matterScope('matter-7');

function renderScoped(
  overrides: { currentFolderId?: string | null } = {},
  wrapper?: React.ComponentType<{ children: React.ReactNode }>,
) {
  return renderHook(() =>
    useFileActions({
      lawFirmId: LAW_FIRM_ID,
      scope: MATTER,
      currentFolderId: overrides.currentFolderId ?? null,
      reload,
      onError,
      onSuccess,
    }), { wrapper });
}

describe('downloading one plain file', () => {
  let clicked: Array<{ href: string; download: string }>;
  let click: jest.SpyInstance;

  beforeEach(() => {
    // Each spec fetches the same signed-url endpoint, which the dev-only
    // duplicate-GET warning would otherwise report across specs.
    __resetDuplicateRequestGuard();
    clicked = [];
    click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => click.mockRestore());

  it('hands the browser the signed url for that file, showing progress until it does', async () => {
    const signed = holdResponse();
    api.get('/files/download-url', signed.handler);
    const { result } = renderScoped();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.download(makeFile('a'));
    });
    await signed.untilRequested();
    expect(result.current.downloadingLabel).toBe('Downloading…');

    await act(async () => {
      signed.release({ downloadUrl: 'https://storage.test/a.pdf?sig=1' });
      await pending;
    });

    expect(api.callsTo('/files/download-url')[0].query).toEqual({ lawFirmId: [LAW_FIRM_ID], fileId: ['a'] });
    expect(clicked).toEqual([{ href: 'https://storage.test/a.pdf?sig=1', download: 'a.pdf' }]);
    expect(result.current.downloadingLabel).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a refused download and clears the progress label', async () => {
    api.get('/files/download-url', { status: 403, body: { error: 'You cannot download this file' } });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.download(makeFile('a'));
    });

    expect(onError).toHaveBeenCalledWith('You cannot download this file');
    expect(clicked).toEqual([]);
    expect(result.current.downloadingLabel).toBeNull();
  });

  it('downloads a one-file selection directly rather than building an archive', async () => {
    api.get('/files/download-url', { downloadUrl: 'https://storage.test/b.pdf' });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.downloadMany([makeFile('b')]);
    });

    expect(clicked).toHaveLength(1);
    expect(api.callsTo('/files/export-jobs')).toEqual([]);
  });
});

describe('downloading a folder or a selection as an archive', () => {
  it('asks for the folder archive in this scope, and reports a refusal', async () => {
    api.post('/files/export-jobs', { status: 403, body: { error: 'Exports are disabled for this firm' } });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.download(makeFile('folder-1', { isFolder: true, contentType: 'folder', name: 'Pleadings' }));
    });

    expect(api.callsTo('/files/export-jobs').map((c) => c.body)).toEqual([{ matterId: 'matter-7', folderId: 'folder-1' }]);
    expect(onError).toHaveBeenCalledWith('Exports are disabled for this firm');
  });

  it('asks for one archive of every selected item, and reports a refusal', async () => {
    api.post('/files/export-jobs', { status: 403, body: { error: 'Exports are disabled for this firm' } });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.downloadMany([makeFile('a'), makeFile('b')]);
    });

    expect(api.callsTo('/files/export-jobs').map((c) => c.body)).toEqual([{ matterId: 'matter-7', fileIds: ['a', 'b'] }]);
    expect(onError).toHaveBeenCalledWith('Exports are disabled for this firm');
  });

  it('sends a one-folder selection as a selection archive, not down the single-file path', async () => {
    api.post('/files/export-jobs', { status: 403, body: { error: 'Exports are disabled for this firm' } });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.downloadMany([makeFile('folder-1', { isFolder: true, contentType: 'folder' })]);
    });

    expect(api.callsTo('/files/download-url')).toEqual([]);
    expect(api.callsTo('/files/export-jobs').map((c) => c.body)).toEqual([{ matterId: 'matter-7', fileIds: ['folder-1'] }]);
  });

  it('does nothing for an empty selection', async () => {
    const { result } = renderScoped();

    await act(async () => {
      await result.current.downloadMany([]);
    });

    expect(api.calls()).toEqual([]);
  });

  it('treats a cancelled archive as the person changing their mind, not as a failure', async () => {
    const job = holdResponse();
    api.post('/files/export-jobs', job.handler);
    const { result } = renderScoped({}, FileExportProvider);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.downloadMany([makeFile('a'), makeFile('b')]);
    });
    await job.untilRequested();

    await act(async () => {
      result.current.cancelDownload();
      await pending;
    });

    expect(onError).not.toHaveBeenCalled();
  });
});

describe('writes that succeed', () => {
  it('deletes every selected item in this scope, reloads once, and counts them', async () => {
    api.delete('/files/delete', { message: 'Deleted' });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.removeMany([makeFile('a'), makeFile('b'), makeFile('c')]);
    });

    expect(api.callsTo('/files/delete').map((c) => c.query)).toEqual(['a', 'b', 'c'].map((id) => ({ matterId: ['matter-7'], fileId: [id] })));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('Deleted 3 items');
    expect(result.current.deleting).toBe(false);
  });

  it('says a single delete went through without a count, and shows it is busy meanwhile', async () => {
    const del = holdResponse();
    api.delete('/files/delete', del.handler);
    const { result } = renderScoped();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.remove(makeFile('a'));
    });
    await del.untilRequested();
    expect(result.current.deleting).toBe(true);

    await act(async () => {
      del.release({ message: 'Deleted' });
      await pending;
    });

    expect(onSuccess).toHaveBeenCalledWith('Deleted successfully');
    expect(result.current.deleting).toBe(false);
  });

  it('renames with the trimmed name in this scope, then reloads', async () => {
    api.post('/files/rename', { message: 'Renamed' });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.rename(makeFile('a'), '  Final brief.pdf  ');
    });

    expect(api.callsTo('/files/rename').map((c) => c.body)).toEqual([
      { lawFirmId: LAW_FIRM_ID, matterId: 'matter-7', fileId: 'a', newName: 'Final brief.pdf' },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('Renamed successfully');
  });

  it('ignores a blank rename or folder name without sending anything', async () => {
    const { result } = renderScoped();

    await act(async () => {
      await result.current.rename(makeFile('a'), '   ');
      await result.current.createFolder('   ');
    });

    expect(api.calls()).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('creates a folder inside the open folder, with its colour', async () => {
    api.post('/files/create-folder', { message: 'Created' });
    const { result } = renderScoped({ currentFolderId: 'folder-open' });

    await act(async () => {
      await result.current.createFolder(' Discovery ', 'blue');
    });

    expect(api.callsTo('/files/create-folder').map((c) => c.body)).toEqual([
      { lawFirmId: LAW_FIRM_ID, matterId: 'matter-7', folderName: 'Discovery', parentId: 'folder-open', folderColor: 'blue' },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('Folder created');
  });

  it("creates a folder at the scope's root when no folder is open", async () => {
    api.post('/files/create-folder', { message: 'Created' });
    const { result } = renderScoped({ currentFolderId: null });

    await act(async () => {
      await result.current.createFolder('Discovery');
    });

    expect(api.callsTo('/files/create-folder')[0].body).not.toHaveProperty('parentId');
  });

  it('rejects a refused folder create after reporting it, so the dialog keeps the name', async () => {
    api.post('/files/create-folder', { status: 409, body: { error: 'A folder with that name exists' } });
    const { result } = renderScoped();

    await act(async () => {
      await expect(result.current.createFolder('Discovery')).rejects.toThrow('A folder with that name exists');
    });

    expect(onError).toHaveBeenCalledWith('A folder with that name exists');
    expect(reload).not.toHaveBeenCalled();
  });

  it('recolours a folder in this scope, then reloads', async () => {
    api.post('/files/update-folder-color', { message: 'Updated' });
    const { result } = renderScoped();

    await act(async () => {
      await result.current.setFolderColor(makeFile('f', { isFolder: true }), 'green');
    });

    expect(api.callsTo('/files/update-folder-color').map((c) => c.body)).toEqual([
      { lawFirmId: LAW_FIRM_ID, matterId: 'matter-7', folderId: 'f', folderColor: 'green' },
    ]);
    expect(onSuccess).toHaveBeenCalledWith('Folder color updated');
  });

  it('moves every item to the scope root, shows it is busy meanwhile, then reloads once', async () => {
    const first = holdResponse();
    api.post('/files/move', (call) => ((call.body as { fileId: string }).fileId === 'a' ? first.handler() : { message: 'Moved' }));
    const { result } = renderScoped();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.move([makeFile('a'), makeFile('b')], null);
    });
    await first.untilRequested();
    expect(result.current.moving).toBe(true);

    await act(async () => {
      first.release({ message: 'Moved' });
      await pending;
    });

    // No destination means the root: the field is left out, not sent as null.
    expect(api.callsTo('/files/move').map((c) => c.body)).toEqual([
      { lawFirmId: LAW_FIRM_ID, matterId: 'matter-7', fileId: 'a' },
      { lawFirmId: LAW_FIRM_ID, matterId: 'matter-7', fileId: 'b' },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('Moved successfully');
    await waitFor(() => expect(result.current.moving).toBe(false));
  });

  it('does nothing for an empty delete or move', async () => {
    const { result } = renderScoped();

    await act(async () => {
      await result.current.removeMany([]);
      await result.current.move([], 'folder-x');
    });

    expect(api.calls()).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });
});
