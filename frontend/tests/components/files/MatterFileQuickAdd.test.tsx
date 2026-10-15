/**
 * Quick add, on a matter's and a task's overview, uploads the way the file
 * manager does: the same bar and cancel, the same account of what failed, and
 * an upload that carries on when the overview is left.
 *
 * It used to hold its upload in local state behind a button spinner, reported
 * "Upload successful" when only some files landed, and cleared the list, so
 * the files that failed disappeared without a word.
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MatterFileQuickAdd from '@/components/filesComp/MatterFileQuickAdd';
import FileUpload from '@/components/filesComp/FileUpload';
import { FileUploadProvider } from '@/contexts/FileUploadContext';

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

function pickAndUpload(...names: string[]) {
  const input = document.querySelector('input[name="file-upload"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map((n) => new File(['abcd'], n, { type: 'application/pdf' })) } });
  fireEvent.click(screen.getByRole('button', { name: /^upload \d+ files?$/i }));
}

it('uploads into the task within its matter, with the bar and a cancel', async () => {
  let signal: AbortSignal | undefined;
  mockUpload.mockImplementation((_firm, _scope, _files, _progress, _folder, uploadSignal) => {
    signal = uploadSignal;
    return new Promise(() => {});
  });
  render(<MatterFileQuickAdd lawFirmId="firm-1" matterId="matter-1" taskId="task-1" />);

  pickAndUpload('a.pdf');

  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  expect(mockUpload.mock.calls[0][1]).toMatchObject({ matterId: 'matter-1', taskId: 'task-1' });
  expect(screen.getByText(/you can keep using paralegix while this uploads/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  expect(signal!.aborted).toBe(true);
});

it('names the files that failed, keeps them, and does not claim success', async () => {
  mockUpload.mockResolvedValue({
    files: [{ fileId: 'f-1', name: 'landed.pdf' }],
    failures: [{ name: 'failed.pdf', error: 'The file is larger than this firm allows.' }],
  });
  const onUploadComplete = jest.fn();
  render(<MatterFileQuickAdd lawFirmId="firm-1" matterId="matter-1" onUploadComplete={onUploadComplete} />);

  pickAndUpload('landed.pdf', 'failed.pdf');

  expect(await screen.findByText('failed.pdf: The file is larger than this firm allows.')).toBeInTheDocument();
  // The one that failed stays picked for another try; the one that landed goes.
  expect(screen.getByText('Selected Files (1)')).toBeInTheDocument();
  expect(screen.queryByText(/^uploaded \d+ files?$/i)).not.toBeInTheDocument();
  expect(onUploadComplete).toHaveBeenCalledTimes(1);
});

it('confirms a batch that landed whole', async () => {
  mockUpload.mockResolvedValue({ files: [{ fileId: 'f-1', name: 'a.pdf' }, { fileId: 'f-2', name: 'b.pdf' }] });
  render(<MatterFileQuickAdd lawFirmId="firm-1" matterId="matter-1" />);

  pickAndUpload('a.pdf', 'b.pdf');

  expect(await screen.findByText('Uploaded 2 files')).toBeInTheDocument();
  expect(screen.queryByText(/selected files/i)).not.toBeInTheDocument();
});

/** The overview and the Documents tab, one at a time, as the matter page shows them. */
function MatterTabs() {
  const [tab, setTab] = useState<'overview' | 'documents'>('overview');
  return (
    <>
      <button type="button" onClick={() => setTab('overview')}>Overview tab</button>
      <button type="button" onClick={() => setTab('documents')}>Documents tab</button>
      {tab === 'overview'
        ? <MatterFileQuickAdd lawFirmId="firm-1" matterId="matter-1" />
        : <FileUpload lawFirmId="firm-1" matterId="matter-1" />}
    </>
  );
}

it('carries on when the overview is left, without taking over the Documents dropzone', async () => {
  let settle: ((value: unknown) => void) | undefined;
  mockUpload.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);

  pickAndUpload('a.pdf');
  await screen.findByRole('progressbar');
  fireEvent.click(screen.getByRole('button', { name: 'Documents tab' }));

  // The Documents dropzone is idle: the upload belongs to quick add, whose
  // completion does different work. The pill says it is still running.
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByText('Uploading 1 file')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Overview tab' }));
  expect(screen.getByRole('progressbar')).toBeInTheDocument();

  await act(async () => { settle!({ files: [{ fileId: 'f-1', name: 'a.pdf' }] }); });
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
});
