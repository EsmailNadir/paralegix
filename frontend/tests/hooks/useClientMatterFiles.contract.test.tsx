/**
 * Offline contract coverage for the client Documents tab's file listing.
 *
 * The defect this pins: the tab asked `GET /files/list?matterId=…` ONCE PER
 * LINKED MATTER, all at once through `Promise.all`. `listAllClientMatters` pages
 * at 500, so a corporate client with eighty matters fired eighty simultaneous
 * listings the moment the tab opened, each holding one of the API instance's
 * twelve shared Postgres connections. `GET /files/list-matters?matterIds=a,b,c`
 * answers for the whole set in one request, so the request count no longer
 * tracks the size of the client.
 */
jest.unmock('@/services/files.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientMatterFiles from '@/hooks/fileHooks/useClientMatterFiles';
import type { Matter } from '@/types/matter';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock, type RecordedCall } from '../support/apiMock';
import { inFlightProbe } from '../support/inFlightProbe';

const api = setupApiMock();

const BATCH_PATH = '/api/lawfirms/firm-a/files/list-matters';

/**
 * The server's cap on `matterIds` per request, mirrored from
 * `MAX_BATCH_MATTER_IDS` in `backend/src/modules/files/files.validation.ts`.
 * Over it the route answers 400 without reading anything, so the service has to
 * chunk rather than let the tab discover the limit as an error.
 */
const MAX_BATCH_MATTER_IDS = 100;

function matters(count: number): Matter[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `matter-${i}`,
    name: `Matter ${i}`,
  }) as unknown as Matter);
}

/** Twelve linked matters: twelve requests under the old fan-out, one under the batch read. */
const TWELVE_MATTERS = matters(12);

/** Stable identity: a fresh [] each render would re-run the load every render. */
const NO_MATTERS: Matter[] = [];

function file(id: string, name: string) {
  return {
    id,
    parentId: null,
    name,
    objectPath: `firm-a/${name}`,
    size: 1024,
    contentType: 'application/pdf',
    updated: '2026-02-03T00:00:00.000Z',
    signedUrl: `https://files.example/${id}`,
  };
}

function folder(id: string, name: string) {
  return { ...file(id, name), contentType: 'application/x-directory', isFolder: true, fileCount: 2, folderCount: 0 };
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
});

