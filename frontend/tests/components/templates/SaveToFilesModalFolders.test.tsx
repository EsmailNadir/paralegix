/**
 * `SaveToFilesModal`'s folder browser, through the real files service.
 *
 * A folder is addressed by its row id; the server resolves `folderId` with a
 * uuid lookup, so a folder name or a slash-joined chain of names finds nothing.
 *
 * What has to break for these to go red:
 *  - opening a folder sending its name instead of its id as `folderId`;
 *  - "Save Here" inside a folder handing the caller a name instead of the id;
 *  - "New Folder" inside a folder sending a name as `parentId`.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

const mockLookupMatters = jest.fn();
jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: { lookupMatters: (...args: unknown[]) => mockLookupMatters(...args) },
}));

import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import SaveToFilesModal from '@/components/templatesComp/SaveToFilesModal';
import type { FileInfo } from '@/services/files.service';
import { installApiMock, type ApiMock } from '../../support/apiMock';

function folder(id: string, name: string, parentId: string): FileInfo {
  return {
    id,
    parentId,
    name,
    objectPath: '',
    size: 0,
    contentType: 'folder',
    updated: '2026-08-31T00:00:00.000Z',
    signedUrl: '',
    isFolder: true,
  };
}

const CONTRACTS = folder('11111111-1111-4111-8111-111111111111', 'Contracts', 'firm-root');
const SIGNED = folder('22222222-2222-4222-8222-222222222222', 'Signed', CONTRACTS.id);

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  mockLookupMatters.mockReset();
  mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
  api.get('/files/list', { files: [CONTRACTS] });
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === CONTRACTS.id ? { files: [SIGNED] } : { files: [] }
  );
});

afterEach(() => api.restore());

async function openFirmFiles(onConfirm = jest.fn()) {
  const user = userEvent.setup();
  render(
    React.createElement(SaveToFilesModal, {
      open: true,
      onClose: jest.fn(),
      onConfirm,
      lawFirmId: 'firm-1',
      defaultFileName: 'Engagement Letter',
    })
  );
  await user.click(screen.getByRole('button', { name: 'Firm Files' }));
  await user.click(await screen.findByRole('button', { name: /Contracts/ }));
  return { user, onConfirm };
}

it('opens a folder by its id', async () => {
  await openFirmFiles();

  expect(await screen.findByRole('button', { name: /Signed/ })).toBeInTheDocument();
  expect(api.callsTo('/files/list-folder').map((c) => c.query.folderId?.[0])).toEqual([CONTRACTS.id]);
});

it('hands the caller the id of the folder it is saving into', async () => {
  const { user, onConfirm } = await openFirmFiles();
  await screen.findByRole('button', { name: /Signed/ });

  await user.click(screen.getByRole('button', { name: 'Save Here' }));

  expect(onConfirm).toHaveBeenCalledWith({
    scope: 'general',
    folderId: CONTRACTS.id,
    fileName: 'Engagement Letter.pdf',
  });
});

it('creates a new folder under the open folder by its id', async () => {
  api.post('/files/create-folder', { message: 'ok' });
  const { user } = await openFirmFiles();
  await screen.findByRole('button', { name: /Signed/ });

  await user.click(screen.getByRole('button', { name: 'New Folder' }));
  await user.type(screen.getByPlaceholderText('Folder name'), 'Drafts{Enter}');

  await waitFor(() => expect(api.callsTo('/files/create-folder')).toHaveLength(1));
  expect(api.callsTo('/files/create-folder')[0].body).toMatchObject({
    folderName: 'Drafts',
    parentId: CONTRACTS.id,
  });
});

it('sends one create when Enter is pressed again while the first is in flight', async () => {
  api.post('/files/create-folder', { status: 200, body: { message: 'ok' }, delayMs: 50 });
  const { user } = await openFirmFiles();
  await screen.findByRole('button', { name: /Signed/ });

  await user.click(screen.getByRole('button', { name: 'New Folder' }));
  const input = screen.getByPlaceholderText('Folder name');
  await user.type(input, 'Drafts{Enter}');
  await user.type(input, '{Enter}');

  await waitFor(() => expect(screen.queryByPlaceholderText('Folder name')).not.toBeInTheDocument());
  expect(api.callsTo('/files/create-folder')).toHaveLength(1);
});

it('ignores a slow folder listing once the user has gone back to the root', async () => {
  api.get('/files/list-folder', (call) =>
    call.query.folderId?.[0] === CONTRACTS.id
      ? { status: 200, body: { files: [SIGNED] }, delayMs: 80 }
      : { files: [] }
  );
  const user = userEvent.setup();
  render(
    React.createElement(SaveToFilesModal, {
      open: true,
      onClose: jest.fn(),
      onConfirm: jest.fn(),
      lawFirmId: 'firm-1',
      defaultFileName: 'Engagement Letter',
    })
  );
  await user.click(screen.getByRole('button', { name: 'Firm Files' }));
  await user.click(await screen.findByRole('button', { name: /Contracts/ }));
  // Back to the root while Contracts is still loading.
  await user.click(screen.getAllByRole('button', { name: 'Firm Files' })[1]);
  expect(await screen.findByRole('button', { name: /Contracts/ })).toBeInTheDocument();

  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(screen.getByRole('button', { name: /Contracts/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Signed/ })).not.toBeInTheDocument();
});
