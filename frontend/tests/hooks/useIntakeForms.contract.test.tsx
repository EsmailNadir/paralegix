/**
 * Offline contract for `leadHooks/useIntakeForms.ts`.
 *
 * A firm-scoped list (`["intakeForms", lawFirmId]`) plus four mutations -
 * create, update, delete, and regenerate-token - that all funnel through one
 * `invalidate()` and all guard on a missing `lawFirmId` before sending
 * anything. `regenerateIntakeFormToken` is the one worth watching closely: it
 * replaces a form's public link, so a caller that forgot to invalidate after
 * it would leave a firm staring at a revoked link with no visible sign it had
 * changed.
 */
jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';

import useIntakeForms from '@/hooks/leadHooks/useIntakeForms';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const FORMS_A = '/api/lawfirms/firm-a/intake-forms';
const FORMS_B = '/api/lawfirms/firm-b/intake-forms';

const api = setupApiMock();
let queryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  queryClient = makeTestQueryClient();
  return createQueryWrapper(queryClient);
}

describe('useIntakeForms: disabled without prerequisites', () => {
  it('sends nothing without a law firm id', async () => {
    const { result } = renderHook(() => useIntakeForms(undefined), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.templates).toEqual([]);
    expect(api.calls()).toEqual([]);
  });

  it('rejects every mutation before a law firm id exists, without sending a request', async () => {
    const { result } = renderHook(() => useIntakeForms(undefined), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.createTemplate({ name: 'Intake' })).rejects.toThrow('Law firm ID is required');
    await expect(result.current.updateTemplate('t1', { name: 'x' })).rejects.toThrow('Law firm ID is required');
    await expect(result.current.deleteTemplate('t1')).rejects.toThrow('Law firm ID is required');
    await expect(result.current.regenerateToken('t1')).rejects.toThrow('Law firm ID is required');
    expect(api.calls()).toEqual([]);
  });
});

describe('useIntakeForms: valid and empty responses', () => {
  it('lists the firm templates', async () => {
    api.getExact(FORMS_A, { templates: [{ id: 't1', name: 'General intake' }, { id: 't2', name: 'PI intake' }] });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.templates).toHaveLength(2));
    expect(result.current.templates.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('reports a real empty set, not a failure', async () => {
    api.getExact(FORMS_A, { templates: [] });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.templates).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useIntakeForms: failure and recovery', () => {
  it('reports a failed load rather than an empty template set', async () => {
    api.getExact(FORMS_A, { status: 500, body: { error: 'Intake service unavailable' } });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.templates).toEqual([]);
    expect(result.current.error).toHaveProperty('message', 'Intake service unavailable');
  });

  it('recovers once a manual refetch succeeds after an earlier failed load', async () => {
    let attempt = 0;
    api.getExact(FORMS_A, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'Intake service unavailable' } };
      return { templates: [{ id: 't1', name: 'General intake' }] };
    });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.error).toHaveProperty('message', 'Intake service unavailable'));

    await act(async () => { await result.current.refetch(); });

    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['t1']));
    expect(result.current.error).toBeFalsy();
  });
});

describe('useIntakeForms: exact query key', () => {
  it('scopes the cache per law firm - a firm switch is a different request, not a stale reuse', async () => {
    api.getExact(FORMS_A, { templates: [{ id: 'a-template' }] });
    api.getExact(FORMS_B, { templates: [{ id: 'b-template' }] });

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useIntakeForms(firm),
      { wrapper: createWrapper(), initialProps: { firm: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['a-template']));

    rerender({ firm: 'firm-b' });

    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['b-template']));
  });
});

describe('useIntakeForms: parameters', () => {
  it('sends the full create payload and returns the created template', async () => {
    api.getExact(FORMS_A, { templates: [] });
    api.postExact(FORMS_A, { template: { id: 't-new', name: 'New form' } });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Awaited<ReturnType<typeof result.current.createTemplate>> | undefined;
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'New form',
        practiceAreaId: 'pa-1',
        fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
        accessCode: 'abc123',
        isActive: true,
      });
    });

    expect(api.calls('POST')[0].body).toEqual({
      name: 'New form',
      practiceAreaId: 'pa-1',
      fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
      accessCode: 'abc123',
      isActive: true,
    });
    expect(created?.id).toBe('t-new');
  });

  it('sends the regenerate-token request to the templateid-scoped endpoint with no body', async () => {
    api.getExact(FORMS_A, { templates: [{ id: 't1', name: 'General', publicToken: 'old' }] });
    api.postExact(`${FORMS_A}/t1/regenerate-token`, { template: { id: 't1', name: 'General', publicToken: 'new' } });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.templates).toHaveLength(1));

    await act(async () => { await result.current.regenerateToken('t1'); });

    expect(api.calls('POST')).toHaveLength(1);
    expect(api.calls('POST')[0].pathname).toBe('/api/lawfirms/firm-a/intake-forms/t1/regenerate-token');
  });
});

describe('useIntakeForms: mutation invalidation', () => {
  it('a create refetches the template list', async () => {
    let getCalls = 0;
    api.getExact(FORMS_A, () => {
      getCalls += 1;
      return { templates: getCalls === 1 ? [] : [{ id: 't-new', name: 'New form' }] };
    });
    api.postExact(FORMS_A, { template: { id: 't-new', name: 'New form' } });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.templates).toEqual([]));

    await act(async () => { await result.current.createTemplate({ name: 'New form' }); });

    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['t-new']));
  });

  it('a delete refetches the template list', async () => {
    let getCalls = 0;
    api.getExact(FORMS_A, () => {
      getCalls += 1;
      return { templates: getCalls === 1 ? [{ id: 't1' }] : [] };
    });
    api.deleteExact(`${FORMS_A}/t1`, { message: 'deleted' });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['t1']));

    await act(async () => { await result.current.deleteTemplate('t1'); });

    await waitFor(() => expect(result.current.templates).toEqual([]));
  });

  it('a token regeneration refetches the list, so the new token is what the firm sees', async () => {
    let getCalls = 0;
    api.getExact(FORMS_A, () => {
      getCalls += 1;
      return { templates: [{ id: 't1', publicToken: getCalls === 1 ? 'old' : 'new' }] };
    });
    api.postExact(`${FORMS_A}/t1/regenerate-token`, { template: { id: 't1', publicToken: 'new' } });

    const { result } = renderHook(() => useIntakeForms('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.templates[0]?.publicToken).toBe('old'));

    await act(async () => { await result.current.regenerateToken('t1'); });

    await waitFor(() => expect(result.current.templates[0]?.publicToken).toBe('new'));
  });
});
