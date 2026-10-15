jest.unmock('@/services/messages.service');
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/lib/supabase/realtimeClient', () => ({
  authorizeRealtime: jest.fn(), getRealtimeClient: jest.fn(() => null),
  retainRealtime: jest.fn(), releaseRealtime: jest.fn(), onRealtimeResume: jest.fn(() => () => {}),
}));

import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationView from '@/components/messagesComp/ConversationView';
import { authorizeRealtime } from '@/lib/supabase/realtimeClient';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock, sequence } from '../../support/apiMock';

const api = setupApiMock();
const base = '/api/client-portal/lawfirm/firm-a/messages';
let receive: (payload: unknown) => void;
const row = (id: string, content: string, createdAt = '2026-10-04T12:00:00Z') => ({
  messageId: id, senderId: 'member-a', senderType: 'firm_member', senderName: 'Firm A',
  content, readByClient: true, readByFirm: true, createdAt, updatedAt: createdAt, attachments: [],
});
function renderThread() {
  return renderWithProviders(<ConversationView conversationId="thread-a" lawFirmId="firm-a" clientId="record-a" currentUserId="test-uid" isClient />);
}

it('keeps a refused deletion and its focused error inside the confirmation dialog', async () => {
  api.getExact(`${base}?limit=30`, { messages: [{ ...row('own-a', 'Keep the original', new Date().toISOString()), senderId: 'test-uid', senderType: 'client' }], hasMore: false });
  api.deleteExact('/api/messaging/messages/own-a', sequence({ status: 403, body: { error: 'Deletion refused' } }, { messageId: 'own-a' }));
  const user = userEvent.setup();
  renderThread();
  await screen.findByText('Keep the original');
  await user.click(screen.getByRole('button', { name: 'Message actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete message' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Deletion refused');
  expect(alert.parentElement).toHaveFocus();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await user.click(within(alert).getByRole('button', { name: 'Close' }));
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete message' })).not.toBeInTheDocument());
  expect(api.calls('DELETE')).toHaveLength(2);
});

it('names the message editor and preserves the draft with an associated edit failure', async () => {
  api.getExact(`${base}?limit=30`, { messages: [{ ...row('own-a', 'Original draft', new Date().toISOString()), senderId: 'test-uid', senderType: 'client' }], hasMore: false });
  api.patchExact('/api/messaging/messages/own-a', sequence({ status: 403, body: { error: 'Editing refused' } }, { messageId: 'own-a', editedAt: new Date().toISOString() }));
  const user = userEvent.setup();
  renderThread();
  await screen.findByText('Original draft');
  await user.click(screen.getByRole('button', { name: 'Message actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit message' });
  expect(editor).toHaveFocus();
  await user.clear(editor);
  await user.type(editor, 'Corrected draft{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('Editing refused');
  expect(editor).toHaveValue('Corrected draft');
  expect(editor).toHaveAccessibleDescription(/Editing refused/);
  expect(editor).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument());
  expect(api.calls('PATCH').map(call => call.body)).toEqual([{ content: 'Corrected draft' }, { content: 'Corrected draft' }]);
});
beforeEach(() => {
  Element.prototype.scrollTo = jest.fn();
  const channel = { on: jest.fn(), subscribe: jest.fn() };
  channel.on.mockImplementation((_event, _filter, callback) => { receive = callback; return channel; });
  channel.subscribe.mockReturnValue(channel);
  (authorizeRealtime as jest.Mock).mockResolvedValue({ channel: () => channel, removeChannel: jest.fn() });
  api.getExact('/api/messaging/client-conversations', { conversations: [{
    conversationId: 'thread-a', lawFirmId: 'firm-a', lawFirmName: 'Firm A', clientId: 'test-uid',
  }] });
  api.put(`${base}/mark-read`, {});
});

it('announces incoming messages without announcing history, edits, own messages, or changing composer focus', async () => {
  // A client's direct thread does not stream message rows; a content-free ping
  // triggers a re-read of the masked portal endpoint, so the server list below
  // is what each ping brings back.
  let serverRows = [row('recent', 'Existing history')];
  api.getExact(`${base}?limit=30`, () => ({ messages: serverRows, hasMore: true }));
  api.getExact(`${base}?limit=30&lastMessageId=recent`, { messages: [row('older', 'Older history', '2026-10-03T12:00:00Z')], hasMore: false });
  const user = userEvent.setup();
  renderThread();
  await screen.findByText('Existing history');
  const live = screen.getByRole('status', { name: 'New messages' });
  expect(live).toBeEmptyDOMElement();
  expect(screen.getByRole('region', { name: 'Conversation messages' })).not.toHaveAttribute('aria-live');
  await user.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Older history');
  expect(live).toBeEmptyDOMElement();
  const composer = screen.getByRole('textbox', { name: 'Message' });
  await user.type(composer, 'Unfinished draft');
  await waitFor(() => expect(receive).toBeDefined());
  const emit = async (id: string, senderId = 'member-a', content = 'Incoming update') => {
    const next = {
      ...row(id, content, '2026-10-04T13:00:00Z'),
      senderId, senderType: senderId === 'test-uid' ? 'client' : 'firm_member',
    };
    serverRows = serverRows.some(m => m.messageId === id)
      ? serverRows.map(m => (m.messageId === id ? next : m))
      : [...serverRows, next];
    await act(async () => receive({ event: 'new', payload: { conversationId: 'thread-a' } }));
    await screen.findByText(content);
  };
  await emit('new');
  await waitFor(() => expect(live).toHaveTextContent('1 new message'), { timeout: 2000 });
  expect(composer).toHaveFocus();
  expect(composer).toHaveValue('Unfinished draft');
  await emit('new', 'member-a', 'Edited update');
  expect(live).toHaveTextContent('1 new message');
  await emit('own', 'test-uid', 'Own reply');
  expect(live).toHaveTextContent('1 new message');
  await emit('next', 'member-a', 'Another update');
  await waitFor(() => expect(live).toHaveTextContent('2 new messages'), { timeout: 3000 });
  // Settled at exactly two: the edit and the client's own reply never counted.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(live).toHaveTextContent('2 new messages in this conversation.');
  expect(within(screen.getByRole('region', { name: 'Conversation messages' })).getByText('Edited update')).toBeInTheDocument();
});

it('focuses a real send refusal and lets the client dismiss it and send again', async () => {
  api.getExact(`${base}?limit=30`, { messages: [row('history', 'Existing message')], hasMore: false });
  api.postExact(base, sequence({ status: 403, body: { error: 'Sending is unavailable' } }, { messageId: 'sent-a' }));
  const user = userEvent.setup();
  renderThread();
  await screen.findByText('Existing message');
  const composer = screen.getByRole('textbox', { name: 'Message' });
  await user.type(composer, 'First try{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Sending is unavailable');
  expect(alert.parentElement).toHaveFocus();
  // The refused text goes back into the composer rather than staying behind as
  // a failed bubble, so nothing the client typed is lost.
  expect(composer).toHaveValue('First try');
  expect(screen.queryByRole('button', { name: 'Retry sending this message' })).not.toBeInTheDocument();
  await user.click(within(alert).getByRole('button', { name: 'Close' }));
  expect(composer).toHaveFocus();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await user.clear(composer);
  await user.type(composer, 'Try again{Enter}');
  await waitFor(() => expect(screen.getByRole('status', { name: 'Message delivery' })).toHaveTextContent('Message sent'));
  expect(api.calls('POST').map(call => call.body)).toEqual([
    { content: 'First try', attachments: [] }, { content: 'Try again', attachments: [] },
  ]);
});