describe('useClientMatterFiles offline contract', () => {
  it('reads every linked matter in ONE request, never one listing per matter', async () => {
    api.get('/files/list-matters', { filesByMatterId: {} });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The whole point. The per-matter loop would make this twelve, and every one
    // of those requests would be unmatched against this mock.
    expect(api.calls()).toHaveLength(1);
    expect(api.callsTo('/files/list')).toHaveLength(0);
    expect(api.calls().filter((call) => call.query.matterId)).toHaveLength(0);

    const [call] = api.calls();
    expect(call.pathname).toBe(BATCH_PATH);
    expect(call.query.matterIds?.[0]?.split(',')).toEqual(TWELVE_MATTERS.map((m) => m.id));
  });

  it('keys the same file map by matter id the per-matter listings produced, folders excluded', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: {
        'matter-0': { files: [file('f1', 'complaint.pdf'), folder('d1', 'Discovery')], truncated: false },
        'matter-1': { files: [], truncated: false },
        'matter-7': { files: [file('f2', 'answer.pdf'), file('f3', 'exhibit.pdf')], truncated: false },
      },
    });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // A matter whose listing held only folders, or nothing at all, stays OUT of
    // the map: the tab reads `files.get(id)?.length ?? 0` for its per-matter
    // count, and an empty entry would render the same zero at the cost of a key
    // the old code never set.
    expect([...result.current.files.keys()].sort()).toEqual(['matter-0', 'matter-7']);
    expect(result.current.files.get('matter-0')?.map((f) => f.id)).toEqual(['f1']);
    expect(result.current.files.get('matter-7')?.map((f) => f.id)).toEqual(['f2', 'f3']);
    expect(result.current.truncated).toBe(false);
  });

  it('warns for the whole tab when ONE matter of several came back short', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: {
        // The short one is read FIRST and complete ones follow it, so a fold
        // that keeps only the last matter's flag reports false here.
        'matter-0': { files: [file('f1', 'complaint.pdf')], truncated: true },
        'matter-1': { files: [file('f2', 'answer.pdf')], truncated: false },
        'matter-7': { files: [file('f3', 'exhibit.pdf')], truncated: false },
      },
    });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The tab merges every matter's documents into one view, so a short listing
    // anywhere makes the combined view short. Rows still render: a partial list
    // plus the warning beats presenting a page as the whole set.
    expect(result.current.truncated).toBe(true);
    expect(result.current.files.get('matter-0')?.map((f) => f.id)).toEqual(['f1']);
  });

  it('leaves the warning off when no matter reported a short listing', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: {
        'matter-0': { files: [file('f1', 'complaint.pdf')], truncated: false },
        'matter-1': { files: [file('f2', 'answer.pdf')], truncated: false },
      },
    });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.truncated).toBe(false);
  });

  it('treats a matter missing from the map exactly as a refused single listing, without losing the rest', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: {
        // `matter-1` is absent: the caller may not read it, which is the batch
        // equivalent of the 403 the per-matter route answered. The old code
        // caught that per matter and recorded no files and no truncation for it.
        'matter-0': { files: [file('f1', 'complaint.pdf')], truncated: false },
        'matter-2': { files: [file('f2', 'answer.pdf')], truncated: false },
      },
    });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files.has('matter-1')).toBe(false);
    expect(result.current.truncated).toBe(false);
    expect([...result.current.files.keys()].sort()).toEqual(['matter-0', 'matter-2']);
  });

  it('leaves the map empty and stops loading when the whole read fails', async () => {
    api.get('/files/list-matters', { status: 403, body: { error: 'Forbidden' } });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.files.size).toBe(0);
    expect(result.current.truncated).toBe(false);
  });

  it('asks for nothing until the tab is opened, and nothing at all for a client with no matters', async () => {
    api.get('/files/list-matters', { filesByMatterId: {} });

    const closed = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: false,
    }));
    await waitFor(() => expect(closed.result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);

    const empty = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: NO_MATTERS,
      enabled: true,
    }));
    await waitFor(() => expect(empty.result.current.loading).toBe(false));
    // An empty `matterIds` is refused by the route, and there is nothing to ask
    // about anyway.
    expect(api.calls()).toHaveLength(0);
  });

  it(`chunks past ${MAX_BATCH_MATTER_IDS} matters and sends the chunks one after another`, async () => {
    const arrivals: string[][] = [];
    // Held open for a macrotask, so chunks fired together genuinely overlap and
    // the peak reads more than one.
    const probe = inFlightProbe(1);

    // Annotated because `respond` takes `unknown | ((call) => unknown)`, which
    // widens to `unknown` and leaves the parameter implicitly any.
    api.get('/files/list-matters', probe.respond((call: RecordedCall) => {
      arrivals.push(String(call.query.matterIds?.[0] ?? '').split(','));
      return { filesByMatterId: {} };
    }));

    const manyMatters = matters(250);
    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: manyMatters,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Sequential is the point, not merely chunked: firing the chunks together
    // would put back the pool pressure the batch route exists to remove, and the
    // peak would read three.
    expect(probe.peak).toBe(1);

    expect(arrivals).toHaveLength(3);
    expect(arrivals.map((ids) => ids.length)).toEqual([MAX_BATCH_MATTER_IDS, MAX_BATCH_MATTER_IDS, 50]);
    const allIds = manyMatters.map((m) => m.id);
    expect(arrivals[0]).toEqual(allIds.slice(0, MAX_BATCH_MATTER_IDS));
    expect(arrivals[1]).toEqual(allIds.slice(MAX_BATCH_MATTER_IDS, MAX_BATCH_MATTER_IDS * 2));
    expect(arrivals[2]).toEqual(allIds.slice(MAX_BATCH_MATTER_IDS * 2));
  });

  it('re-reads on demand, so a finished upload shows its file without a remount', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: { 'matter-0': { files: [file('f1', 'complaint.pdf')], truncated: false } },
    });

    const { result } = renderHook(() => useClientMatterFiles({
      lawFirmId: 'firm-a',
      matters: TWELVE_MATTERS,
      enabled: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(1);

    api.get('/files/list-matters', {
      filesByMatterId: {
        'matter-0': { files: [file('f1', 'complaint.pdf'), file('f9', 'new-upload.pdf')], truncated: false },
      },
    });
    // A re-read after an upload asks the same url again on purpose, which the
    // dev duplicate-fetch guard would otherwise report as two callers racing.
    __resetDuplicateRequestGuard();
    await act(async () => { await result.current.reload(); });

    await waitFor(() => expect(result.current.files.get('matter-0')?.map((f) => f.id)).toEqual(['f1', 'f9']));
    expect(api.calls()).toHaveLength(2);
  });
});
