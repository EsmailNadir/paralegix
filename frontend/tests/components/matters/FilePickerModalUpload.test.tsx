/**
 * Uploading from the file picker (notes, events and document requests) works
 * the way the file manager's upload does.
 *
 * It used to flip its button to "Uploading" with no bar or cancel, report a
 * batch that half-landed as if it had all landed, and lose the upload when the
 * picker was closed mid-way.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockUpload = jest.fn();
const mockListMatterFiles = jest.fn();

jest.mock('@/services/tasks.service', () => ({
  __esModule: true,
  default: { listMatterTasks: jest.fn().mockResolvedValue([]) },
}));

jest.mock('@/services/files.service', () => ({
  __esModule: true,
  default: {
    upload: (...args: unknown[]) => mockUpload(...args),
    listMatterFiles: (...args: unknown[]) => mockListMatterFiles(...args),
    listLawFirmFiles: jest.fn().mockResolvedValue({ files: [] }),
    listFolder: jest.fn().mockResolvedValue({ files: [] }),
  },
}));

import FilePickerModal from '@/components/matterComp/FilePickerModal';
import { FileUploadProvider } from '@/contexts/FileUploadContext';

beforeEach(() => {
  mockUpload.mockReset();
  mockListMatterFiles.mockReset();
  mockListMatterFiles.mockResolvedValue({ files: [] });
});

const props = { onClose: jest.fn(), onSelect: jest.fn(), lawFirmId: 'firm-1', matterId: 'matter-1' };

async function pickFiles(...names: string[]) {
  await screen.findByRole('button', { name: /upload files/i });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map((n) => new File(['abcd'], n, { type: 'application/pdf' })) } });
}

it('shows the bar and a cancel while the upload runs, and locks the button', async () => {
  let signal: AbortSignal | undefined;
  mockUpload.mockImplementation((_firm, _scope, _files, _progress, _folder, uploadSignal) => {
    signal = uploadSignal;
    return new Promise(() => {});
  });
  render(<FilePickerModal {...props} open />);

  await pickFiles('a.pdf');

  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  expect(mockUpload.mock.calls[0][1]).toMatchObject({ matterId: 'matter-1' });
  expect(screen.getByRole('button', { name: /uploading/i })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  expect(signal!.aborted).toBe(true);
});

it('names the files that did not land and refreshes the folder with those that did', async () => {
  mockUpload.mockResolvedValue({
    files: [{ fileId: 'f-1', name: 'a.pdf' }],
    failures: [{ name: 'b.pdf', error: 'The file is larger than this firm allows.' }],
  });
  render(<FilePickerModal {...props} open />);
  await waitFor(() => expect(mockListMatterFiles).toHaveBeenCalledTimes(1));

  await pickFiles('a.pdf', 'b.pdf');

  expect(await screen.findByText('b.pdf: The file is larger than this firm allows.')).toBeInTheDocument();
  await waitFor(() => expect(mockListMatterFiles).toHaveBeenCalledTimes(2));
});

it('carries on when the picker is closed mid-upload', async () => {
  mockUpload.mockImplementation(() => new Promise(() => {}));
  const { rerender } = render(<FileUploadProvider><FilePickerModal {...props} open /></FileUploadProvider>);
  await pickFiles('a.pdf');
  await screen.findByRole('progressbar');

  rerender(<FileUploadProvider><FilePickerModal {...props} open={false} /></FileUploadProvider>);

  // Closed, the picker is not showing the upload, so the pill does, with its cancel.
  expect(await screen.findByText('Uploading 1 file')).toBeInTheDocument();
  await act(async () => {});
  expect(mockUpload).toHaveBeenCalledTimes(1);
});
