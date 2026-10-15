/**
 * An upload outlives the tab that started it.
 *
 * The dropzone sits inside a tab (a matter's Documents, a client's Files), and
 * switching tabs unmounts it. The upload used to carry on with nothing on
 * screen: no bar, no cancel, a file list never told it had finished, and a
 * dropzone that looked idle and invited the same file again.
 *
 * These cases unmount the dropzone and keep the provider, which is exactly
 * what a tab switch does, and require the upload to still be running, still
 * stoppable, and picked back up by the dropzone that returns.
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FileUpload from '@/components/filesComp/FileUpload';
import { FileUploadProvider, useFileUploads, type UploadListener } from '@/contexts/FileUploadContext';

const mockUpload = jest.fn();

jest.mock('@/services/files.service', () => ({
  __esModule: true,
  default: {
    upload: (...args: unknown[]) => mockUpload(...args),
    formatFileSize: (bytes: number) => `${bytes} B`,
  },
}));

type Settle = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** An upload the test finishes, with the signal and finalize hook it was handed. */
function pendingUpload() {
  const state: { settle?: Settle; signal?: AbortSignal; onFinalizing?: () => void } = {};
  mockUpload.mockImplementation((_firm, _scope, _files, _onProgress, _folder, signal, onFinalizing) => {
    state.signal = signal;
    state.onFinalizing = onFinalizing;
    return new Promise((resolve, reject) => { state.settle = { resolve, reject }; });
  });
  return state;
}

/** Two tabs: Documents holds the dropzone, Notes does not. */
function MatterTabs(props: {
  onComplete?: (files: unknown[]) => void;
  matterId?: string;
  uploadSlot?: string;
}) {
  const [tab, setTab] = useState<'documents' | 'notes'>('documents');
  return (
    <>
      <button type="button" onClick={() => setTab('documents')}>Documents tab</button>
      <button type="button" onClick={() => setTab('notes')}>Notes tab</button>
      {tab === 'documents' && (
        <FileUpload
          lawFirmId="firm-1"
          matterId={props.matterId ?? 'matter-9'}
          uploadSlot={props.uploadSlot}
          onUploadComplete={props.onComplete}
        />
      )}
    </>
  );
}

