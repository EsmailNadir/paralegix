jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useConversations', () => ({
  useConversations: () => ({ conversations: [], loading: false, error: null }),
}));

import { screen } from '@testing-library/react';
import ClientMessagesPage from '@/app/client/messages/page';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();

it('waits for group threads before claiming the client has no messages', async () => {
  api.getExact('/api/messaging/client-groups', {
    body: {
      conversations: [{
        conversationId: 'group-1',
        conversationType: 'group',
        lawFirmId: 'firm-1',
        title: 'Matter updates',
        lastMessageAt: '2026-09-01T10:00:00.000Z',
      }],
    },
    delayMs: 100,
  });

  renderWithProviders(<ClientMessagesPage />);

  expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
  expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  expect(await screen.findByText('Matter updates')).toBeInTheDocument();
});
