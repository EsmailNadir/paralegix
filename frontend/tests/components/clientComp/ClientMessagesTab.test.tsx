/**
 * The messages tab on a client's detail page. The two states with nothing to
 * open (a person with no portal account, a company whose canonical thread could
 * not be resolved) have to say what is wrong, since neither offers an action.
 */
const mockGetCompanyConversation = jest.fn();

jest.mock('@/services/messages.service', () => ({
  __esModule: true,
  default: {
    getCompanyConversation: (...args: unknown[]) => mockGetCompanyConversation(...args),
    listGroups: jest.fn().mockResolvedValue([]),
    getFirmConversations: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('@/components/messagesComp/ConversationView', () => ({
  __esModule: true,
  default: (props: { conversationId: string; onConversationCreated?: (conversationId: string) => void }) => (
    <div data-testid="conversation-view">
      {props.conversationId}
      {props.onConversationCreated && (
        <button type="button" onClick={() => props.onConversationCreated?.('conv-created')}>
          first send creates the thread
        </button>
      )}
    </div>
  ),
}));
const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));
jest.mock('@/components/messagesComp/NewGroupModal', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import ClientMessagesTab from '@/components/clientComp/ClientMessagesTab';

const baseProps = {
  lawFirmId: 'firm-1',
  clientId: 'client-1',
  clientName: 'Dana Whitfield',
  clientEmail: 'dana@example.com',
};

describe('a client who cannot be messaged', () => {
  it('says why, and offers no conversation to open', () => {
    renderWithProviders(<ClientMessagesTab {...baseProps} clientUserId={null} clientType="person" />);

    expect(screen.getByText("This client can't be messaged yet")).toBeInTheDocument();
    expect(screen.getByText(/They need a portal account before you can start a conversation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Message Dana Whitfield/ })).not.toBeInTheDocument();
  });
});

describe('a company whose conversation cannot be loaded', () => {
  it('says the conversation could not be loaded instead of spinning forever', async () => {
    mockGetCompanyConversation.mockRejectedValue(new Error('Conversation service unavailable'));

    renderWithProviders(<ClientMessagesTab {...baseProps} clientUserId={null} clientType="company" />);

    expect(await screen.findByText("Couldn't load this conversation")).toBeInTheDocument();
    expect(screen.getByText('Try refreshing the page.')).toBeInTheDocument();
  });
});

describe('the first message to a person with no direct thread', () => {
  it('keeps the open thread and points Open in Messages at the conversation it created', async () => {
    renderWithProviders(<ClientMessagesTab {...baseProps} clientType="person" clientUserId="u-dana" />);

    await userEvent.click(await screen.findByRole('button', { name: /Message Dana Whitfield/ }));
    const view = screen.getByTestId('conversation-view');
    expect(view).toHaveTextContent('firm-1_u-dana');

    await userEvent.click(screen.getByRole('button', { name: 'first send creates the thread' }));

    expect(screen.getByTestId('conversation-view')).toBe(view);
    expect(view).toHaveTextContent('conv-created');
    await userEvent.click(screen.getByRole('button', { name: /Open in Messages/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/messages/conv-created');
  });
});
