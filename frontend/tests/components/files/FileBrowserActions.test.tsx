/**
 * `FileBrowser`'s actions and the dialogs they open, through the real service
 * layer.
 *
 * What has to break for these to go red:
 *  - a bulk delete that stops partway leaving the already-deleted rows on
 *    screen, or leaving them counted in the selection;
 *  - the bulk move picker offering one of the folders being moved as the
 *    destination (A moves into B, then B fails);
 *  - the move picker not recognising the root as where a root-level row
 *    already is, so "Move here" re-moves it to the same place;
 *  - a refused rename closing its dialog and throwing away the typed name;
 *  - a refused drag-and-drop move escaping as an unhandled rejection.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import FileBrowser from '@/components/filesComp/FileBrowser';
import type { FileInfo } from '@/services/files.service';
import { FIRM_SCOPE } from '@/lib/files/fileScope';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

/** The scope's own root folder, which is what a root-level row's parentId is. */
const SCOPE_ROOT_ID = 'scope-root';

function file(id: string, name: string, overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id,
    parentId: SCOPE_ROOT_ID,
    name,
    objectPath: `lawfirmids/firm-1/objects/${id}`,
    size: 10,
    contentType: 'application/pdf',
    updated: '2026-08-31T00:00:00.000Z',
    signedUrl: '',
    isFolder: false,
    ...overrides,
  };
}

function folder(id: string, name: string, overrides: Partial<FileInfo> = {}): FileInfo {
  return file(id, name, { isFolder: true, contentType: 'folder', size: 0, objectPath: '', ...overrides });
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => api.restore());

function checkboxFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('[draggable]') as HTMLElement;
  return within(row).getByRole('checkbox');
}

function openRowMenu(name: string) {
  const row = screen.getByText(name).closest('[draggable]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
}

it('drops the already-deleted rows and their selection when a bulk delete stops partway', async () => {
  const a = file('a', 'a.pdf');
  const b = file('b', 'b.pdf');
  const c = file('c', 'c.pdf');
  api.get('/files/list-folder', sequence(
    { files: [a, b, c] },
    // After the refusal: a is gone, b was refused, c was never reached.
    { files: [b, c] },
  ));
  api.delete('/files/delete', (call) =>
    call.query.fileId?.[0] === 'b'
      ? { status: 409, body: { error: 'This record is archived and cannot be deleted' } }
      : { message: 'Deleted' }
  );
  const onError = jest.fn();

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} onError={onError} />);
  await screen.findByText('a.pdf');

  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  fireEvent.click(screen.getByRole('button', { name: /3 selected/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const confirm = await screen.findByRole('dialog');
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(screen.queryByText('a.pdf')).not.toBeInTheDocument());
  expect(screen.getByText('b.pdf')).toBeInTheDocument();
  expect(screen.getByText('c.pdf')).toBeInTheDocument();
  // The selection now counts only rows that are still here.
  expect(screen.getByRole('button', { name: /2 selected/ })).toBeInTheDocument();
  expect(onError).toHaveBeenCalledWith('Deleted 1 of 3 items. This record is archived and cannot be deleted');
});

it('keeps every folder being moved out of the bulk move picker', async () => {
  const folderA = folder('folder-a', 'Alpha');
  const folderB = folder('folder-b', 'Bravo');
  const folderC = folder('folder-c', 'Charlie');
  api.get('/files/list-folder', { files: [folderA, folderB, folderC] });

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} />);
  await screen.findByText('Alpha');

  fireEvent.click(checkboxFor('Alpha'));
  fireEvent.click(checkboxFor('Bravo'));
  fireEvent.click(screen.getByRole('button', { name: /2 selected/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));

  const picker = await screen.findByRole('dialog');
  expect(await within(picker).findByRole('button', { name: 'Charlie' })).toBeInTheDocument();
  expect(within(picker).queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
  expect(within(picker).queryByRole('button', { name: 'Bravo' })).not.toBeInTheDocument();
});

it('treats the root as where a root-level row already is', async () => {
  // A root-level row's parentId is the scope's root folder id, not null.
  api.get('/files/list-folder', { folderId: SCOPE_ROOT_ID, files: [file('a', 'a.pdf')] });

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} />);
  await screen.findByText('a.pdf');

  openRowMenu('a.pdf');
  fireEvent.click(await screen.findByRole('button', { name: 'Move to…' }));

  const picker = await screen.findByRole('dialog');
  expect(await within(picker).findByText('No subfolders here')).toBeInTheDocument();
  expect(within(picker).getByText('This is the current location of the item.')).toBeInTheDocument();
  expect(within(picker).getByRole('button', { name: 'Move here' })).toBeDisabled();
});

