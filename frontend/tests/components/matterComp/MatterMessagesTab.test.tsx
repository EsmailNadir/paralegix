/**
 * The Messages tab on a matter: the matter's portal clients (each opens a direct
 * thread), the group threads scoped to it, and the actions around them.
 *
 * The clients, messages and matters services run for real against a faked
 * transport. `ConversationView` (the live thread, with its own realtime
 * subscription and its own specs) is replaced by a stub that names the thread
 * it was opened on, so these cases pin which thread the tab opens and what it
 * offers around the list, not how a message is typed.
 *
 * Whether the tab is shown at all is the page's decision (`messaging.view`),
 * pinned in `tests/app/lawfirm/matters/MatterDetailPage.test.tsx`. What this
 * component gates itself is sending (`messaging.send`) and inviting
 * (`clients.invite`).
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/messages.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/components/messagesComp/ConversationView', () => ({
  __esModule: true,
  default: (props: {
    conversationId: string;
    isGroup?: boolean;
    recipientName?: string;
    onConversationCreated?: (conversationId: string) => void;
  }) => (
    <div data-testid="conversation-view">
      {props.isGroup ? 'group' : 'direct'}:{props.conversationId}:{props.recipientName}
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

import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import MatterMessagesTab from '@/components/matterComp/MatterMessagesTab';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const FIRM = 'firm-1';
const MATTER = 'matter-1';

let api: ApiMock;

const DANA = { id: 'c-dana', label: 'Dana Client', userId: 'u-dana', email: 'dana@example.com' };
const EVAN = { id: 'c-evan', label: 'Evan Client', userId: 'u-evan', email: 'evan@example.com' };

interface Seed {
  portal?: Array<typeof DANA>;
  groups?: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
  matterClients?: Array<Record<string, unknown>>;
}

function seed({ portal = [], groups = [], conversations = [], matterClients }: Seed = {}) {
  api.get('/lawfirms/firm-1/clients/lookup', { items: portal, hasMore: false });
  api.get('/lawfirms/firm-1/messaging/conversations', { conversations });
  api.get('/lawfirms/firm-1/messaging/groups', { conversations: groups });
  api.get(`/lawfirms/firm-1/matters/${MATTER}/clients`, {
    clients: matterClients ?? portal.map((p) => ({ id: p.id, name: p.label, userId: p.userId, clientType: 'person' })),
  });
}

function renderTab() {
  return renderWithProviders(<MatterMessagesTab lawFirmId={FIRM} matterId={MATTER} currentUserId="me" />);
}

beforeEach(() => {
  api = installApiMock();
  // The closed New group and Invite modals may read their own pickers; not the subject here.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  mockNavigate.mockReset();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('the list', () => {
  it('lists each portal client with their email, and their unread count', async () => {
    seed({
      portal: [DANA, EVAN],
      conversations: [
        { conversationId: 'conv-dana', conversationType: 'direct', clientId: 'u-dana', unreadCountFirm: 3 },
      ],
    });

    renderTab();

    const dana = await screen.findByRole('button', { name: /Dana Client/ });
    expect(within(dana).getByText('dana@example.com')).toBeInTheDocument();
    expect(within(dana).getByText('3')).toBeInTheDocument();
    const evan = screen.getByRole('button', { name: /Evan Client/ });
    expect(within(evan).queryByText('3')).not.toBeInTheDocument();
  });

  it('lists the group threads scoped to this matter', async () => {
    seed({
      portal: [DANA, EVAN],
      groups: [
        { conversationId: 'g-1', conversationType: 'group', title: 'Discovery team', lastMessagePreview: 'Draft is ready', matterIds: [MATTER], unreadCount: 2 },
        { conversationId: 'g-2', conversationType: 'group', title: 'Other matter group', matterIds: ['matter-9'] },
      ],
    });

    renderTab();

    const group = await screen.findByRole('button', { name: /Discovery team/ });
    expect(within(group).getByText('Draft is ready')).toBeInTheDocument();
    expect(within(group).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Other matter group')).not.toBeInTheDocument();
  });

  it('says no client can be messaged yet, rather than leaving the list blank', async () => {
    seed({ portal: [], matterClients: [] });

    renderTab();

    expect(await screen.findByText('No portal clients on this matter')).toBeInTheDocument();
    expect(screen.getByText('A client needs a portal account before they can be messaged here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New group/ })).not.toBeInTheDocument();
  });
});

describe('opening a thread', () => {
  it('opens the existing direct thread for a client with history, and comes back to the list', async () => {
    seed({
      portal: [DANA, EVAN],
      conversations: [{ conversationId: 'conv-dana', conversationType: 'direct', clientId: 'u-dana' }],
    });

    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Dana Client/ }));

    expect(screen.getByTestId('conversation-view')).toHaveTextContent('direct:conv-dana:Dana Client');

    await userEvent.click(screen.getByRole('button', { name: 'Back to matter messages' }));
    expect(await screen.findByRole('button', { name: /Evan Client/ })).toBeInTheDocument();
  });

  it('opens a fresh thread keyed on the firm and client for a client with no history', async () => {
    seed({ portal: [DANA, EVAN] });

    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Evan Client/ }));

    expect(screen.getByTestId('conversation-view')).toHaveTextContent(`direct:${FIRM}_u-evan:Evan Client`);
  });

  it('opens a group thread as a group', async () => {
    seed({
      portal: [DANA, EVAN],
      groups: [{ conversationId: 'g-1', conversationType: 'group', title: 'Discovery team', matterIds: [MATTER] }],
    });

    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Discovery team/ }));

    expect(screen.getByTestId('conversation-view')).toHaveTextContent('group:g-1:Discovery team');
  });

  it('opens straight into the thread of a matter with one portal client and no groups', async () => {
    seed({ portal: [DANA] });

    renderTab();

    expect(await screen.findByTestId('conversation-view')).toHaveTextContent(`direct:${FIRM}_u-dana:Dana Client`);
  });

  it('shows the list, not a thread, once that single client also has a group', async () => {
    seed({
      portal: [DANA],
      groups: [{ conversationId: 'g-1', conversationType: 'group', title: 'Discovery team', matterIds: [MATTER] }],
    });

    renderTab();

    expect(await screen.findByRole('button', { name: /Discovery team/ })).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-view')).not.toBeInTheDocument();
  });

  it('opens the selected thread on the full Messages page, tagging a group', async () => {
    seed({
      portal: [DANA, EVAN],
      groups: [{ conversationId: 'g-1', conversationType: 'group', title: 'Discovery team', matterIds: [MATTER] }],
    });

    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Discovery team/ }));
    await userEvent.click(screen.getByRole('button', { name: /Open in Messages/ }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/messages/g-1?type=group`);
  });
});

describe('what the tab offers by role', () => {
  // Red if: New group is offered without messaging.send, so a read-only member opens a form that cannot succeed.
  it('offers New group to a member who can send messages', async () => {
    grantBaselineMember();
    seed({ portal: [DANA, EVAN] });

    renderTab();

    expect(await screen.findByRole('button', { name: /New group/ })).toBeInTheDocument();
  });

  it('offers no New group to a member without the send permission', async () => {
    // The baseline carries messaging.send, so this role is built from the exact set that omits it.
    const { grantPermissions } = await import('../../support/permissions');
    grantPermissions(['messaging.view', 'matters.view', 'clients.view']);
    seed({ portal: [DANA, EVAN] });

    renderTab();

    await screen.findByRole('button', { name: /Dana Client/ });
    expect(screen.queryByRole('button', { name: /New group/ })).not.toBeInTheDocument();
  });

  it('offers to invite the clients who have no portal account, only to a member who can invite', async () => {
    const { grantPermissions } = await import('../../support/permissions');
    grantPermissions(['messaging.view', 'messaging.send', 'clients.invite']);
    seed({
      portal: [DANA, EVAN],
      matterClients: [
        { id: 'c-dana', name: 'Dana Client', userId: 'u-dana', clientType: 'person' },
        { id: 'c-evan', name: 'Evan Client', userId: 'u-evan', clientType: 'person' },
        { id: 'c-fran', name: 'Fran Client', clientType: 'person' },
      ],
    });

    renderTab();

    expect(await screen.findByRole('button', { name: /Invite clients \(1\)/ })).toBeInTheDocument();
  });

  it('hides the invite action from a member who cannot invite', async () => {
    const { grantPermissions } = await import('../../support/permissions');
    grantPermissions(['messaging.view', 'messaging.send']);
    seed({
      portal: [DANA, EVAN],
      matterClients: [
        { id: 'c-dana', name: 'Dana Client', userId: 'u-dana', clientType: 'person' },
        { id: 'c-evan', name: 'Evan Client', userId: 'u-evan', clientType: 'person' },
        { id: 'c-fran', name: 'Fran Client', clientType: 'person' },
      ],
    });

    renderTab();

    await screen.findByRole('button', { name: /Dana Client/ });
    expect(screen.queryByRole('button', { name: /Invite clients/ })).not.toBeInTheDocument();
  });
});

describe('the first message to a client with no thread', () => {
  it('keeps the open thread and points Open in Messages at the conversation it created', async () => {
    seed({ portal: [DANA, EVAN] });

    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /Dana Client/ }));
    const view = screen.getByTestId('conversation-view');
    expect(view).toHaveTextContent('direct:firm-1_u-dana');

    await userEvent.click(screen.getByRole('button', { name: 'first send creates the thread' }));

    // The same thread view stays mounted (no remount losing the pending bubble),
    // now on the real id.
    expect(screen.getByTestId('conversation-view')).toBe(view);
    expect(view).toHaveTextContent('direct:conv-created');
    await userEvent.click(screen.getByRole('button', { name: /Open in Messages/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/messages/conv-created');
  });
});
