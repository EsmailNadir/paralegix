/**
 * Offline contract for `usePipelineBuilder`, the draft state behind the "new
 * matter pipeline" flow in Matter Configuration.
 *
 * The builder drafts a tree of stages locally, then creates the pipeline and
 * its stages in one request. Each draft carries a local id and a local parent
 * id; the server resolves those into real ids, so a draft whose parent link is
 * wrong is saved as a wrongly shaped pipeline with no error anywhere.
 *
 * Driven through the real `matters.service` and `practiceArea.service`, so the
 * firm's pipelines (for the duplicate-name warning) and practice areas (for the
 * scope picker) come off the transport.
 *
 * What has to break for these to go red: the draft not resetting on reopen, a
 * child stage losing its parent on delete, the example tree's parent links or
 * sibling order, the create body (trimmed names, firm-wide scope as null, local
 * ids as `clientId`/`parentClientId`), a double submit, a failure left
 * looking like a save, or one firm's practice areas offered in another firm.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import usePipelineBuilder, { FIRM_WIDE } from '@/hooks/matterConfigHooks/usePipelineBuilder';
import { STAGE_COLORS, DEFAULT_STAGE_COLOR } from '@/constants/stageColors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { sequence, setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

// A create re-reads the firm's pipelines straight away, which trips the
// dev-only duplicate-GET warning. That re-read is part of what is tested.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const PIPELINES = (firm: string) => `/api/lawfirms/${firm}/matter-stage-pipelines`;
const PRACTICE_AREAS = (firm: string) => `/api/lawfirms/${firm}/practice-areas`;

function serveFirm(firm = 'firm-a', pipelines: Array<{ id: string; name: string }> = []) {
  api.getExact(PIPELINES(firm), { pipelines });
  api.getExact(PRACTICE_AREAS(firm), { practiceAreas: [{ id: `${firm}-pa-family`, name: 'Family' }] });
}

type Props = { lawFirmId: string; active: boolean; defaultPracticeAreaId?: string | null };

function renderBuilder(initial: Partial<Props> = {}) {
  return renderHook((props: Props) => usePipelineBuilder(props), {
    wrapper: createQueryWrapper(),
    initialProps: { lawFirmId: 'firm-a', active: true, ...initial },
  });
}

const shape = (drafts: Array<{ localId: string; name: string; parentId: string | null; sortOrder: number }>) =>
  drafts.map((d) => [d.localId, d.name, d.parentId, d.sortOrder]);

describe('seeding the draft', () => {
  it('opens on one Intake stage, firm-wide, with nothing being edited', async () => {
    serveFirm();
    const { result } = renderBuilder();

    expect(result.current.name).toBe('');
    expect(result.current.scope).toBe(FIRM_WIDE);
    expect(result.current.isDefault).toBe(false);
    expect(result.current.editingId).toBeNull();
    expect(result.current.drafts).toEqual([
      { localId: 'd1', name: 'Intake', color: DEFAULT_STAGE_COLOR, isClosed: false, parentId: null, sortOrder: 0 },
    ]);
    expect(result.current.editorNodes).toEqual([
      { id: 'd1', name: 'Intake', color: DEFAULT_STAGE_COLOR, isClosed: false, parentId: null, sortOrder: 0 },
    ]);
    await waitFor(() => expect(result.current.scopeOptions).toHaveLength(2));
  });

  it('starts in the practice area the caller opened it from', () => {
    serveFirm();
    const { result } = renderBuilder({ defaultPracticeAreaId: 'firm-a-pa-family' });

    expect(result.current.scope).toBe('firm-a-pa-family');
  });

  it('throws away the previous draft when it comes back into view', async () => {
    serveFirm();
    const { result, rerender } = renderBuilder();

    act(() => {
      result.current.setName('Litigation');
      result.current.setIsDefault(true);
      result.current.setScope('firm-a-pa-family');
    });
    act(() => result.current.addNode('d1'));
    expect(result.current.drafts).toHaveLength(2);

    rerender({ lawFirmId: 'firm-a', active: false });
    rerender({ lawFirmId: 'firm-a', active: true });

    expect(result.current.name).toBe('');
    expect(result.current.isDefault).toBe(false);
    expect(result.current.scope).toBe(FIRM_WIDE);
    expect(shape(result.current.drafts)).toEqual([['d1', 'Intake', null, 0]]);
    // Ids restart too, so the next stage added is d2 again, not d3.
    act(() => result.current.addNode('d1'));
    expect(result.current.drafts[1].localId).toBe('d2');
  });
});

describe('editing the stage tree', () => {
  it('adds a stage under its parent, after its siblings, in the next colour, and opens it for editing', () => {
    serveFirm();
    const { result } = renderBuilder();

    act(() => result.current.addNode('d1', 'Discovery'));
    act(() => result.current.addNode('d1'));
    act(() => result.current.addNode(null, 'Parallel root'));

    expect(shape(result.current.drafts)).toEqual([
      ['d1', 'Intake', null, 0],
      ['d2', 'Discovery', 'd1', 0],
      ['d3', 'New stage', 'd1', 1],
      ['d4', 'Parallel root', null, 1],
    ]);
    expect(result.current.drafts.map((d) => d.color)).toEqual([
      DEFAULT_STAGE_COLOR, STAGE_COLORS[1], STAGE_COLORS[2], STAGE_COLORS[3],
    ]);
    expect(result.current.editingId).toBe('d4');
    expect(result.current.editing?.name).toBe('Parallel root');
  });

  it('patches one stage and leaves the others alone', () => {
    serveFirm();
    const { result } = renderBuilder();
    act(() => result.current.addNode('d1', 'Discovery'));

    act(() => result.current.updateDraft('d2', { name: 'Fact discovery', isClosed: true }));

    expect(result.current.drafts.map((d) => [d.name, d.isClosed])).toEqual([
      ['Intake', false],
      ['Fact discovery', true],
    ]);
  });

  it("promotes a deleted stage's children to its own parent, as the server does", () => {
    serveFirm();
    const { result } = renderBuilder();
    act(() => result.current.addNode('d1', 'Discovery'));
    act(() => result.current.addNode('d2', 'Depositions'));
    act(() => result.current.addNode('d2', 'Experts'));

    act(() => result.current.deleteDraft('d2'));

    expect(shape(result.current.drafts)).toEqual([
      ['d1', 'Intake', null, 0],
      ['d3', 'Depositions', 'd1', 0],
      ['d4', 'Experts', 'd1', 1],
    ]);
  });

  it('ignores a delete for a stage that is not in the draft', () => {
    serveFirm();
    const { result } = renderBuilder();
    const before = result.current.drafts;

    act(() => result.current.deleteDraft('d99'));

    expect(result.current.drafts).toBe(before);
  });

  it('swaps in the branching example with real parent links and per-parent order', () => {
    serveFirm();
    const { result } = renderBuilder();
    act(() => result.current.addNode('d1'));

    act(() => result.current.fillExampleStages());

    expect(shape(result.current.drafts)).toEqual([
      ['d1', 'Intake', null, 0],
      ['d2', 'Discovery', 'd1', 0],
      ['d3', 'Negotiation', 'd2', 0],
      ['d4', 'Won', 'd3', 0],
      ['d5', 'Lost', 'd3', 1],
      ['d6', 'Settled', 'd3', 2],
    ]);
    expect(result.current.drafts.filter((d) => d.isClosed).map((d) => d.name)).toEqual(['Won', 'Lost', 'Settled']);
    expect(result.current.editingId).toBeNull();
  });
});

describe("the firm's existing pipelines and practice areas", () => {
  it('offers firm-wide first, then the practice areas of this firm', async () => {
    serveFirm();
    const { result } = renderBuilder();

    await waitFor(() => expect(result.current.scopeOptions).toEqual([
      { label: 'Firm-wide (no practice area)', value: FIRM_WIDE },
      { label: 'Family', value: 'firm-a-pa-family' },
    ]));
  });

  it('warns about a name already used in this firm, ignoring case and outer spaces', async () => {
    serveFirm('firm-a', [{ id: 'p1', name: 'Litigation' }]);
    const { result } = renderBuilder();
    await waitFor(() => expect(api.callsTo('/matter-stage-pipelines')).toHaveLength(1));

    act(() => result.current.setName('  litigation '));
    await waitFor(() => expect(result.current.duplicateName?.id).toBe('p1'));

    act(() => result.current.setName('Litigation 2'));
    expect(result.current.duplicateName).toBeNull();
  });

  itKeepsScopeIsolated({
    title: "does not offer one firm's practice areas in another firm while they load",
    mode: 'pending',
    api: () => {
      api.getExact(PIPELINES('firm-a'), { pipelines: [] });
      api.getExact(PIPELINES('firm-b'), { pipelines: [] });
      return api;
    },
    useHook: ({ firm }: { firm: string }) => usePipelineBuilder({ lawFirmId: firm, active: true }),
    ids: (r) => r.scopeOptions.slice(1).map((o) => o.value),
    a: {
      props: { firm: 'firm-a' },
      url: PRACTICE_AREAS('firm-a'),
      body: { practiceAreas: [{ id: 'firm-a-pa', name: 'Family' }] },
      ids: ['firm-a-pa'],
    },
    b: {
      props: { firm: 'firm-b' },
      url: PRACTICE_AREAS('firm-b'),
      body: { practiceAreas: [{ id: 'firm-b-pa', name: 'Probate' }] },
      ids: ['firm-b-pa'],
    },
  });
});

describe('creating the pipeline', () => {
  it('sends the whole tree in one request and re-reads the firm pipelines', async () => {
    api.getExact(PIPELINES('firm-a'), sequence(
      { pipelines: [] },
      { pipelines: [{ id: 'p-new', name: 'Litigation' }] },
    ));
    api.getExact(PRACTICE_AREAS('firm-a'), { practiceAreas: [] });
    api.postExact(PIPELINES('firm-a'), { pipeline: { id: 'p-new', name: 'Litigation' } });

    const { result } = renderBuilder();
    await waitFor(() => expect(api.callsTo('/matter-stage-pipelines')).toHaveLength(1));
    act(() => {
      result.current.setName('  Litigation  ');
      result.current.setIsDefault(true);
    });
    act(() => result.current.addNode('d1', ' Discovery '));

    let created: unknown;
    await act(async () => {
      created = await result.current.handleCreate();
    });

    expect(created).toEqual({ id: 'p-new', name: 'Litigation' });
    expect(api.calls('POST').map((c) => c.body)).toEqual([{
      name: 'Litigation',
      // Firm-wide is the empty scope in the picker and null on the wire.
      practiceAreaId: null,
      isDefault: true,
      stages: [
        { clientId: 'd1', name: 'Intake', color: DEFAULT_STAGE_COLOR, sortOrder: 0, isClosed: false, parentClientId: null },
        { clientId: 'd2', name: 'Discovery', color: STAGE_COLORS[1], sortOrder: 0, isClosed: false, parentClientId: 'd1' },
      ],
    }]);
    await waitFor(() => expect(api.callsTo('/matter-stage-pipelines').filter((c) => c.method === 'GET')).toHaveLength(2));
    // Left true on success so the duplicate-name warning, which now matches the
    // pipeline just created, does not flash before the caller closes.
    expect(result.current.saving).toBe(true);
  });

  it('scopes the pipeline to the chosen practice area', async () => {
    serveFirm();
    api.postExact(PIPELINES('firm-a'), { pipeline: { id: 'p-new' } });
    const { result } = renderBuilder();
    act(() => {
      result.current.setName('Family intake');
      result.current.setScope('firm-a-pa-family');
    });

    await act(async () => {
      await result.current.handleCreate();
    });

    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({ practiceAreaId: 'firm-a-pa-family' }));
  });

  it('sends nothing for a blank name', async () => {
    serveFirm();
    const { result } = renderBuilder();
    act(() => result.current.setName('   '));

    let created: unknown = 'unset';
    await act(async () => {
      created = await result.current.handleCreate();
    });

    expect(created).toBeNull();
    expect(api.calls('POST')).toEqual([]);
  });

  it('ignores a second click while the first create is in flight', async () => {
    serveFirm();
    const post = holdResponse();
    api.postExact(PIPELINES('firm-a'), post.handler);
    const { result } = renderBuilder();
    act(() => result.current.setName('Litigation'));

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.handleCreate();
    });
    await post.untilRequested();

    let second: unknown = 'unset';
    await act(async () => {
      second = await result.current.handleCreate();
    });

    expect(second).toBeNull();
    expect(api.calls('POST')).toHaveLength(1);
    await act(async () => {
      post.release({ pipeline: { id: 'p-new' } });
      await first;
    });
  });

  it('reports a refused create and lets the person try again', async () => {
    serveFirm();
    api.postExact(PIPELINES('firm-a'), { status: 409, body: { error: 'A pipeline with that name already exists' } });
    const { result } = renderBuilder();
    act(() => result.current.setName('Litigation'));

    let created: unknown = 'unset';
    await act(async () => {
      created = await result.current.handleCreate();
    });

    expect(created).toBeNull();
    expect((result.current.error as Error).message).toBe('A pipeline with that name already exists');
    expect(result.current.saving).toBe(false);

    act(() => result.current.setError(null));
    expect(result.current.error).toBeNull();
  });
});
