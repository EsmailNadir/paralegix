/**
 * The notes panel, driven through the REAL notes transport.
 *
 * `tests/setup.ts` swaps `matters.service` for a Proxy whose every method
 * resolves `{}`, so a panel rendered under the default harness shows an empty
 * list because the mock said so. Nothing about a note's visibility, its order,
 * or the body of a write could then fail. Unmocking the service restores url
 * building, query parameters, response parsing and `ApiError`; `installApiMock`
 * fakes only `fetch` underneath, and throws by name on any request this file did
 * not set up.
 *
 * WHAT THESE TESTS ARE PROTECTING. A note is attorney work product. Some notes
 * are shared into the client portal and most are not, and the panel's only
 * signal for which is which is the "Shared with client" badge. A badge on the
 * wrong note tells a lawyer that something private has already been disclosed,
 * or that something disclosed is still private, and both are read as fact.
 */
jest.unmock('@/services/matters.service');
// The task and client note cases below go through their own services, which
// share one notes implementation with matters (`services/notesApi.ts`).
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import NotesSection from '@/components/notesComp/NotesSection';
import mattersService from '@/services/matters.service';
import type { Note, NoteReply } from '@/types/note';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';

function makeNote(overrides: Partial<Note> & { id: string }): Note {
  return {
    content: 'Note body',
    contentHtml: '<p>Note body</p>',
    createdBy: 'test-uid',
    createdByName: 'Test User',
    createdAt: '2026-02-01T10:00:00.000Z',
    parentType: 'matter',
    parentId: MATTER_ID,
    lawFirmId: LAW_FIRM_ID,
    noteDate: '2026-02-01',
    noteType: 'general',
    ...overrides,
  };
}

function notesPage(notes: Note[], tags: string[] = []) {
  return {
    notes,
    totalNotes: notes.length,
    counts: { all: notes.length, withTime: 0, withoutTime: notes.length },
    tags,
  };
}

/**
 * The reads the panel makes before it can draw anything: its own page of notes,
 * plus the firm's custom note types and templates, which feed the composer's
 * two dropdowns.
 */
function stubPanelReads(api: ApiMock, notes: Note[], tags: string[] = []) {
  api.get('/notes', notesPage(notes, tags));
  api.get('/note-types', { noteTypes: [] });
  api.get('/note-templates', { noteTemplates: [] });
}

/**
 * The same write handlers the matter page hands the panel, calling the real
 * service. The panel does not own note writes - its parent page does - so
 * wiring these to the service is what keeps the POST and PUT bodies below
 * genuine rather than an assertion about a spy.
 */
const writeHandlers = {
  onAddNote: (data: Parameters<typeof mattersService.addNoteToMatter>[2]) =>
    mattersService.addNoteToMatter(LAW_FIRM_ID, MATTER_ID, data),
  onUpdateNote: async (noteId: string, data: Parameters<typeof mattersService.updateNoteInMatter>[3]) => {
    await mattersService.updateNoteInMatter(LAW_FIRM_ID, MATTER_ID, noteId, data);
  },
  onDeleteNote: async (noteId: string, reason?: string) => {
    await mattersService.retractNoteFromMatter(LAW_FIRM_ID, MATTER_ID, noteId, reason);
  },
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  sessionStorage.clear();
});

afterEach(() => {
  api.restore();
});

