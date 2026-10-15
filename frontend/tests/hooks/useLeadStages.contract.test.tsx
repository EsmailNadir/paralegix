/**
 * Offline contract for `leadHooks/useLeadStages.ts`.
 *
 * A firm-scoped list (`["leadStages", lawFirmId]`), the lead pipeline every
 * lead sits in, plus four mutations that all invalidate the
 * same key. `reorderStages` is the one worth its own coverage: it posts to a
 * SEPARATE `/lead-stages/reorder` endpoint (not a stage id) with a
 * `{ stageIds }` body, the same "different REST resource, same cache" shape
 * already found worth pinning in `useMatterPipelines.contract.test.tsx`.
 */
jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';

import useLeadStages from '@/hooks/leadHooks/useLeadStages';

import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const STAGES_A = '/api/lawfirms/firm-a/lead-stages';
const STAGES_B = '/api/lawfirms/firm-b/lead-stages';

const api = setupApiMock();
let queryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  queryClient = makeTestQueryClient();
  return createQueryWrapper(queryClient);
}

describe('useLeadStages: disabled without prerequisites', () => {
  it('sends nothing without a law firm id', async () => {
    const { result } = renderHook(() => useLeadStages(undefined), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stages).toEqual([]);
    expect(api.calls()).toEqual([]);
  });

  it('rejects every mutation before a law firm id exists, without sending a request', async () => {
    const { result } = renderHook(() => useLeadStages(undefined), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.createStage({ name: 'Intake' })).rejects.toThrow('Law firm ID is required');
    await expect(result.current.updateStage('s1', { name: 'x' })).rejects.toThrow('Law firm ID is required');
    await expect(result.current.deleteStage('s1')).rejects.toThrow('Law firm ID is required');
    await expect(result.current.reorderStages(['s1', 's2'])).rejects.toThrow('Law firm ID is required');
    expect(api.calls()).toEqual([]);
  });
});

describe('useLeadStages: valid and empty responses', () => {
  it('lists the firm stages in server order', async () => {
    api.getExact(STAGES_A, { stages: [{ id: 's1', name: 'New' }, { id: 's2', name: 'Contacted' }] });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.stages).toHaveLength(2));
    expect(result.current.stages.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('reports a real empty pipeline, not a failure', async () => {
    api.getExact(STAGES_A, { stages: [] });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stages).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useLeadStages: failure and recovery', () => {
  it('reports a failed load rather than an empty stage list', async () => {
    api.getExact(STAGES_A, { status: 500, body: { error: 'Stage service unavailable' } });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stages).toEqual([]);
    expect(result.current.error).toHaveProperty('message', 'Stage service unavailable');
  });

  it('recovers once a manual refetch succeeds after an earlier failed load', async () => {
    let attempt = 0;
    api.getExact(STAGES_A, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'Stage service unavailable' } };
      return { stages: [{ id: 's1', name: 'New' }] };
    });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.error).toHaveProperty('message', 'Stage service unavailable'));

    await act(async () => { await result.current.refetch(); });

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1']));
    expect(result.current.error).toBeFalsy();
  });
});

describe('useLeadStages: exact query key', () => {
  it('scopes the cache per law firm', async () => {
    api.getExact(STAGES_A, { stages: [{ id: 'a-stage' }] });
    api.getExact(STAGES_B, { stages: [{ id: 'b-stage' }] });

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useLeadStages(firm),
      { wrapper: createWrapper(), initialProps: { firm: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['a-stage']));

    rerender({ firm: 'firm-b' });

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['b-stage']));
  });
});

describe('useLeadStages: parameters', () => {
  it('posts the reorder request to the separate /reorder endpoint with the ordered id list', async () => {
    api.getExact(STAGES_A, { stages: [{ id: 's1' }, { id: 's2' }] });
    api.postExact(`${STAGES_A}/reorder`, { stages: [{ id: 's2' }, { id: 's1' }] });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.stages).toHaveLength(2));

    await act(async () => { await result.current.reorderStages(['s2', 's1']); });

    const post = api.calls('POST')[0];
    expect(post.pathname).toBe('/api/lawfirms/firm-a/lead-stages/reorder');
    expect(post.body).toEqual({ stageIds: ['s2', 's1'] });
  });

  it('sends the update payload to the stage-id-scoped endpoint', async () => {
    api.getExact(STAGES_A, { stages: [{ id: 's1', name: 'New' }] });
    api.putExact(`${STAGES_A}/s1`, { stage: { id: 's1', name: 'Renamed' } });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.stages).toHaveLength(1));

    await act(async () => { await result.current.updateStage('s1', { name: 'Renamed' }); });

    expect(api.calls('PUT')[0].body).toEqual({ name: 'Renamed' });
  });
});

describe('useLeadStages: mutation invalidation', () => {
  it('a create refetches the stage list', async () => {
    let getCalls = 0;
    api.getExact(STAGES_A, () => {
      getCalls += 1;
      return { stages: getCalls === 1 ? [] : [{ id: 's-new', name: 'New' }] };
    });
    api.postExact(STAGES_A, { stage: { id: 's-new', name: 'New' } });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.stages).toEqual([]));

    await act(async () => { await result.current.createStage({ name: 'New' }); });

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s-new']));
  });

  it('a delete refetches the stage list', async () => {
    let getCalls = 0;
    api.getExact(STAGES_A, () => {
      getCalls += 1;
      return { stages: getCalls === 1 ? [{ id: 's1' }] : [] };
    });
    api.deleteExact(`${STAGES_A}/s1`, { message: 'deleted' });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1']));

    await act(async () => { await result.current.deleteStage('s1'); });

    await waitFor(() => expect(result.current.stages).toEqual([]));
  });

  it('a reorder against the SEPARATE /reorder endpoint still refetches the stage list, in the new order', async () => {
    let getCalls = 0;
    api.getExact(STAGES_A, () => {
      getCalls += 1;
      return { stages: getCalls === 1 ? [{ id: 's1' }, { id: 's2' }] : [{ id: 's2' }, { id: 's1' }] };
    });
    api.postExact(`${STAGES_A}/reorder`, { stages: [{ id: 's2' }, { id: 's1' }] });

    const { result } = renderHook(() => useLeadStages('firm-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1', 's2']));

    await act(async () => { await result.current.reorderStages(['s2', 's1']); });

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s2', 's1']));
    expect(getCalls).toBe(2);
  });
});
