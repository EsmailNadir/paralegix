jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

import type { SigningRecipient } from '@/types/signature';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSigningRecipients } from '@/hooks/signatureHooks/useSigningRecipients';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();
const url = (firm: string, search = '') => `/api/lawfirms/${firm}/signature-links/recipients${search ? `?search=${search}` : ''}`;
const body = (id: string): { items: SigningRecipient[]; hasMore: boolean } => ({
  items: [{ userId: id, name: id, email: `${id}@example.com`, clientId: `client-${id}`, clientName: id, clientType: 'person', companyLinkId: null, companyName: null }],
  hasMore: false,
});
for (const mode of ['pending', 'late'] as const) {
  itKeepsScopeIsolated({
    title: `keeps signing recipients isolated across firms with a ${mode} response`, mode,
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useSigningRecipients(firm),
    ids: (result) => result.items.map((item) => item.userId),
    a: { props: { firm: 'a' }, url: url('a'), body: body('a-person'), ids: ['a-person'] },
    b: { props: { firm: 'b' }, url: url('b'), body: body('b-person'), ids: ['b-person'] },
  });
}

it('marks old search results as placeholders within the same firm', async () => {
  const next = holdResponse();
  api.getExact(url('a', 'Alice'), body('alice'));
  api.getExact(url('a', 'Bob'), next.handler);
  const { result, rerender } = renderHook(({ search }) => useSigningRecipients('a', { search }), {
    initialProps: { search: ' Alice ' }, wrapper: createQueryWrapper(),
  });
  await waitFor(() => expect(result.current.items[0]?.userId).toBe('alice'));
  rerender({ search: 'Bob' });
  await next.untilRequested();
  expect(result.current.items[0].userId).toBe('alice');
  expect(result.current.isPlaceholder).toBe(true);
  await act(async () => next.release(body('bob')));
  await waitFor(() => expect(result.current.items[0]?.userId).toBe('bob'));
  expect(result.current.isPlaceholder).toBe(false);
});