function pickAndUpload(name = 'a.pdf') {
  const input = document.querySelector('input[name="file-upload"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['abcd'], name, { type: 'application/pdf' })] } });
  fireEvent.click(screen.getByRole('button', { name: /upload 1 file/i }));
}

const pill = () => screen.queryByText(/^Uploading \d+ files?$/);

beforeEach(() => {
  mockUpload.mockReset();
});

describe('an upload in flight', () => {
  it('keeps running when the tab that started it is left', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    expect(pill()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));

    // The dropzone is gone and the upload is not stopped. The pill is rendered
    // by the provider, so it says the upload is still going where the bar was.
    expect(document.querySelector('input[name="file-upload"]')).toBeNull();
    expect(upload.signal!.aborted).toBe(false);
    expect(pill()).toHaveTextContent('Uploading 1 file');
  });

  it('is picked back up, bar and cancel, when the tab comes back', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload('brief.pdf');
    await waitFor(() => expect(upload.signal).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Documents tab' }));

    // A fresh dropzone showing nothing reads as an upload that stopped, and
    // invites the same file a second time.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /uploading/i })).toBeDisabled();
    expect(pill()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(upload.signal!.aborted).toBe(true);
  });

  it('tells the returned dropzone when it finishes, once', async () => {
    const upload = pendingUpload();
    const onComplete = jest.fn();
    render(<FileUploadProvider><MatterTabs onComplete={onComplete} /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Documents tab' }));

    await act(async () => { upload.settle!.resolve({ files: [{ fileId: 'f-1' }] }); });

    // The file list refreshes from this callback, and a second call is a second
    // round of whatever the page does on completion.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith([{ fileId: 'f-1' }], []);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // What landed leaves the list, so it is not offered for upload again.
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
  });

  it('can be cancelled from the pill while the tab is away', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(upload.signal!.aborted).toBe(true);
  });

  it('offers no cancel in the pill once the files are being filed', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    act(() => upload.onFinalizing!());

    expect(pill()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('says how it went when it finishes with no dropzone on screen', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));

    await act(async () => { upload.settle!.reject(new Error('The file is larger than this firm allows.')); });

    // The dropzone that would have reported this is gone, so without the toast
    // a failed upload looks exactly like one that landed.
    expect(pill()).not.toBeInTheDocument();
    expect(screen.getByText('The file is larger than this firm allows.')).toBeInTheDocument();
  });

  it('does not count a file the response does not name as uploaded', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));

    await act(async () => { upload.settle!.resolve({ files: [] }); });

    // Counting the files picked instead of the files named said "Uploaded 1
    // file" for an upload that stored nothing.
    expect(screen.queryByText('Uploaded 1 file')).not.toBeInTheDocument();
  });

  it('says nothing about an upload the user cancelled', async () => {
    const upload = pendingUpload();
    render(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(upload.signal!.aborted).toBe(true);

    const cancelled = new Error('The upload was cancelled.');
    cancelled.name = 'UploadCancelledError';
    await act(async () => { upload.settle!.reject(cancelled); });

    expect(pill()).not.toBeInTheDocument();
    expect(screen.queryByText('The upload was cancelled.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('is not taken over by a dropzone in another slot for the same scope', async () => {
    const upload = pendingUpload();
    const { rerender } = render(
      <FileUploadProvider><MatterTabs uploadSlot="client-portal" /></FileUploadProvider>,
    );
    pickAndUpload();
    await waitFor(() => expect(upload.signal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Notes tab' }));

    rerender(<FileUploadProvider><MatterTabs /></FileUploadProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Documents tab' }));

    // Completion runs the slot's own follow-up (sharing with the client); a
    // different surface adopting it would run its follow-up instead.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(pill()).toHaveTextContent('Uploading 1 file');
  });
});

describe('a dropzone that picks the upload up as it settles', () => {
  /** The provider's API, for driving a job the way `useUploadJob` does. */
  function captureUploads() {
    const captured: { uploads?: ReturnType<typeof useFileUploads> } = {};
    function Probe() {
      captured.uploads = useFileUploads();
      return null;
    }
    render(<FileUploadProvider><Probe /></FileUploadProvider>);
    return captured.uploads!;
  }

  const listenerMock = () => ({ onDone: jest.fn(), onFailed: jest.fn(), onFinalizing: jest.fn() });

  it('hears the outcome from a job that settled before it listened', async () => {
    const uploads = captureUploads();
    const response = { message: 'ok', bucket: '', count: 1, files: [] };
    const first: UploadListener = listenerMock();

    // A remounting dropzone reads the job during render and listens in an
    // effect. An upload that settles in between reports to the dropzone that
    // unmounted, and the new one shows "Uploading..." for good.
    const job = uploads.startUpload('k', [new File(['a'], 'a.pdf')], async () => response, first);
    await act(async () => {});
    expect(first.onDone).toHaveBeenCalledTimes(1);

    const late = listenerMock();
    job.listen(late);

    expect(late.onDone).toHaveBeenCalledWith(response);
  });

  it('replays a failure too, and only once per listener', async () => {
    const uploads = captureUploads();
    const error = new Error('Rejected: file appears to be a Windows executable');
    const job = uploads.startUpload('k', [new File(['a'], 'a.pdf')], async () => { throw error; }, listenerMock());
    await act(async () => {});

    const late = listenerMock();
    job.listen(late);
    // React runs an effect twice in development; the second must not be a
    // second report of the same upload.
    job.listen(late);

    expect(late.onFailed).toHaveBeenCalledTimes(1);
    expect(late.onFailed).toHaveBeenCalledWith(error);
  });
});
