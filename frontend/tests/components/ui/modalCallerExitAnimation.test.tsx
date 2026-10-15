/**
 * Dialogs whose parent clears the record they show in the same handler that
 * closes them.
 *
 * `Modal` plays its exit animation only while it stays mounted with
 * `isOpen={false}`. A parent that renders `{target && <Picker open />}` and
 * closes with `setTarget(null)` unmounts the dialog on the spot, so it vanishes
 * with no animation. Each caller here holds the last target through the close
 * instead; these specs fail if one goes back to unmounting.
 *
 * The file picker is replaced with a stub that renders the REAL `Modal`, so the
 * assertion is on the shared exit class rather than on a prop the stub echoes.
 * Its own file listing is not what is under test.
 */
import React from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import type { DocumentRequest } from '@/services/documentRequests.service';

jest.mock('@/components/matterComp/FilePickerModal', () => {
  const Modal = require('@/components/ui/Modal').default;
  return {
    __esModule: true,
    default: ({ open, onClose, matterId }: { open: boolean; onClose: () => void; matterId: string }) => (
      <Modal isOpen={open} onClose={onClose} title="Link Files">
        <p>Files for {matterId}</p>
      </Modal>
    ),
  };
});

const makeRequest = (overrides: Partial<DocumentRequest> = {}): DocumentRequest => ({
  id: 'req-1',
  lawFirmId: 'firm-1',
  matterId: 'matter-1',
  clientId: 'client-1',
  title: 'Onboarding docs',
  note: null,
  status: 'open',
  dueDate: null,
  createdBy: 'uid-1',
  createdByName: 'Owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  items: [
    {
      id: 'item-1',
      label: 'item 1',
      description: null,
      status: 'pending',
      fulfillments: [],
    },
  ] as never,
  ...overrides,
});

const mockRequests: { current: DocumentRequest[] } = { current: [] };

jest.mock('@/hooks/documentRequestsHooks/useDocumentRequests', () => ({
  __esModule: true,
  documentRequestsKey: () => ['document-requests'],
  default: () => ({
    requests: mockRequests.current,
    loading: false,
    error: null,
    total: mockRequests.current.length,
    page: 1,
    totalPages: 1,
    rowsPerPage: 10,
    setPage: () => {},
    setRowsPerPage: () => {},
    fetching: false,
  }),
}));

jest.mock('@/hooks/documentRequestsHooks/useFirmClientDocumentRequests', () => ({
  __esModule: true,
  firmClientDocumentRequestsKey: () => ['firm-client-document-requests'],
  default: () => ({ requests: mockRequests.current, loading: false, error: null }),
}));

const mockReplies: { current: unknown[] } = { current: [] };
const idleMutation = { isPending: false, mutateAsync: async () => {} };

jest.mock('@/hooks/notesHooks/useNoteReplies', () => ({
  __esModule: true,
  default: () => ({
    replies: mockReplies.current,
    loading: false,
    addReply: idleMutation,
    updateReply: idleMutation,
    retractReply: idleMutation,
  }),
}));

jest.mock('@/hooks/notesHooks/useNoteLinks', () => ({
  __esModule: true,
  default: () => ({ createTask: idleMutation }),
}));

// jsdom's ESM-only encoding dependency cannot load under Jest; the reply
// markup is not what is under test.
jest.mock('@/lib/utils/sanitizeHtml', () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? '',
}));
jest.mock('@/components/notesComp/TiptapEditor', () => ({ __esModule: true, default: () => null }));

jest.mock('@/hooks/useFirmMembers', () => ({ useFirmMembers: () => [] }));

jest.mock('@/hooks/useEntityLookup', () => ({
  ...jest.requireActual('@/hooks/useEntityLookup'),
  useDuplicateNameCheck: () => ({ duplicate: null }),
}));

import DocumentRequestsPanel from '@/components/documentRequestsComp/DocumentRequestsPanel';
import ClientDocumentRequestsTab from '@/components/clientComp/ClientDocumentRequestsTab';
import NoteReplies from '@/components/notesComp/NoteReplies';

/** Closes the open dialog through its header button and asserts it is still on screen, animating out. */
function closeAndExpectExit(name: RegExp): void {
  const dialog = screen.getByRole('dialog', { name });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

  const exiting = screen.getByRole('dialog', { name });
  expect(exiting).toHaveClass('overlay-card-exit');
  expect(exiting).not.toHaveClass('overlay-card-enter');
}

afterEach(() => {
  mockRequests.current = [];
  mockReplies.current = [];
});

describe('matter document requests: Link Files', () => {
  it('stays mounted and plays the exit animation when closed', () => {
    mockRequests.current = [makeRequest()];
    renderWithProviders(
      <DocumentRequestsPanel lawFirmId="firm-1" matterId="matter-1" clients={[{ id: 'client-1', name: 'Marcus' }]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link an existing file' }));
    expect(screen.getByRole('dialog', { name: /Link Files/ })).toHaveClass('overlay-card-enter');

    closeAndExpectExit(/Link Files/);
  });
});

describe('client document requests: Link Files', () => {
  it('stays mounted, still showing the matter it opened for, while it animates out', () => {
    mockRequests.current = [makeRequest({ matterId: 'matter-7' })];
    renderWithProviders(
      <ClientDocumentRequestsTab
        lawFirmId="firm-1"
        clientId="client-1"
        clientName="Marcus"
        clientMatters={[{ id: 'matter-7', name: 'Estate' } as never]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link an existing file' }));
    closeAndExpectExit(/Link Files/);
    expect(screen.getByText('Files for matter-7')).toBeInTheDocument();
  });
});

describe('note replies: Create task', () => {
  it('stays mounted and plays the exit animation when closed', () => {
    mockReplies.current = [
      {
        id: 'reply-1',
        content: 'Please follow up with the court clerk',
        contentHtml: '<p>Please follow up with the court clerk</p>',
        createdBy: 'someone-else',
        createdByName: 'Associate',
        createdAt: '2026-01-01T00:00:00.000Z',
        parentReplyId: null,
      },
    ];
    renderWithProviders(
      <NoteReplies
        lawFirmId="firm-1"
        parentType="matter"
        parentId="matter-1"
        noteId="note-1"
        noteSubject="Hearing prep"
        replyCount={1}
        canReply={false}
        canCreateTask
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    closeAndExpectExit(/Create Task from Note/);
  });
});