// Goes red if a refused move is handed to the page behind the picker instead
// of shown inside it, or if the refusal closes the picker.
it('shows a refused move inside the still-open move picker', async () => {
  const target = folder('folder-x', 'Exhibits');
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === target.id ? { files: [] } : { files: [target, file('a', 'a.pdf')] }
  );
  api.post('/files/move', { status: 409, body: { error: 'A file with that name already exists there' } });

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} onError={jest.fn()} />);
  await screen.findByText('a.pdf');

  openRowMenu('a.pdf');
  fireEvent.click(await screen.findByRole('button', { name: 'Move to…' }));
  const picker = await screen.findByRole('dialog');
  fireEvent.click(await within(picker).findByRole('button', { name: 'Exhibits' }));
  await within(picker).findByText('No subfolders here');
  fireEvent.click(within(picker).getByRole('button', { name: 'Move here' }));

  expect(await within(picker).findByText('A file with that name already exists there')).toBeInTheDocument();
  expect(api.callsTo('/files/move')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBe(picker);
});

describe('a search hit', () => {
  const inner = folder('folder-x', 'Exhibits');

  function renderSearch(hit: FileInfo) {
    api.get('/files/list-folder', (call) =>
      call.query.folderId?.[0] === inner.id ? { files: [] } : { files: [inner] }
    );
    api.get('/files/search', { files: [hit] });
    renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} />);
  }

  async function searchAndOpenMove(name: string) {
    await screen.findByText('Exhibits');
    fireEvent.change(screen.getByPlaceholderText('Search files…'), { target: { value: 'hit' } });
    await screen.findByText(name);
    openRowMenu(name);
    fireEvent.click(await screen.findByRole('button', { name: 'Move to…' }));
    return screen.findByRole('dialog');
  }

  it('found at the root counts the root as its current location', async () => {
    renderSearch(file('hit-root', 'hit-root.pdf', { trail: [] }));

    const picker = await searchAndOpenMove('hit-root.pdf');
    await within(picker).findByRole('button', { name: 'Exhibits' });
    expect(within(picker).getByRole('button', { name: 'Move here' })).toBeDisabled();
  });

  it('found in a folder counts that folder, not the root, as its current location', async () => {
    renderSearch(file('hit-inner', 'hit-inner.pdf', {
      parentId: inner.id,
      trail: [{ id: inner.id, name: inner.name }],
    }));

    const picker = await searchAndOpenMove('hit-inner.pdf');
    fireEvent.click(await within(picker).findByRole('button', { name: 'Exhibits' }));
    expect(await within(picker).findByText('No subfolders here')).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: 'Move here' })).toBeDisabled();

    fireEvent.click(within(picker).getByRole('button', { name: 'Root' }));
    await within(picker).findByRole('button', { name: 'Exhibits' });
    expect(within(picker).getByRole('button', { name: 'Move here' })).toBeEnabled();
  });
});

it('keeps the rename dialog open with the typed name when the server refuses it', async () => {
  api.get('/files/list-folder', { files: [file('a', 'a.pdf')] });
  api.post('/files/rename', { status: 409, body: { error: 'That name is already taken' } });

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} onError={jest.fn()} />);
  await screen.findByText('a.pdf');

  openRowMenu('a.pdf');
  fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog');
  const input = within(dialog).getByRole('textbox');
  fireEvent.change(input, { target: { value: 'taken.pdf' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

  expect(await within(dialog).findByText('That name is already taken')).toBeInTheDocument();
  expect(api.callsTo('/files/rename')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByRole('textbox')).toHaveValue('taken.pdf');
});

describe('drag-and-drop move', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('reports a refused drop without leaving an unhandled rejection', async () => {
    const target = folder('folder-x', 'Exhibits');
    api.get('/files/list-folder', { files: [target, file('a', 'a.pdf')] });
    api.post('/files/move', { status: 409, body: { error: 'A file with that name already exists there' } });
    const onError = jest.fn();

    renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} onError={onError} />);
    await screen.findByText('a.pdf');

    const dragged = screen.getByText('a.pdf').closest('[draggable]') as HTMLElement;
    const dropTarget = screen.getByText('Exhibits').closest('[draggable]') as HTMLElement;
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('A file with that name already exists there'));
    // Give a floating rejection the turns it needs to be reported.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(unhandled).toEqual([]);
  });
});
