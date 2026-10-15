/**
 * Offline contract for the firm's document request templates
 * (`useDocumentRequestTemplates`): the presets offered when a firm asks a
 * client for documents.
 *
 * The New Request modal holds the read back until it opens, so the gate is
 * part of the contract: a matter page that loaded templates on every visit
 * would be the regression. A template's items are shown to the CLIENT, so one
 * firm's presets in another firm's modal would put the wrong firm's wording in
 * front of someone else's client.
 *
 * Driven through the real `documentRequestTemplates.service`.
 *
 * What has to break for these to go red: the gate, a write addressing the wrong
 * firm or template, a write returning the envelope rather than the template,
 * an invalidation that misses this firm or reaches another, or a write sent
 * with no firm.
 */
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useDocumentRequestTemplates from '@/hooks/documentRequestsHooks/useDocumentRequestTemplates';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { sequence, setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

// A write re-reads the list it just changed, which trips the dev-only
// duplicate-GET warning. That re-read is what these specs are about.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const TEMPLATES = (firm: string) => `/api/lawfirms/${firm}/document-request-templates`;
const template = (id: string, name = id) => ({
  id, name, defaultTitle: `${name} documents`, defaultNote: null,
  items: [{ label: 'Photo ID', description: null }],
  archived: false, createdBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});
const ids = (r: { templates: Array<{ id: string }> }) => r.templates.map((t) => t.id);

itSendsNothingWithoutScope({
  title: 'sends nothing without a firm',
  api: () => api,
  useHook: () => useDocumentRequestTemplates(undefined),
  settled: (r) => r.loading === false,
  finally: (r) => expect(r.templates).toEqual([]),
});

itSendsNothingWithoutScope({
  title: 'sends nothing while the modal that needs it is closed',
  api: () => api,
  useHook: () => useDocumentRequestTemplates('firm-a', false),
  settled: (r) => r.loading === false,
});

describe('reading', () => {
  it('loads once the caller opens it, and lists the firm templates', async () => {
    api.getExact(TEMPLATES('firm-a'), { templates: [template('t1', 'Onboarding'), template('t2', 'Tax year')] });

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useDocumentRequestTemplates('firm-a', open),
      { wrapper: createQueryWrapper(), initialProps: { open: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);

    rerender({ open: true });

    await waitFor(() => expect(ids(result.current)).toEqual(['t1', 't2']));
    expect(api.calls()).toHaveLength(1);
  });

  it('reports a failed load rather than an empty list', async () => {
    api.getExact(TEMPLATES('firm-a'), { status: 500, body: { error: 'Templates unavailable' } });

    const { result } = renderHook(() => useDocumentRequestTemplates('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect((result.current.error as Error | null)?.message).toBe('Templates unavailable'));
    expect(result.current.templates).toEqual([]);
  });

  itKeepsScopeIsolated({
    title: "does not offer one firm's templates while another firm's load",
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useDocumentRequestTemplates(firm),
    ids,
    a: { props: { firm: 'firm-a' }, url: TEMPLATES('firm-a'), body: { templates: [template('a-template')] }, ids: ['a-template'] },
    b: { props: { firm: 'firm-b' }, url: TEMPLATES('firm-b'), body: { templates: [template('b-template')] }, ids: ['b-template'] },
  });
});

describe('writing', () => {
  type Hook = ReturnType<typeof useDocumentRequestTemplates>;
  const WRITES: Array<{ name: string; method: 'POST' | 'PUT' | 'DELETE'; path: string; body: unknown; reply: unknown; run: (h: Hook) => Promise<unknown>; returns: unknown }> = [
    {
      name: 'createTemplate',
      method: 'POST',
      path: TEMPLATES('firm-a'),
      body: { name: 'Divorce intake', defaultTitle: 'Financial disclosure' },
      reply: { message: 'Created', templateId: 'new', template: template('new', 'Divorce intake') },
      run: (h) => h.createTemplate({ name: 'Divorce intake', defaultTitle: 'Financial disclosure' }),
      returns: template('new', 'Divorce intake'),
    },
    {
      name: 'updateTemplate',
      method: 'PUT',
      path: `${TEMPLATES('firm-a')}/t1`,
      body: { archived: true },
      reply: { message: 'Updated', template: template('t1') },
      run: (h) => h.updateTemplate('t1', { archived: true }),
      returns: template('t1'),
    },
    {
      name: 'deleteTemplate',
      method: 'DELETE',
      path: `${TEMPLATES('firm-a')}/t1`,
      body: null,
      reply: { message: 'Deleted', templateId: 't1' },
      run: (h) => h.deleteTemplate('t1'),
      returns: { message: 'Deleted', templateId: 't1' },
    },
  ];

  describe.each(WRITES)('$name', ({ method, path, body, reply, run, returns }) => {
    it("reaches its own firm and template, and refreshes only that firm's list", async () => {
      api.getExact(TEMPLATES('firm-a'), sequence({ templates: [template('t1')] }, { templates: [template('t1'), template('new')] }));
      api.getExact(TEMPLATES('firm-b'), { templates: [template('b-template')] });
      ({ POST: api.postExact, PUT: api.putExact, DELETE: api.deleteExact })[method](path, reply as never);

      const { result } = renderHook(() => ({
        a: useDocumentRequestTemplates('firm-a'),
        b: useDocumentRequestTemplates('firm-b'),
      }), { wrapper: createQueryWrapper() });
      await waitFor(() => expect(ids(result.current.a)).toEqual(['t1']));
      await waitFor(() => expect(ids(result.current.b)).toEqual(['b-template']));

      let value: unknown = 'unset';
      await act(async () => {
        value = await run(result.current.a);
      });

      expect(value).toEqual(returns);
      expect(api.calls().filter((c) => c.method !== 'GET').map((c) => [c.method, c.pathname, c.body])).toEqual([[method, path, body]]);
      await waitFor(() => expect(ids(result.current.a)).toEqual(['t1', 'new']));
      expect(api.callsTo('/firm-b/document-request-templates')).toHaveLength(1);
    });

    it('rejects without sending anything when there is no firm', async () => {
      const { result } = renderHook(() => useDocumentRequestTemplates(undefined), { wrapper: createQueryWrapper() });

      await act(async () => {
        await expect(run(result.current)).rejects.toThrow('Law firm ID is required');
      });

      expect(api.calls()).toEqual([]);
    });
  });

  it('rejects a refused write with the server reason and does not refetch', async () => {
    api.getExact(TEMPLATES('firm-a'), { templates: [template('t1')] });
    api.deleteExact(`${TEMPLATES('firm-a')}/t1`, { status: 409, body: { error: 'Template is in use by an open request' } });

    const { result } = renderHook(() => useDocumentRequestTemplates('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(ids(result.current)).toEqual(['t1']));

    await act(async () => {
      await expect(result.current.deleteTemplate('t1')).rejects.toThrow('Template is in use by an open request');
    });

    expect(api.calls('GET')).toHaveLength(1);
  });
});
