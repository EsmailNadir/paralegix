/**
 * NoteAttachments' "View" action, driven through the REAL files service.
 *
 * Every attachment used to open in a new browser tab via `window.open`, no
 * matter its source (a saved GCS object, or a local file picked but not yet
 * uploaded). That bypassed the shared `FilePreviewModal` popup every other
 * file-view affordance in the app uses. `tests/setup.ts` swaps `files.service`
 * for a Proxy whose every method resolves `{}`; unmocking it here restores url
 * building and response parsing so a wrong signed-url request is loud rather
 * than silently absent.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import NoteAttachments, { type Attachment } from '@/components/notesComp/NoteAttachments';

const LAW_FIRM_ID = 'firm-1';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('viewing a saved attachment', () => {
  it('opens the shared preview modal instead of a new tab', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    api.get('/refresh-url', { signedUrl: 'https://example.test/photo.png' });

    const attachment: Attachment = {
      id: 'att-1',
      name: 'photo.png',
      size: 1024,
      type: 'image/png',
      objectPath: 'lawfirmids/firm-1/notes/photo.png',
    };

    renderWithProviders(
      <NoteAttachments attachments={[attachment]} onChange={jest.fn()} lawFirmId={LAW_FIRM_ID} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    // The shared FilePreviewModal renders a Download button once open; a new
    // tab would show neither this nor any DOM change in the page at all.
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});

describe('viewing a local, not-yet-uploaded attachment', () => {
  it('opens the shared preview modal using its blob url directly, with no network call', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);

    const attachment: Attachment = {
      id: 'att-local',
      name: 'draft.png',
      size: 512,
      type: 'image/png',
      url: 'blob:http://localhost/local-file',
      file: new File(['x'], 'draft.png', { type: 'image/png' }),
    };

    renderWithProviders(
      <NoteAttachments attachments={[attachment]} onChange={jest.fn()} lawFirmId={LAW_FIRM_ID} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    // Nothing needed fetching: the blob url was already the file's content.
    expect(api.calls()).toHaveLength(0);

    openSpy.mockRestore();
  });
});
