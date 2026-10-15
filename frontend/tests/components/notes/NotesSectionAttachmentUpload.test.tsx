/**
 * A note's attachments upload the way the file manager uploads: with the bar
 * and its cancel, held above the page, and with an account of what failed.
 *
 * They used to upload inside the save, behind the Save button's spinner, and a
 * file that failed was dropped without a word: the note saved, the author saw
 * success, and the attachment they meant to file with it was simply not there.
 *
 * The note write goes through the REAL notes transport, so the body asserted
 * below is the one the server receives. Only the upload itself is faked, since
 * it runs over resumable XHR sessions rather than fetch.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

const mockUploadNoteFiles = jest.fn();
jest.mock('@/services/files.service', () => ({
  __esModule: true,
  default: {
    uploadNoteAttachmentFiles: (...args: unknown[]) => mockUploadNoteFiles(...args),
    formatFileSize: (bytes: number) => `${bytes} B`,
  },
}));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import NotesSection from '@/components/notesComp/NotesSection';
import mattersService from '@/services/matters.service';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';

const writeHandlers = {
  onAddNote: (data: Parameters<typeof mattersService.addNoteToMatter>[2]) =>
    mattersService.addNoteToMatter(LAW_FIRM_ID, MATTER_ID, data),
};

let api: ApiMock;

// A picked file gets a blob url for its preview; jsdom has no object urls.
beforeAll(() => {
  URL.createObjectURL = jest.fn(() => 'blob:preview');
  URL.revokeObjectURL = jest.fn();
});

beforeEach(() => {
  api = installApiMock();
  sessionStorage.clear();
  mockUploadNoteFiles.mockReset();
  api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
  api.get('/note-types', { noteTypes: [] });
  api.get('/note-templates', { noteTemplates: [] });
  api.post('/notes', { status: 201, body: { note: { id: 'note-new' } } });
});

afterEach(() => {
  api.restore();
});

const landed = (name: string, id: string) => ({
  fileId: id, name, size: 4, contentType: 'application/pdf', signedUrl: `https://x/${id}`, objectPath: `objects/${id}`,
});

/** Open the composer, pick a template so the note has content, attach files, save. */
async function composeAndSave(...names: string[]) {
  const user = userEvent.setup();
  renderWithProviders(
    <NotesSection lawFirmId={LAW_FIRM_ID} parentType="matter" parentId={MATTER_ID} {...writeHandlers} />,
  );
  await screen.findByText(/No notes yet/i);
  await user.click(screen.getByRole('button', { name: /Add Note/i }));
  await user.click(await screen.findByRole('button', { name: /Blank Note/i }));
  await user.click(await screen.findByRole('option', { name: 'Phone Call' }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map((n) => new File(['abcd'], n, { type: 'application/pdf' })) } });
  await user.click(screen.getByRole('button', { name: 'Save Note' }));
}

it('uploads with the bar and a cancel, then saves the note with the uploaded files', async () => {
  let settle: ((value: unknown) => void) | undefined;
  mockUploadNoteFiles.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));

  await composeAndSave('a.pdf');

  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel upload' })).toBeInTheDocument();
  expect(mockUploadNoteFiles.mock.calls[0][1]).toEqual({ matterId: MATTER_ID });
  // Nothing is written until the files have landed.
  expect(api.calls('POST')).toHaveLength(0);

  await act(async () => { settle!({ files: [landed('a.pdf', 'f-1')] }); });

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  const body = api.calls('POST')[0].body as { attachments: Array<Record<string, unknown>> };
  expect(body.attachments).toEqual([
    { id: 'f-1', name: 'a.pdf', size: 4, type: 'application/pdf', url: 'https://x/f-1' },
  ]);
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
});

it('saves the note with what landed and names what did not', async () => {
  mockUploadNoteFiles.mockResolvedValue({
    files: [landed('a.pdf', 'f-1')],
    failures: [{ name: 'b.pdf', error: 'The file is larger than this firm allows.' }],
  });

  await composeAndSave('a.pdf', 'b.pdf');

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  const body = api.calls('POST')[0].body as { attachments: Array<{ id: string }> };
  expect(body.attachments.map((a) => a.id)).toEqual(['f-1']);
  expect(await screen.findByText('1 attachment could not be uploaded, so the note was saved without it.')).toBeInTheDocument();
  expect(screen.getByText('b.pdf: The file is larger than this firm allows.')).toBeInTheDocument();
});

it('saves nothing when the upload is cancelled, and keeps the draft', async () => {
  mockUploadNoteFiles.mockImplementation((_firm, _ids, _files, signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const cancelled = new Error('Upload cancelled');
        cancelled.name = 'UploadCancelledError';
        reject(cancelled);
      });
    }));

  await composeAndSave('a.pdf');
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel upload' }));

  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  expect(api.calls('POST')).toHaveLength(0);
  // The composer is still open with its attachment, and Save works again.
  expect(screen.getByText('a.pdf')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save Note' })).not.toBeDisabled();
});

it('saves nothing and says why when no file landed', async () => {
  mockUploadNoteFiles.mockRejectedValue(new Error('The upload link expired before the file finished.'));

  await composeAndSave('a.pdf');

  expect(await screen.findByText('The upload link expired before the file finished.')).toBeInTheDocument();
  expect(api.calls('POST')).toHaveLength(0);
  expect(screen.getByText('a.pdf')).toBeInTheDocument();
});

it('offers again only the one of two same-named files that failed, by position', async () => {
  // Two scans from different folders can share a name. Matching the failure by
  // name kept both as unsent, so the retry uploaded the one that had already
  // landed a second time.
  mockUploadNoteFiles.mockResolvedValue({
    files: [landed('Scan.pdf', 'f-1')],
    failures: [{ name: 'Scan.pdf', error: 'The file is larger than this firm allows.', index: 1 }],
  });
  api.post('/notes', { status: 500, body: { error: 'Could not save the note.' } });

  await composeAndSave('Scan.pdf', 'Scan.pdf');
  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  await screen.findByText('Could not save the note.');

  mockUploadNoteFiles.mockClear();
  mockUploadNoteFiles.mockResolvedValue({ files: [landed('Scan.pdf', 'f-2')] });
  api.post('/notes', { status: 201, body: { note: { id: 'note-new' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Note' }));

  await waitFor(() => expect(mockUploadNoteFiles).toHaveBeenCalledTimes(1));
  expect((mockUploadNoteFiles.mock.calls[0][2] as File[])).toHaveLength(1);
  await waitFor(() => expect(api.calls('POST')).toHaveLength(2));
  const body = api.calls('POST')[1].body as { attachments: Array<{ id: string }> };
  expect(body.attachments.map((a) => a.id)).toEqual(['f-1', 'f-2']);
});
