/**
 * `FileBrowser`'s `rootFolders` list folders that open another file area (a
 * client's matters) above the scope's own items at its root, and `parentCrumb`
 * leads back out of a scope opened from such a folder.
 *
 * What has to break for these to go red: the linked folders not rendering, being
 * drawn after the scope's own items or without their badge, surviving a move into a sub-folder or a
 * search, the root's "Empty folder" state hiding them, or the breadcrumb staying
 * hidden at a scope root that has somewhere to go back to.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import FileBrowser from '@/components/filesComp/FileBrowser';
import type { FileInfo } from '@/services/files.service';
import { clientScope } from '@/lib/files/fileScope';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const OWN_FOLDER: FileInfo = {
  id: 'folder-own',
  parentId: null,
  name: 'Intake Forms',
  objectPath: '',
  size: 0,
  contentType: 'folder',
  updated: '2026-08-31T00:00:00.000Z',
  signedUrl: '',
  isFolder: true,
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => api.restore());

function matterFolder(onOpen = jest.fn()) {
  return {
    id: 'matter-1',
    name: 'Smith v. Jones',
    subtitle: '#2024-001 · 2 files',
    badge: <span data-testid="kind-badge">Matter</span>,
    onOpen,
  };
}

it('lists the linked folders above the scope root\'s own items, and opening one hands off to its area', async () => {
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === OWN_FOLDER.id ? { files: [] } : { files: [OWN_FOLDER] }
  );
  const folder = matterFolder();

  renderWithProviders(
    <FileBrowser lawFirmId="firm-1" scope={clientScope('client-1')} rootFolders={[folder]} />
  );

  const ownRow = await screen.findByText('Intake Forms');
  const matterRow = screen.getByText('Smith v. Jones');
  const row = screen.getByRole('button', { name: /Smith v\. Jones/ });
  expect(within(row).getByText('#2024-001 · 2 files')).toBeInTheDocument();
  expect(within(row).getByTestId('kind-badge')).toHaveTextContent('Matter');
  // The matter row comes first in the document.
  expect(matterRow.compareDocumentPosition(ownRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(matterRow);
  expect(folder.onOpen).toHaveBeenCalledTimes(1);

  // Inside one of the scope's own folders, the matters are no longer listed.
  fireEvent.click(ownRow);
  expect(await screen.findByText('Empty folder')).toBeInTheDocument();
  expect(screen.queryByText('Smith v. Jones')).not.toBeInTheDocument();
});

it('shows the linked folders instead of "Empty folder" at a root with no items of its own', async () => {
  api.get('/files/list-folder', { files: [] });

  renderWithProviders(
    <FileBrowser lawFirmId="firm-1" scope={clientScope('client-1')} rootFolders={[matterFolder()]} />
  );

  expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
  expect(screen.queryByText('Empty folder')).not.toBeInTheDocument();
});

it('leaves the linked folders out of search results', async () => {
  api.get('/files/list-folder', { files: [OWN_FOLDER] });
  api.get('/files/search', { files: [] });

  renderWithProviders(
    <FileBrowser lawFirmId="firm-1" scope={clientScope('client-1')} rootFolders={[matterFolder()]} />
  );
  expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('Search files…'), { target: { value: 'smith' } });

  expect(await screen.findByText('No files found')).toBeInTheDocument();
  expect(screen.queryByText('Smith v. Jones')).not.toBeInTheDocument();
});

it('offers the way back out at the root of a scope opened from another view', async () => {
  api.get('/files/list-folder', { files: [] });
  const onOpen = jest.fn();

  renderWithProviders(
    <FileBrowser
      lawFirmId="firm-1"
      scope={clientScope('client-1')}
      rootLabel="Smith v. Jones"
      parentCrumb={{ label: 'Client Files', onOpen }}
    />
  );
  await screen.findByText('Empty folder');

  const back = screen.getByRole('button', { name: 'Back' });
  const crumbs = back.parentElement as HTMLElement;
  expect(within(crumbs).getByRole('button', { name: 'Smith v. Jones' })).toBeInTheDocument();

  fireEvent.click(within(crumbs).getByRole('button', { name: 'Client Files' }));
  fireEvent.click(back);
  expect(onOpen).toHaveBeenCalledTimes(2);
});
