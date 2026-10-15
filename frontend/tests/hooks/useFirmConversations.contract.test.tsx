/**
 * Offline contracts for the firm-side direct-conversation lookup.
 *
 * ClientDetail and ClientMessagesTab share this query. The rows contain message
 * previews and unread counts, so treating a missing scope as an empty success,
 * sending the wrong portal user id, or retaining the old firm's cache after a
 * workspace change would expose the wrong conversation state in both places.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useFirmConversations from '@/hooks/messagingHooks/useFirmConversations';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const api = setupApiMock();

beforeEach(() => {
  __resetDuplicateRequestGuard();
});

describe('useFirmConversations offline contract', () => {
  it('does not request conversations without a firm scope or while explicitly disabled', async () => {
    const noFirm = renderHook(() => useFirmConversations(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(noFirm.result.current.loading).toBe(false));
    expect(noFirm.result.current.conversations).toEqual([]);
    expect(noFirm.result.current.error).toBeNull();

    const disabled = renderHook(
      () => useFirmConversations('firm-a', false, { clientId: 'portal-user-a' }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(disabled.result.current.loading).toBe(false));

    expect(disabled.result.current.conversations).toEqual([]);
    expect(api.calls()).toEqual([]);
  });

  it('requests only the selected firm and portal-user filter', async () => {
    api.getExact('/api/lawfirms/firm-a/messaging/conversations?clientId=portal-user-a', {
      conversations: [{ conversationId: 'conversation-a' }],
    });

    const { result } = renderHook(
      () => useFirmConversations('firm-a', true, { clientId: 'portal-user-a' }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-a']));

    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: '/api/lawfirms/firm-a/messaging/conversations',
      query: { clientId: ['portal-user-a'] },
    })]);
    expect(result.current.error).toBeNull();
  });

  it('loads a new list when the portal-user filter changes', async () => {
    api.getExact('/api/lawfirms/firm-a/messaging/conversations?clientId=portal-user-a', {
      conversations: [{ conversationId: 'conversation-a' }],
    });
    api.getExact('/api/lawfirms/firm-a/messaging/conversations?clientId=portal-user-b', {
      conversations: [{ conversationId: 'conversation-b' }],
    });

    const { result, rerender } = renderHook(
      ({ clientId }: { clientId: string }) => useFirmConversations('firm-a', true, { clientId }),
      { initialProps: { clientId: 'portal-user-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-a']));

    rerender({ clientId: 'portal-user-b' });

    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-b']));
    expect(api.calls('GET').map((call) => call.query.clientId)).toEqual([
      ['portal-user-a'],
      ['portal-user-b'],
    ]);
  });

  it('does not replace firm B data when a delayed firm A request settles', async () => {
    const heldFirmA = holdResponse();
    api.getExact('/api/lawfirms/firm-a/messaging/conversations?clientId=portal-user-a', heldFirmA.handler);
    api.getExact('/api/lawfirms/firm-b/messaging/conversations?clientId=portal-user-a', {
      conversations: [{ conversationId: 'conversation-b' }],
    });

    const { result, rerender } = renderHook(
      ({ firmId }: { firmId: string }) => useFirmConversations(firmId, true, { clientId: 'portal-user-a' }),
      { initialProps: { firmId: 'firm-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.callsTo('/firm-a/messaging/conversations')).toHaveLength(1));

    rerender({ firmId: 'firm-b' });
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-b']));

    await act(async () => {
      heldFirmA.release({ conversations: [{ conversationId: 'conversation-a' }] });
    });

    expect(result.current.conversations.map((row) => row.conversationId)).toEqual(['conversation-b']);
    expect(result.current.error).toBeNull();
  });

  it('keeps a failed load distinct from an empty conversation list', async () => {
    api.getExact('/api/lawfirms/firm-a/messaging/conversations?clientId=portal-user-a', {
      status: 403,
      body: { error: 'Messaging access denied' },
    });

    const { result } = renderHook(
      () => useFirmConversations('firm-a', true, { clientId: 'portal-user-a' }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.error).toHaveProperty('message', 'Messaging access denied'));
    expect(result.current.conversations).toEqual([]);
    expect(String(result.current.error)).toMatch(/Messaging access denied/i);
  });
});
