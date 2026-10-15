/**
 * `MoveToFolderModal`'s folder browsing, through the real service layer.
 *
 * What has to break for these to go red:
 *  - a slow listing for a folder the user already left landing on top of the
 *    folder they went back to, so one folder's subfolders sit under another's
 *    breadcrumb (no request-id guard in the fetch);
 *  - the picker reopening at the folder it was last left in, which refetches
 *    that folder first and races the root listing (browse state not reset on
 *    close);
 *  - the picker offering any of the items being moved as a destination.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import MoveToFolderModal from '@/components/filesComp/MoveToFolderModal';
import type { FileInfo } from '@/services/files.service';
import { FIRM_SCOPE } from '@/lib/files/fileScope';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

function folder(id: string, name: string): FileInfo {
  return {
    id,
    parentId: 'scope-root',
    name,
    objectPath: '',
    size: 0,
    contentType: 'folder',
    updated: '2026-08-31T00:00:00.000Z',
    signedUrl: '',
    isFolder: true,
  };
}

const EXHIBITS = folder('folder-x', 'Exhibits');
const NESTED = folder('folder-nested', 'Nested');

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => api.restore());

function picker(isOpen: boolean, excludeIds: string[] = ['file-1']) {
  return (
    <MoveToFolderModal
      isOpen={isOpen}
      onClose={jest.fn()}
      onMove={jest.fn()}
      itemName="document.pdf"
      excludeIds={excludeIds}
      currentFolderId={null}
      lawFirmId="firm-1"
      scope={FIRM_SCOPE}
    />
  );
}

function breadcrumbButtons(dialog: HTMLElement): string[] {
  const root = within(dialog).getByRole('button', { name: 'Root' });
  return within(root.parentElement as HTMLElement)
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

it('ignores a listing for a folder the user has already left', async () => {
  let releaseExhibits: ((value: unknown) => void) | undefined;
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === EXHIBITS.id
      ? new Promise((resolve) => { releaseExhibits = resolve; })
      : { files: [EXHIBITS] }
  );

  renderWithProviders(picker(true));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Exhibits' }));
  // Straight back to the root while Exhibits is still loading.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Root' }));
  expect(await within(dialog).findByRole('button', { name: 'Exhibits' })).toBeInTheDocument();

  await act(async () => {
    releaseExhibits?.({ files: [NESTED] });
    await Promise.resolve();
  });

  expect(breadcrumbButtons(dialog)).toEqual(['Root']);
  expect(within(dialog).getByRole('button', { name: 'Exhibits' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Nested' })).not.toBeInTheDocument();
});

it('reopens at the root without refetching the folder it was left in', async () => {
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === EXHIBITS.id ? { files: [NESTED] } : { files: [EXHIBITS] }
  );

  const { rerender } = renderWithProviders(picker(true));
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Exhibits' }));
  expect(await within(dialog).findByRole('button', { name: 'Nested' })).toBeInTheDocument();

  rerender(picker(false));
  // Past the exit animation and the reset that follows it.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  const requestsBeforeReopen = api.callsTo('/files/list-folder').length;

  rerender(picker(true));
  dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByRole('button', { name: 'Exhibits' })).toBeInTheDocument();

  const reopenRequests = api.callsTo('/files/list-folder').slice(requestsBeforeReopen);
  expect(reopenRequests.map((c) => c.query.folderId?.[0] ?? null)).toEqual([null]);
  expect(breadcrumbButtons(dialog)).toEqual(['Root']);
});

it('offers none of the items being moved as a destination', async () => {
  const alpha = folder('folder-a', 'Alpha');
  const bravo = folder('folder-b', 'Bravo');
  api.get('/files/list-folder', { files: [alpha, bravo, EXHIBITS] });

  renderWithProviders(picker(true, [alpha.id, bravo.id]));
  const dialog = await screen.findByRole('dialog');

  expect(await within(dialog).findByRole('button', { name: 'Exhibits' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Bravo' })).not.toBeInTheDocument();
});
