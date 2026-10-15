/**
 * Product events fire only on a confirmed server success, and carry no client
 * content. Both call sites here run against the fake transport, so the real
 * service code decides whether the write succeeded.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/notesApi');
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
}));

import { act, renderHook } from '@testing-library/react';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useAuth } from '@/hooks/useAuth';
import { createNotesApi } from '@/services/notesApi';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../../support/apiMock';

const FIRM_ID = 'firm-a';
const CLIENT_ID = 'client-a';
const SEND_URL = `/api/lawfirms/${FIRM_ID}/messaging/send`;
const PRIVILEGED_TEXT = 'Settlement floor is 40k, do not disclose';

const api = setupApiMock();

beforeEach(() => {
  __resetDuplicateRequestGuard();
  (useAuth as jest.Mock).mockReturnValue({ user: { uid: 'member-a', displayName: 'Avery' }, loading: false });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('message_sent', () => {
  it('fires after the server accepts the message, not when the optimistic row appears', async () => {
    let release: ((value: unknown) => void) | undefined;
    api.postExact(SEND_URL, () => new Promise((resolve) => { release = resolve; }));
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    let send: Promise<unknown> | undefined;
    await act(async () => {
      send = result.current.sendMessage({
        lawFirmId: FIRM_ID,
        clientId: CLIENT_ID,
        matterId: 'matter-1',
        content: PRIVILEGED_TEXT,
        onSuccess,
      });
    });

    // The optimistic callback has run, so the send is under way but unconfirmed.
    expect(onSuccess).toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();

    await act(async () => {
      release?.({ messageId: 'message-1', conversationId: 'conversation-a' });
      await send;
    });

    expect(mockTrack).toHaveBeenCalledWith('message_sent', {
      sender_type: 'firm_member',
      has_matter: true,
      attachment_count: 0,
    });
    expect(JSON.stringify(mockTrack.mock.calls)).not.toContain(PRIVILEGED_TEXT);
  });

  it('does not fire when the server refuses the message', async () => {
    api.postExact(SEND_URL, { status: 403, body: { error: 'Messaging access denied' } });
    const onError = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current
        .sendMessage({ lawFirmId: FIRM_ID, clientId: CLIENT_ID, content: 'Hello', onError })
        .catch(() => {});
    });

    expect(onError).toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('note_created', () => {
  const taskNotes = createNotesApi('tasks', 'taskId');

  it('fires with the parent type and counts once the note is saved', async () => {
    api.post('/notes', { note: { id: 'note-1' } });

    await taskNotes.addNote(FIRM_ID, 'task-1', { content: PRIVILEGED_TEXT, contentHtml: `<p>${PRIVILEGED_TEXT}</p>` });

    expect(mockTrack).toHaveBeenCalledWith('note_created', {
      parent_type: 'tasks',
      attachment_count: 0,
      time_entry_count: 0,
    });
    expect(JSON.stringify(mockTrack.mock.calls)).not.toContain(PRIVILEGED_TEXT);
  });

  it('does not fire when the save is rejected', async () => {
    api.post('/notes', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    await expect(taskNotes.addNote(FIRM_ID, 'task-1', { content: 'x', contentHtml: '<p>x</p>' })).rejects.toThrow();

    expect(mockTrack).not.toHaveBeenCalled();
  });
});
