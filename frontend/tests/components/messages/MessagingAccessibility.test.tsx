jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationList from '@/components/messagesComp/ConversationList';
import MessageInput from '@/components/messagesComp/MessageInput';
import MessageSearch from '@/components/messagesComp/MessageSearch';
import clientPortalService from '@/services/client-portal.service';
import type { Conversation, MessageSearchResult } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';

const api = setupApiMock();
const search = (q: string) => clientPortalService.searchMessages(q);
const hit: MessageSearchResult = {
  messageId: 'message-a', conversationId: 'thread-a', conversationType: 'direct',
  conversationTitle: 'Firm A', lawFirmId: 'firm-a', senderName: 'Firm A',
  snippet: 'Your appointment is confirmed', createdAt: '2026-10-04T10:00:00Z',
};

it('names the client composer and sends its keyboard draft without a membership lookup', async () => {
  const user = userEvent.setup();
  const onSend = jest.fn();
  renderWithProviders(<MessageInput isClient lawFirmId="firm-a" clientId="record-a" onSend={onSend} />);
  const composer = screen.getByRole('textbox', { name: 'Message' });
  await user.type(composer, 'Please confirm{Enter}');
  expect(onSend).toHaveBeenCalledWith('Please confirm', [], []);
  expect(composer).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  expect(api.calls()).toHaveLength(0);
});

it('exposes selected conversation and viewer unread counts with keyboard selection', async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn();
  const direct: Conversation = {
    conversationId: 'thread-a', clientId: 'client-a', clientName: 'Pat', clientEmail: 'pat@example.com',
    lawFirmId: 'firm-a', lawFirmName: 'Firm A', unreadCountClient: 105, unreadCountFirm: 8,
    lastMessageAt: '2026-10-04T10:00:00Z', lastMessagePreview: 'Appointment confirmed',
    createdAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:00Z',
  };
  const group = { ...direct, conversationId: 'thread-b', conversationType: 'group' as const, title: 'Matter team', unreadCount: 2 };
  const view = renderWithProviders(<ConversationList conversations={[direct, group]} currentUserId="client-a" selectedConversationId="thread-a" onSelect={onSelect} />);
  const first = screen.getByRole('button', { name: 'Open conversation with Firm A, 105 unread messages' });
  expect(first).toHaveAttribute('aria-pressed', 'true');
  expect(within(first).getByText('99+')).toBeInTheDocument();
  await user.tab();
  expect(first).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenLastCalledWith('thread-a');
  await user.tab();
  await user.keyboard(' ');
  expect(onSelect).toHaveBeenLastCalledWith('thread-b');
  view.rerender(<ConversationList conversations={[direct, group]} currentUserId="client-a" selectedConversationId="thread-b" onSelect={onSelect} />);
  expect(first).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Open conversation with Matter team, 2 unread messages' })).toHaveAttribute('aria-pressed', 'true');
});

it('announces actual results and restores focus after clearing a keyboard search', async () => {
  api.getExact('/api/messaging/search?q=appointment', { results: [hit] });
  const user = userEvent.setup();
  const onSelect = jest.fn();
  renderWithProviders(<MessageSearch searchFn={search} onSelect={onSelect} />);
  const input = screen.getByRole('textbox', { name: 'Search messages' });
  await user.type(input, 'appointment');
  expect(screen.getByRole('status')).toHaveTextContent('Searching messages');
  const result = await screen.findByRole('button', { name: /Firm A.*appointment is confirmed/i });
  expect(screen.getByRole('status')).toHaveTextContent('1 message found');
  await user.tab();
  expect(screen.getByRole('button', { name: 'Clear search' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(input).toHaveFocus();
  expect(input).toHaveValue('');
  expect(result).not.toBeInTheDocument();
  await user.type(input, 'appointment');
  await screen.findByRole('button', { name: /Firm A.*appointment is confirmed/i });
  await user.tab();
  await user.tab();
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledWith(hit);
  expect(api.calls('GET')).toHaveLength(2);
});

it('announces a transport refusal and the empty result of a corrected search', async () => {
  api.getExact('/api/messaging/search?q=blocked', { status: 403, body: { error: 'Search access denied' } });
  api.getExact('/api/messaging/search?q=allowed', { results: [] });
  const user = userEvent.setup();
  renderWithProviders(<MessageSearch searchFn={search} onSelect={jest.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Search messages' });
  await user.type(input, 'blocked');
  expect(await screen.findByRole('alert')).toHaveTextContent('Search access denied');
  expect(input).toHaveFocus();
  await user.clear(input);
  await user.type(input, 'allowed');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No messages found'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(api.calls('GET')).toHaveLength(2);
});
