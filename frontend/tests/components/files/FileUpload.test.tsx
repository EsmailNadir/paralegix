/**
 * The upload dropzone's indicator runs for as long as the upload does.
 *
 * It has been wrong twice. First it animated a timer to 99% in five seconds and
 * ignored the service entirely. Then it followed the service's byte count,
 * which is honest but measures only the transfer: the bytes are sent long
 * before the server has verified each object, read its leading bytes and
 * settled the firm's quota, so the number reached 99 and stopped while the
 * upload was still running. Both read as "stuck" and get the tab closed. One
 * steady indicator, from the click to the response, is the answer.
 */
import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileUpload from '@/components/filesComp/FileUpload';

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

function pickAndUpload(file: File) {
  const input = document.querySelector('input[name="file-upload"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /upload 1 file/i }));
}

it('runs the indicator until the service answers, and claims no position', async () => {
  let finish: (() => void) | undefined;
  mockUpload.mockImplementation(() =>
    new Promise<{ files: unknown[] }>((resolve) => { finish = () => resolve({ files: [] }); }));
  render(<FileUpload lawFirmId="firm-1" />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));

  await waitFor(() => expect(screen.getByText('Uploading')).toBeInTheDocument());

  // No percentage and no width. Either one is a claim about how far along the
  // upload is, and the bar cannot make that claim honestly: the bytes are only
  // the first part of the work.
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

  finish!();
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
});

it('hands the picked files and the scope to the service', async () => {
  mockUpload.mockResolvedValue({ files: [] });
  render(<FileUpload lawFirmId="firm-1" matterId="matter-9" folderId="folder-3" />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));

  await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
  const [firm, scope, files, onProgress, folderId] = mockUpload.mock.calls[0];
  expect(firm).toBe('firm-1');
  expect(scope).toMatchObject({ matterId: 'matter-9' });
  expect((files as File[]).map((f) => f.name)).toEqual(['a.pdf']);
  // The progress slot is passed over, not dropped. Omitting it shifts folderId
  // into it, and the files are then filed at the scope root instead of in the
  // folder the user was looking at.
  expect(onProgress).toBeUndefined();
  expect(folderId).toBe('folder-3');
});

it('shows each file that failed when the rest of a batch landed', async () => {
  mockUpload.mockResolvedValue({
    files: [{ fileId: 'file-1', name: 'landed.pdf' }],
    failures: [
      { name: 'unreadable.pdf', error: 'The upload link expired before the file finished.' },
      { name: 'too-large.pdf', error: 'The file is larger than this firm allows.' },
    ],
  });
  render(<FileUpload lawFirmId="firm-1" />);

  pickAndUpload(new File(['abcd'], 'landed.pdf', { type: 'application/pdf' }));

  expect(await screen.findByText('2 files could not be uploaded.')).toBeInTheDocument();
  expect(screen.getByText('unreadable.pdf: The upload link expired before the file finished.')).toBeInTheDocument();
  expect(screen.getByText('too-large.pdf: The file is larger than this firm allows.')).toBeInTheDocument();
});

it('aborts the active upload when the user cancels it', async () => {
  let signal: AbortSignal | undefined;
  mockUpload.mockImplementation((_firm, _scope, _files, _onProgress, _folder, uploadSignal) => {
    signal = uploadSignal;
    return new Promise(() => {});
  });
  render(<FileUpload lawFirmId="firm-1" />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));

  expect(signal!.aborted).toBe(true);
});

it('reports nothing when the service says the upload was cancelled', async () => {
  const cancelled = new Error('Upload cancelled');
  cancelled.name = 'UploadCancelledError';
  mockUpload.mockRejectedValue(cancelled);
  const onError = jest.fn();
  render(<FileUpload lawFirmId="firm-1" onError={onError} />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));

  await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
  // The upload control comes back once the attempt has settled.
  await waitFor(() => expect(screen.getByRole('button', { name: /upload 1 file/i })).toBeInTheDocument());
  // The user asked for this; an error toast for it reads as something broke.
  expect(onError).not.toHaveBeenCalled();
});

