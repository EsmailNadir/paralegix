/**
 * Offline contract for `matterConfigHooks/useMatterPipelines.ts`.
 *
 * One query (`matterPipelinesQueryKey`) backs two exported values: `pipelines`
 * (the raw list) and `stages` (`pipelines.flatMap(p => p.stages ?? [])`, a
 * derived value with no query of its own). Six mutations share one
 * `invalidate()` - but they hit TWO different REST resources:
 * `createPipeline`/`updatePipeline`/`deletePipeline` call
 * `/matter-stage-pipelines`, while `createStage`/`updateStage`/`deleteStage`
 * call the separate, flat `/matter-stages` endpoint (`matters.service.ts`'s
 * `stagesUrl`, not nested under a pipeline id). The stage mutations updating a
 * completely different resource still have to invalidate the PIPELINES query,
 * because that is the only place `stages` is derived from. A caller who
 * changed the pipelines invalidation but missed the stage one (or vice versa)
 * would leave the config screen showing a stale stage list after adding one,
 * and nothing before this file exercised that path at all.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor, act } from '@testing-library/react';

import useMatterPipelines from '@/hooks/matterConfigHooks/useMatterPipelines';

import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const PIPELINES_A = '/api/lawfirms/firm-a/matter-stage-pipelines';
const STAGES_A = '/api/lawfirms/firm-a/matter-stages';

const api = setupApiMock();

describe('useMatterPipelines: disabled without prerequisites', () => {
  it('sends nothing without a law firm id', async () => {
    const { result } = renderHook(() => useMatterPipelines(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pipelines).toEqual([]);
    expect(result.current.stages).toEqual([]);
    expect(api.calls()).toEqual([]);
  });
});

describe('useMatterPipelines: valid and empty responses', () => {
  it('derives the flat stage list from every pipeline\'s nested stages', async () => {
    api.getExact(PIPELINES_A, {
      pipelines: [
        { id: 'p1', name: 'Litigation', stages: [{ id: 's1', name: 'Filed' }, { id: 's2', name: 'Discovery' }] },
        { id: 'p2', name: 'Transactional', stages: [{ id: 's3', name: 'Drafting' }] },
      ],
    });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.pipelines).toHaveLength(2));
    expect(result.current.stages.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('reports a real empty pipeline set, not a failure', async () => {
    api.getExact(PIPELINES_A, { pipelines: [] });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pipelines).toEqual([]);
    expect(result.current.stages).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('a pipeline with no stages array contributes nothing rather than throwing', async () => {
    api.getExact(PIPELINES_A, { pipelines: [{ id: 'p1', name: 'Bare' }] });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.pipelines).toHaveLength(1));
    expect(result.current.stages).toEqual([]);
  });
});

describe('useMatterPipelines: failure and recovery', () => {
  it('reports a failed load instead of an empty pipeline set', async () => {
    api.getExact(PIPELINES_A, { status: 500, body: { error: 'Pipeline service unavailable' } });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pipelines).toEqual([]);
    expect(result.current.error).toHaveProperty('message', 'Pipeline service unavailable');
  });

  it('recovers once the pipeline mutation refetch succeeds after an earlier failed load', async () => {
    let attempt = 0;
    api.getExact(PIPELINES_A, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'Pipeline service unavailable' } };
      return { pipelines: [{ id: 'p1', name: 'Litigation', stages: [] }] };
    });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy());

    await act(async () => { await result.current.refetch(); });

    await waitFor(() => expect(result.current.pipelines.map((p) => p.id)).toEqual(['p1']));
    expect(result.current.error).toBeFalsy();
  });
});

describe('useMatterPipelines: parameters', () => {
  it('sends the full create-pipeline payload including its nested stage drafts', async () => {
    api.getExact(PIPELINES_A, { pipelines: [] });
    api.postExact(PIPELINES_A, { pipeline: { id: 'p-new', name: 'New', stages: [] } });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createPipeline({
        name: 'New',
        practiceAreaId: 'pa-1',
        isDefault: true,
        stages: [{ clientId: 'draft-1', name: 'Intake', color: '#fff', sortOrder: 0, isClosed: false, parentClientId: null }],
      });
    });

    const post = api.calls('POST')[0];
    expect(post.body).toEqual({
      name: 'New',
      practiceAreaId: 'pa-1',
      isDefault: true,
      stages: [{ clientId: 'draft-1', name: 'Intake', color: '#fff', sortOrder: 0, isClosed: false, parentClientId: null }],
    });
  });

  it('rejects every mutation before a law firm id exists, without sending a request', async () => {
    const { result } = renderHook(() => useMatterPipelines(undefined), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.createStage({ name: 'x' })).rejects.toThrow('Law firm ID is required');
    await expect(result.current.deletePipeline('p1')).rejects.toThrow('Law firm ID is required');
    expect(api.calls()).toEqual([]);
  });
});

describe('useMatterPipelines: mutation invalidation across both REST resources', () => {
  it('a pipeline mutation refetches the pipelines list', async () => {
    let getCalls = 0;
    api.getExact(PIPELINES_A, () => {
      getCalls += 1;
      return { pipelines: [{ id: 'p1', name: `v${getCalls}`, stages: [] }] };
    });
    api.putExact(`${PIPELINES_A}/p1`, { pipeline: { id: 'p1', name: 'renamed', stages: [] } });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.pipelines.map((p) => p.name)).toEqual(['v1']));

    await act(async () => { await result.current.updatePipeline('p1', { name: 'renamed' }); });

    await waitFor(() => expect(result.current.pipelines.map((p) => p.name)).toEqual(['v2']));
  });

  it('a stage mutation against the SEPARATE /matter-stages resource still refetches the pipelines query, updating the derived stage list', async () => {
    let getCalls = 0;
    api.getExact(PIPELINES_A, () => {
      getCalls += 1;
      const stages = getCalls === 1
        ? [{ id: 's1', name: 'Filed' }]
        : [{ id: 's1', name: 'Filed' }, { id: 's2', name: 'Discovery' }];
      return { pipelines: [{ id: 'p1', name: 'Litigation', stages }] };
    });
    api.postExact(STAGES_A, { stage: { id: 's2', name: 'Discovery' } });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1']));

    await act(async () => { await result.current.createStage({ name: 'Discovery' }); });

    // The request went to /matter-stages, not /matter-stage-pipelines, but the
    // pipelines query (and therefore the derived `stages` list) still updates.
    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1', 's2']));
    expect(getCalls).toBe(2);
  });

  it('a stage delete also refetches the pipelines query', async () => {
    let getCalls = 0;
    api.getExact(PIPELINES_A, () => {
      getCalls += 1;
      const stages = getCalls === 1 ? [{ id: 's1' }, { id: 's2' }] : [{ id: 's1' }];
      return { pipelines: [{ id: 'p1', name: 'Litigation', stages }] };
    });
    api.deleteExact(`${STAGES_A}/s2`, { message: 'deleted' });

    const { result } = renderHook(() => useMatterPipelines('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1', 's2']));

    await act(async () => { await result.current.deleteStage('s2'); });

    await waitFor(() => expect(result.current.stages.map((s) => s.id)).toEqual(['s1']));
  });
});
