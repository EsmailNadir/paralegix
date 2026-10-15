/**
 * A standalone task's quick-add uploads the way the file manager does, then
 * records what landed on the task.
 *
 * It used to upload behind a button spinner with no cancel, lose the upload on
 * a tab switch, and drop the batch's failures on the floor: a partial upload
 * read as a success and the files that failed simply vanished from the list.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaskAttachments from '@/components/taskComp/TaskAttachments';
import type { TaskAttachment } from '@/types';

const mockUpload = jest.fn();

jest.mock('@/services/files.service', () => ({
  __esModule: true,
  default: {
    upload: (...args: unknown[]) => mockUpload(...args),
    formatFileSize: (bytes: number) => `${bytes} B`,
  },
}));

beforeEach(() => {
  mockUpload.mockReset();
});

const EXISTING: TaskAttachment = { id: 'old-1', name: 'Existing.pdf', size: 10, type: 'application/pdf' };

function renderTask(onAttachmentsChange = jest.fn(), attachments: TaskAttachment[] = [EXISTING]) {
  const view = render(
    <TaskAttachments
      lawFirmId="firm-1"
      taskId="task-1"
      attachments={attachments}
      onAttachmentsChange={onAttachmentsChange}
      showFileList
      compactUpload
    />,
  );
  return { ...view, onAttachmentsChange };
}

function pickAndUpload(...names: string[]) {
  const input = document.querySelector('input[name="file-upload"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map((n) => new File(['abcd'], n, { type: 'application/pdf' })) } });
  fireEvent.click(screen.getByRole('button', { name: /^upload \d+ files?$/i }));
}

const landed = (name: string, id: string) => ({
  fileId: id, name, size: 4, contentType: 'application/pdf', signedUrl: `https://x/${id}`, objectPath: `objects/${id}`,
});

it('uploads into the task with the bar and a cancel', async () => {
  let signal: AbortSignal | undefined;
  mockUpload.mockImplementation((_firm, _scope, _files, _progress, _folder, uploadSignal) => {
    signal = uploadSignal;
    return new Promise(() => {});
  });
  renderTask();

  pickAndUpload('a.pdf');

  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  expect(mockUpload.mock.calls[0][1]).toMatchObject({ type: 'task', taskId: 'task-1' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  expect(signal!.aborted).toBe(true);
});

it('records what landed on the task, after what was already there', async () => {
  mockUpload.mockResolvedValue({ files: [landed('a.pdf', 'f-1')] });
  const { onAttachmentsChange } = renderTask();

  pickAndUpload('a.pdf');

  await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledTimes(1));
  expect(onAttachmentsChange).toHaveBeenCalledWith([
    EXISTING,
    { id: 'f-1', name: 'a.pdf', size: 4, type: 'application/pdf', url: 'https://x/f-1', objectPath: 'objects/f-1' },
  ]);
  expect(await screen.findByText('Uploaded 1 file')).toBeInTheDocument();
});

it('records only what landed, and names what did not', async () => {
  mockUpload.mockResolvedValue({
    files: [landed('a.pdf', 'f-1')],
    failures: [{ name: 'b.pdf', error: 'The file is larger than this firm allows.' }],
  });
  const { onAttachmentsChange } = renderTask();

  pickAndUpload('a.pdf', 'b.pdf');

  expect(await screen.findByText('b.pdf: The file is larger than this firm allows.')).toBeInTheDocument();
  expect(onAttachmentsChange).toHaveBeenCalledWith([EXISTING, expect.objectContaining({ id: 'f-1' })]);
  expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
  expect(screen.queryByText(/^uploaded \d+ files?$/i)).not.toBeInTheDocument();
});

it('adds to the attachments the task has when the upload lands, not when it started', async () => {
  let settle: ((value: unknown) => void) | undefined;
  mockUpload.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  const onAttachmentsChange = jest.fn();
  const { rerender } = renderTask(onAttachmentsChange);

  pickAndUpload('a.pdf');
  await screen.findByRole('progressbar');
  // Someone removed the old attachment while this was uploading.
  rerender(
    <TaskAttachments
      lawFirmId="firm-1"
      taskId="task-1"
      attachments={[]}
      onAttachmentsChange={onAttachmentsChange}
      showFileList
      compactUpload
    />,
  );

  await act(async () => { settle!({ files: [landed('a.pdf', 'f-1')] }); });

  // Writing back the list as it stood at the start would restore the removed one.
  expect(onAttachmentsChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'f-1' })]);
});
