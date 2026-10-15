/**
 * The create-folder and rename dialogs submit once per request.
 *
 * Enter in the name field submits, and a second Enter before the first answer
 * came back used to send a second request: the second create was refused as
 * "name taken" by the folder the first one had just made.
 *
 * What has to break for these to go red: either dialog's submit running while
 * its previous submit is still saving.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CreateFolderModal from '@/components/filesComp/CreateFolderModal';
import RenameItemModal from '@/components/filesComp/RenameItemModal';
import type { FileInfo } from '@/services/files.service';

const ITEM: FileInfo = {
  id: 'file-1',
  parentId: 'scope-root',
  name: 'draft.pdf',
  objectPath: 'lawfirmids/firm-1/objects/file-1',
  size: 10,
  contentType: 'application/pdf',
  updated: '2026-08-31T00:00:00.000Z',
  signedUrl: '',
  isFolder: false,
};

/** A request that stays in flight for the rest of the test. */
const pending = () => new Promise<void>(() => {});

it('creates a folder once when Enter is pressed twice', () => {
  const onCreate = jest.fn(pending);
  render(<CreateFolderModal open onClose={jest.fn()} onCreate={onCreate} />);

  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Pleadings' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith('Pleadings', expect.any(String));
});

it('renames once when Enter is pressed twice', () => {
  const onRename = jest.fn(pending);
  render(<RenameItemModal open item={ITEM} onClose={jest.fn()} onRename={onRename} />);

  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'final.pdf' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(onRename).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenCalledWith(ITEM, 'final.pdf');
});