describe('adding a note', () => {
  it('saves the template the author picked, with today as the note date, and shows the note', async () => {
    const user = userEvent.setup();
    const today = dayjs().format('YYYY-MM-DD');
    const saved = makeNote({
      id: 'note-new',
      subject: 'Call with opposing counsel',
      noteType: 'phone-call',
      content: 'Call Details:',
      contentHtml: '<p><strong>Call Details:</strong></p>',
      noteDate: today,
    });

    let created = false;
    api.get('/notes', () => notesPage(created ? [saved] : []));
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    api.post('/notes', () => {
      created = true;
      return { status: 201, body: { note: saved } };
    });

    renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        {...writeHandlers}
      />,
    );

    await screen.findByText(/No notes yet/i);
    await user.click(screen.getByRole('button', { name: /Add Note/i }));

    // Choosing a template is what fills the editor; the rich-text control itself
    // is not typeable under jsdom, and a template is a first-class way to start
    // a note in this panel.
    await user.click(await screen.findByRole('button', { name: /Blank Note/i }));
    await user.click(await screen.findByRole('option', { name: 'Phone Call' }));

    const subject = screen.getByPlaceholderText(/Brief title for this note/i);
    await user.clear(subject);
    await user.type(subject, 'Call with opposing counsel');

    await user.click(screen.getByRole('button', { name: 'Save Note' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.subject).toBe('Call with opposing counsel');
    // The template carries its own type; saving under the default would file the
    // note as a general note and drop it out of every phone-call filter.
    expect(body.noteType).toBe('phone-call');
    // A note filed with no date is filed under whatever the server assumes.
    expect(body.noteDate).toBe(today);
    // The plain-text copy is what search reads, so it must carry the words that
    // are in the html, not the markup around them.
    expect(String(body.content)).toContain('Call Details');
    expect(String(body.contentHtml)).toContain('<strong>');

    // And the author sees the note land, not just a request that left.
    expect(await screen.findByText('Call with opposing counsel')).toBeInTheDocument();
  });
});

describe('editing a note', () => {
  it('keeps the note filed under its own date and shows the new subject', async () => {
    const user = userEvent.setup();
    const original = makeNote({ id: 'note-1', subject: 'Draft memo', noteDate: '2026-02-01' });
    const edited = { ...original, subject: 'Draft memo (revised)' };

    let updated = false;
    api.get('/notes', () => notesPage([updated ? edited : original]));
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    api.put('/notes/note-1', () => {
      updated = true;
      return { note: edited };
    });

    const { container } = renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        {...writeHandlers}
      />,
    );

    await screen.findByText('Draft memo');
    const card = container.querySelector('#note-note-1') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    const subject = await screen.findByDisplayValue('Draft memo');
    await user.clear(subject);
    await user.type(subject, 'Draft memo (revised)');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/notes\/note-1$/);
    const body = call.body as Record<string, unknown>;
    expect(body.subject).toBe('Draft memo (revised)');
    // The note keeps the day the work happened. Re-stamping it with today would
    // move billable work into the wrong period every time a typo is fixed.
    expect(body.noteDate).toBe('2026-02-01');

    expect(await screen.findByText('Draft memo (revised)')).toBeInTheDocument();
  });

  it('reports a rejected edit and leaves the note as it was', async () => {
    const user = userEvent.setup();
    stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Draft memo' })]);
    api.put('/notes/note-1', { status: 403, body: { error: 'Only the author can edit this note' } });

    const { container } = renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        {...writeHandlers}
      />,
    );

    await screen.findByText('Draft memo');
    const card = container.querySelector('#note-note-1') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    const subject = await screen.findByDisplayValue('Draft memo');
    await user.clear(subject);
    await user.type(subject, 'Rewritten by someone else');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The refusal is shown. Swallowing it would leave the editor open over an
    // unchanged note and read as a save that simply had not finished.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only the author can edit this note/i);
  });
});

describe('the reply thread under a note', () => {
  const reply = (overrides: Partial<NoteReply> & { id: string; content: string }): NoteReply => ({
    noteId: 'note-1',
    contentHtml: `<p>${overrides.content}</p>`,
    mentions: [],
    attachments: undefined,
    createdBy: 'other-uid',
    createdByName: 'Dana Associate',
    createdAt: '2026-02-02T12:00:00.000Z',
    editedAt: null,
    retractedAt: null,
    retractedBy: null,
    parentReplyId: null,
    retractionReason: null,
    ...overrides,
  });

  it('reads the thread only once it is opened', async () => {
    const user = userEvent.setup();
    stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Discovery plan', replyCount: 1 })]);
    api.get('/notes/note-1/replies', { replies: [reply({ id: 'r-1', content: 'Agreed, filing Monday.' })] });

    renderWithProviders(
      <NotesSection lawFirmId={LAW_FIRM_ID} parentType="matter" parentId={MATTER_ID} />,
    );

    await screen.findByText('Discovery plan');
    // A page of ten notes must not fire ten thread reads on mount. The note is
    // already on screen above, so this absence is a request not made rather than
    // a panel that never rendered.
    expect(api.callsTo('/notes/note-1/replies')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /1 reply/i }));

    expect(await screen.findByText('Agreed, filing Monday.')).toBeInTheDocument();
    expect(screen.getByText('Dana Associate')).toBeInTheDocument();
  });

  it('posts a reply restored from an unsent draft and shows it in the thread', async () => {
    const user = userEvent.setup();
    // A reply left unsent on a previous visit is held in sessionStorage, so it
    // survives collapsing the thread. Seeding it is also the only way to put
    // content into the rich-text editor under jsdom.
    sessionStorage.setItem(
      'noteReplyDraft:note-1',
      JSON.stringify({ html: '<p>Confirmed with the client.</p>', mentions: [] }),
    );

    const existing = reply({ id: 'r-1', content: 'Agreed, filing Monday.' });
    const posted = reply({
      id: 'r-2',
      content: 'Confirmed with the client.',
      createdBy: 'test-uid',
      createdByName: 'Test User',
    });

    let sent = false;
    stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Discovery plan', replyCount: 1 })]);
    api.get('/notes/note-1/replies', () => ({ replies: sent ? [existing, posted] : [existing] }));
    api.post('/notes/note-1/replies', () => {
      sent = true;
      return { status: 201, body: { reply: posted } };
    });

    renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        {...writeHandlers}
      />,
    );

    await screen.findByText('Discovery plan');
    await user.click(screen.getByRole('button', { name: /^Reply$/ }));
    await user.click(await screen.findByRole('button', { name: /Post Reply/i }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.content).toBe('Confirmed with the client.');
    // No parent, because the composer was opened against the note itself. A
    // reply that arrives carrying one is threaded under some other reply and
    // shows up in the wrong place in the conversation.
    expect(Object.prototype.hasOwnProperty.call(body, 'parentReplyId')).toBe(false);

    expect(await screen.findByText('Confirmed with the client.')).toBeInTheDocument();
  });
});

