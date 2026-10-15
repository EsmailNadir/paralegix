/**
 * Offline contract coverage for the firm's signing-activity list.
 *
 * Keyed `['signingSessions', lawFirmId, queryParams]` with bare
 * `placeholderData: keepPreviousData` - the same firm-scoped shape already
 * found and fixed as a cross-tenant leak in `useTasks`/`useClients`.
 */
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import { useSigningSessions } from '@/hooks/signatureHooks/useSigningSessions';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

describe('useSigningSessions offline contract', () => {
  it('fetches the exact firm signing-sessions endpoint', async () => {
    api.get('/lawfirms/firm-a/signature-links/sessions', { sessions: [{ token: 'sess-a' }], totalItems: 1 });

    const { result } = renderHook(() => useSigningSessions('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.sessions.map((s) => s.token)).toEqual(['sess-a']));
  });

  // Firm B's request is still pending here. Firm A's signing sessions must
  // not render as though they belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one firm the signing sessions of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useSigningSessions(lawFirmId),
    ids: (r) => r.sessions.map((s) => s.token),
    a: { props: { lawFirmId: 'firm-a' }, url: '/lawfirms/firm-a/signature-links/sessions', body: { sessions: [{ token: 'firm-a-session' }], totalItems: 1 }, ids: ['firm-a-session'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/lawfirms/firm-b/signature-links/sessions', body: { sessions: [{ token: 'firm-b-session' }], totalItems: 1 }, ids: ['firm-b-session'] },
  });
});
