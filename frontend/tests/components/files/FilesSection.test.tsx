/**
 * `FilesSection` is the file area on a matter, task or client page: the
 * dropzone above the browser. An upload landing, or a delete, refreshes the
 * rows in place; the browser stays in the folder the user is working in.
 *
 * What has to break for these to go red: a finished upload or a delete
 * remounting the browser (which reopens it at the scope root, dropping the
 * folder, the search and the selection), an upload not re-fetching the folder
 * on screen, or a delete fetching it twice.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

// The real dropzone uploads over XMLHttpRequest in resumable chunks
// (FileUpload.test.tsx covers that). What this section decides is what happens
// once an upload lands, so the stand-in only reports one landing.
jest.mock('@/components/filesComp/FileUpload', () => ({
  __esModule: true,
  default: (props: { onUploadComplete?: (files: unknown[], failures: unknown[]) => void }) => (
    <button type="button" onClick={() => props.onUploadComplete?.([], [])}>
      Finish upload
    </button>
  ),
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FilesSection from '@/components/filesComp/FilesSection';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import type { FileInfo } from '@/services/files.service';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';

const PLEADINGS: FileInfo = {
  id: 'folder-pleadings', parentId: null, name: 'Pleadings', objectPath: '', size: 0,
  contentType: 'folder', updated: '2026-08-31T00:00:00.000Z', signedUrl: '', isFolder: true,
};

function pdf(id: string, name: string): FileInfo {
  return {
    id, parentId: PLEADINGS.id, name, objectPath: `lawfirmids/firm-1/objects/${id}`, size: 10,
    contentType: 'application/pdf', updated: '2026-08-31T00:00:00.000Z', signedUrl: '', isFolder: false,
  };
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  grantBaselineMember(['files.upload', 'files.delete']);
  window.history.replaceState(null, '', 'http://localhost/lawfirm/firm-1/matters/matter-1');
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

/** Every listing of Pleadings the browser has asked for. */
function pleadingsListings(): RecordedCall[] {
  return api.calls('GET').filter(
    (c) => c.pathname.endsWith('/files/list-folder') && c.query.folderId?.[0] === PLEADINGS.id,
  );
}

async function renderInsidePleadings(pleadingsRows: () => FileInfo[]) {
  api.get('/files/list-folder', (call: RecordedCall) =>
    call.query.folderId?.[0] === PLEADINGS.id ? { files: pleadingsRows() } : { files: [PLEADINGS] },
  );

  renderWithProviders(
    <FirmSettingsProvider lawFirmId="firm-1" initialSettings={{}}>
      <FilesSection lawFirmId="firm-1" matterId="matter-1" rootLabel="Smith v. Jones" />
    </FirmSettingsProvider>,
  );

  await userEvent.click(await screen.findByText('Pleadings'));
  await waitFor(() => expect(pleadingsListings()).toHaveLength(1));
}

describe('FilesSection', () => {
  it('re-fetches the open folder after an upload lands, without leaving it', async () => {
    let uploaded = false;
    await renderInsidePleadings(() => (uploaded ? [pdf('file-old', 'old.pdf'), pdf('file-new', 'new.pdf')] : [pdf('file-old', 'old.pdf')]));
    await screen.findByText('old.pdf');

    uploaded = true;
    await userEvent.click(screen.getByRole('button', { name: 'Finish upload' }));

    expect(await screen.findByText('new.pdf')).toBeInTheDocument();
    expect(pleadingsListings()).toHaveLength(2);
    // Still inside Pleadings: its own file is listed, and the root was never
    // listed again (a remount reopens the browser there).
    expect(screen.getByText('old.pdf')).toBeInTheDocument();
    expect(api.calls('GET').filter((c) => c.pathname.endsWith('/files/list-folder') && !c.query.folderId)).toHaveLength(1);
  });

  it('stays in the open folder after deleting a file, fetching it once', async () => {
    let deleteCalls = 0;
    api.delete('/files/delete', () => {
      deleteCalls += 1;
      return { message: 'Deleted successfully' };
    });
    await renderInsidePleadings(() => (deleteCalls > 0 ? [] : [pdf('file-gone', 'gone.pdf')]));
    await screen.findByText('gone.pdf');

    await userEvent.click(screen.getByLabelText('More actions'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    // Pleadings' own empty state, not the root's listing of Pleadings.
    expect(await screen.findByText('Empty folder')).toBeInTheDocument();
    expect(deleteCalls).toBe(1);
    expect(screen.queryByText('gone.pdf')).not.toBeInTheDocument();
    // The browser's own post-delete reload is the only one: one listing on
    // entry, one after the delete, and the root was never listed again.
    expect(pleadingsListings()).toHaveLength(2);
    expect(api.calls('GET').filter((c) => c.pathname.endsWith('/files/list-folder') && !c.query.folderId)).toHaveLength(1);
  });
});