describe('while the notes are loading, and when the read fails', () => {
  it('shows the panel and its controls while the first page is still in flight', async () => {
    api.get('/notes', { delayMs: 40, body: notesPage([makeNote({ id: 'note-1', subject: 'First note' })]) });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });

    renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        {...writeHandlers}
      />,
    );

    // The panel frame is up immediately, with a zero count, so the author can
    // start a note without waiting for the history to arrive.
    expect(screen.getByRole('heading', { name: 'Notes (0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Note/i })).toBeInTheDocument();
    // The list shows a placeholder, not an empty-state claim it cannot yet make.
    expect(screen.getByRole('status', { name: 'Loading notes' })).toBeInTheDocument();
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();

    expect(await screen.findByText('First note')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notes (1)' })).toBeInTheDocument();
  });

  /**
   * A failed read must not fall through to the empty state. Otherwise a reader
   * is told the matter has no notes when what actually happened is that the
   * notes could not be fetched, and the natural next action is to write the note
   * again. `MatterEventsTab` uses the same error-banner convention.
   */
  it('tells the reader when the notes could not be loaded', async () => {
    api.get('/notes', { status: 500, body: { error: 'Notes are unavailable right now' } });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });

    renderWithProviders(
      <NotesSection lawFirmId={LAW_FIRM_ID} parentType="matter" parentId={MATTER_ID} />,
    );

    // The read has been attempted and refused before anything is asserted.
    await waitFor(() => expect(api.callsTo('/notes')).toHaveLength(1));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unavailable/i);
    expect(screen.queryByText(/No notes yet/i)).not.toBeInTheDocument();
  });
});

describe('the note overflow menu', () => {
  async function openMenuAndChoose(
    user: ReturnType<typeof userEvent.setup>,
    container: HTMLElement,
    item: RegExp,
  ) {
    const card = container.querySelector('#note-note-1') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('button', { name: item }));
  }

  it('tells the parent page when a task was created from a note', async () => {
    const user = userEvent.setup();
    stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Discovery plan' })]);
    api.post('/notes/note-1/tasks', { status: 201, body: { taskId: 'task-9', link: { id: 'link-1' } } });
    const onTaskCreated = jest.fn();

    const { container } = renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        onTaskCreated={onTaskCreated}
        {...writeHandlers}
      />,
    );

    await screen.findByText('Discovery plan');
    await openMenuAndChoose(user, container, /Create task/i);
    await user.click(await screen.findByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(api.callsTo('/notes/note-1/tasks')).toHaveLength(1));
    // The matter page holds its tasks in its own state, so without this signal
    // the new task never shows up on the Tasks tab until a manual reload.
    await waitFor(() => expect(onTaskCreated).toHaveBeenCalledTimes(1));
  });

  it('does not tell the parent page about a task the server refused', async () => {
    const user = userEvent.setup();
    stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Discovery plan' })]);
    api.post('/notes/note-1/tasks', { status: 403, body: { error: 'Not allowed' } });
    const onTaskCreated = jest.fn();

    const { container } = renderWithProviders(
      <NotesSection
        lawFirmId={LAW_FIRM_ID}
        parentType="matter"
        parentId={MATTER_ID}
        onTaskCreated={onTaskCreated}
        {...writeHandlers}
      />,
    );

    await screen.findByText('Discovery plan');
    await openMenuAndChoose(user, container, /Create task/i);
    await user.click(await screen.findByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(api.callsTo('/notes/note-1/tasks')).toHaveLength(1));
    expect(await screen.findByText(/Not allowed/i)).toBeInTheDocument();
    expect(onTaskCreated).not.toHaveBeenCalled();
  });

  it.each(['matter', 'task', 'client'] as const)(
    'shows the error itself when pinning a %s note is refused',
    async (parentType) => {
      const user = userEvent.setup();
      stubPanelReads(api, [makeNote({ id: 'note-1', subject: 'Discovery plan' })]);
      const onSetPinned = jest.fn().mockRejectedValue(new Error('Only admins can pin notes'));

      const { container } = renderWithProviders(
        <NotesSection
          lawFirmId={LAW_FIRM_ID}
          parentType={parentType}
          parentId={MATTER_ID}
          onSetPinned={onSetPinned}
        />,
      );

      await screen.findByText('Discovery plan');
      await openMenuAndChoose(user, container, /Pin note/i);

      await waitFor(() => expect(onSetPinned).toHaveBeenCalledWith('note-1', true));
      // A rejected pin used to escape as an unhandled rejection on tasks and
      // clients, so the note simply did not move and nothing said why.
      expect(await screen.findByRole('alert')).toHaveTextContent(/Only admins can pin notes/i);
    },
  );
});