it('drops the cancel once the files are past the point a cancel can stop', async () => {
  let reachFinalize: (() => void) | undefined;
  mockUpload.mockImplementation((_firm, _scope, _files, _onProgress, _folder, _signal, onFinalizing) => {
    reachFinalize = onFinalizing;
    return new Promise(() => {});
  });
  render(<FileUpload lawFirmId="firm-1" />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));
  // Offered while bytes are moving, which is when it does something.
  expect(await screen.findByRole('button', { name: 'Cancel upload' })).toBeInTheDocument();

  act(() => reachFinalize!());

  // The server files what landed whatever a cancel says; a control left here
  // would be clicked, do nothing, and the files would appear anyway.
  expect(screen.queryByRole('button', { name: 'Cancel upload' })).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

it('says the page can be left while it uploads, but not the browser tab', async () => {
  let finish: (() => void) | undefined;
  mockUpload.mockImplementation(() =>
    new Promise<{ files: unknown[] }>((resolve) => { finish = () => resolve({ files: [] }); }));
  render(<FileUpload lawFirmId="firm-1" />);
  expect(screen.queryByText(/closing the paralegix tab or your browser will stop it/i)).not.toBeInTheDocument();

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));

  // Without it an upload of minutes holds the person on this screen, or they
  // close the tab believing it carries on the way leaving the page does.
  const note = await screen.findByText(/closing the paralegix tab or your browser will stop it/i);
  expect(note).toHaveTextContent(/you can keep using paralegix while this uploads/i);

  await act(async () => { finish!(); });
  expect(screen.queryByText(/closing the paralegix tab or your browser will stop it/i)).not.toBeInTheDocument();
});

it('holds the picked files still while they upload', async () => {
  mockUpload.mockImplementation(() => new Promise(() => {}));
  render(<FileUpload lawFirmId="firm-1" />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));
  await screen.findByRole('progressbar');

  // The list on screen is what is being uploaded. Adding, removing or clearing
  // files mid-upload would make it describe something else.
  const dropzone = screen.getByText('Upload files').closest('[aria-disabled]') as HTMLElement;
  expect(dropzone).toHaveAttribute('aria-disabled', 'true');
  fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], 'b.pdf')] } });
  expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeDisabled();
});

it('tells the caller which files did not land', async () => {
  const failures = [{ name: 'b.pdf', error: 'The file is larger than this firm allows.' }];
  mockUpload.mockResolvedValue({ files: [{ fileId: 'file-1', name: 'a.pdf' }], failures });
  const onUploadComplete = jest.fn();
  render(<FileUpload lawFirmId="firm-1" onUploadComplete={onUploadComplete} />);

  pickAndUpload(new File(['abcd'], 'a.pdf', { type: 'application/pdf' }));

  await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1));
  expect(onUploadComplete).toHaveBeenCalledWith([{ fileId: 'file-1', name: 'a.pdf' }], failures);
});

it('keeps only the failed one of two same-named files selected', async () => {
  mockUpload.mockResolvedValue({
    files: [{ fileId: 'file-1', name: 'Scan.pdf' }],
    failures: [{ name: 'Scan.pdf', error: 'The upload link expired before the file finished.', index: 1 }],
  });
  render(<FileUpload lawFirmId="firm-1" />);
  const input = document.querySelector('input[name="file-upload"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [
        new File(['abcd'], 'Scan.pdf', { type: 'application/pdf' }),
        new File(['wxyz1'], 'Scan.pdf', { type: 'application/pdf' }),
      ],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: /upload 2 files/i }));

  await screen.findByText('1 file could not be uploaded.');

  // The first one landed. Kept selected because it shares the failed one's
  // name, the next click uploads it again as "Scan (1).pdf".
  expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
  expect(screen.getByText('5 B')).toBeInTheDocument();
});

describe('dropping a folder', () => {
  /** A drop the way a browser delivers one: files, and an entry per item. */
  function dropItems(dropzone: HTMLElement, items: Array<{ file: File; isDirectory: boolean }>) {
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: items.map((item) => item.file),
        items: items.map((item) => ({
          kind: 'file',
          getAsFile: () => item.file,
          webkitGetAsEntry: () => ({ isDirectory: item.isDirectory, isFile: !item.isDirectory, name: item.file.name }),
        })),
      },
    });
  }

  it('leaves the folder out and says why, keeping the files beside it', async () => {
    render(<FileUpload lawFirmId="firm-1" />);
    const dropzone = screen.getByText('Upload files').closest('[aria-disabled]') as HTMLElement;

    // A browser hands a dropped folder over as a File with the folder's name
    // and nothing readable in it. Selected, it breaks the whole batch when the
    // upload reads it, or uploads as an empty document.
    dropItems(dropzone, [
      { file: new File([''], 'Discovery', { type: '' }), isDirectory: true },
      { file: new File(['abcd'], 'a.pdf', { type: 'application/pdf' }), isDirectory: false },
    ]);

    expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Discovery: Folders can't be uploaded/);
  });

  it('still takes a drop from a browser with no entry API', async () => {
    render(<FileUpload lawFirmId="firm-1" />);
    const dropzone = screen.getByText('Upload files').closest('[aria-disabled]') as HTMLElement;

    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['abcd'], 'a.pdf')] } });

    expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
  });
});
