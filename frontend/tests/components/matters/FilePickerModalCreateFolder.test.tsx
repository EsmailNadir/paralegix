/**
 * Creating a folder from the file picker, through the real files service.
 *
 * What has to break for this to go red: the create firing again on a second
 * Enter (or a click on Create) while the first request is still in flight,
 * which the server refuses as a duplicate of the folder the first one made.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/services/tasks.service', () => ({
  __esModule: true,
  default: { listMatterTasks: jest.fn().mockResolvedValue([]) },
}));

import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FilePickerModal from '@/components/matterComp/FilePickerModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.get('/files/list', { files: [] });
});

afterEach(() => api.restore());

it('sends one create when Enter is pressed again while the first is in flight', async () => {
  api.post('/files/create-folder', { status: 200, body: { message: 'ok' }, delayMs: 50 });
  const user = userEvent.setup();
  render(
    <FilePickerModal open onClose={jest.fn()} onSelect={jest.fn()} lawFirmId="firm-1" matterId="matter-1" />
  );

  await user.click(await screen.findByRole('button', { name: /new folder/i }));
  const input = screen.getByPlaceholderText('Folder name');
  await user.type(input, 'Drafts{Enter}');
  await user.type(input, '{Enter}');
  await user.click(screen.getByRole('button', { name: 'Create' }));

  await waitFor(() => expect(screen.queryByPlaceholderText('Folder name')).not.toBeInTheDocument());
  expect(api.callsTo('/files/create-folder')).toHaveLength(1);
});

// Red if: the picker stays dismissible while the folder is being created (no
// `dismissible={!savingFolder}`), so Escape closes it mid-create and a later
// failure renders into a closed dialog.
it('cannot be closed with Escape until the folder create settles', async () => {
  const create = holdResponse();
  api.post('/files/create-folder', create.handler);
  const onClose = jest.fn();
  const user = userEvent.setup();
  render(
    <FilePickerModal open onClose={onClose} onSelect={jest.fn()} lawFirmId="firm-1" matterId="matter-1" />
  );

  await user.click(await screen.findByRole('button', { name: /new folder/i }));
  await user.type(screen.getByPlaceholderText('Folder name'), 'Drafts{Enter}');
  await create.untilRequested();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => create.release({ message: 'ok' }));
  await waitFor(() => expect(screen.queryByPlaceholderText('Folder name')).not.toBeInTheDocument());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

// Red if: the footer Cancel stays live while the folder is being created, so a
// click closes the picker mid-create the way Escape used to.
it('disables the footer Cancel until the folder create settles', async () => {
  const create = holdResponse();
  api.post('/files/create-folder', create.handler);
  const onClose = jest.fn();
  const user = userEvent.setup();
  render(
    <FilePickerModal open onClose={onClose} onSelect={jest.fn()} lawFirmId="firm-1" matterId="matter-1" />
  );

  await user.click(await screen.findByRole('button', { name: /new folder/i }));
  await user.type(screen.getByPlaceholderText('Folder name'), 'Drafts{Enter}');
  await create.untilRequested();

  // The footer's Cancel, beside Link Selected; the inline folder form has its own.
  const footerCancel = () =>
    within(screen.getByRole('button', { name: 'Link Selected' }).parentElement!).getByRole('button', { name: 'Cancel' });
  const cancel = footerCancel();
  expect(cancel).toBeDisabled();
  await user.click(cancel);
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => create.release({ message: 'ok' }));
  await waitFor(() => expect(footerCancel()).toBeEnabled());
});
