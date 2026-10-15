/**
 * The files service, tested OFFLINE against a fake transport.
 *
 * `files.service.ts` reports 0%. It is the layer that decides what happens to a
 * firm's documents: where they are stored, who outside the firm can read them,
 * and which ones are deleted. Nothing on screen looks wrong when it is wrong -
 * a file shared with the whole matter instead of one client renders exactly like
 * a file shared with one client.
 *
 * WHAT GETS THE MOST ATTENTION
 * 1. The SCOPE. Every request carries the firm in its PATH and the scope
 *    (matterId / taskId / clientId) alongside it, and `scopedBody` repeats the
 *    firm in the BODY as well. Two sources for one fact can disagree, and a
 *    dropped scope does not fail: the server falls back to the firm's General
 *    Files, so a search, a listing or a delete quietly addresses the wrong pile
 *    of documents.
 * 2. `setClientVisibility`, the single gate between a firm's storage and a
 *    client's portal. `clientVisible: false` has to survive as a literal false,
 *    and `visibleClientIds` means three different things absent, empty, and
 *    populated.
 * 3. The resumable upload. The bytes go browser -> GCS on a signed session url,
 *    which means the ONE request in this service that must not carry the firm's
 *    credential. `xhrMock` covers that leg; `apiMock` covers init and finalize.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, sequence, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { installXhrMock, formDataValues, type XhrMock, type RecordedXhrCall } from '../../support/xhrMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import filesService, { MAX_BULK_VISIBILITY_FILE_IDS } from '@/services/files.service';
import { FIRM_SCOPE, matterScope, taskScope, clientScope } from '@/lib/files/fileScope';
import {
  saveUploadSession,
  loadUploadSession,
  type UploadDestination,
  type FileIdentity,
} from '@/lib/files/uploadSessionStore';
import { fingerprintFile } from '@/lib/files/fileFingerprint';
import { runWithUploadLimit } from '@/lib/files/uploadConcurrency';
import { installWebLocks, removeWebLocks, type WebLocksMock } from '../../support/webLocks';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-9';
const TASK_ID = 'task-4';
const CLIENT_ID = 'client-7';
const OBJECT_PATH = 'lawfirmids/firm-1/objects/8d4f2a10-0000-4000-8000-000000000001';
/** A document's id, which is the address every operation takes. */
const FILE_ID = '8d4f2a10-0000-4000-8000-000000000001';
/** A folder's id, for the destination of a move, an upload or a listing. */
const FOLDER_ID = '8d4f2a10-0000-4000-8000-0000000000f0';

let api: ApiMock;
let xhr: XhrMock;
let locks: WebLocksMock;
let clickedLinks: HTMLAnchorElement[];
let savedBlobs: Array<Blob | MediaSource>;
let clickSpy: jest.SpyInstance;

/**
 * Poll until a condition holds.
 *
 * Fingerprinting a picked file reads it through a `FileReader`, which settles
 * on macrotasks, so a fixed number of turns is a race that shows up as a
 * failure on a loaded machine and nowhere else.
 */
async function waitFor(condition: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Query parameters of a recorded call, read back the way a server reads them. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

const fileNamed = (name: string, type = 'application/pdf', body = 'abcd'): File =>
  new File([body], name, { type });

/**
 * Settle an upload that retries under fake timers.
 *
 * The rejection handlers attach BEFORE the timers advance, so a promise that
 * rejects during the backoff is not reported as unhandled, and the backoff
 * itself runs in fake time rather than the tens of seconds it represents.
 */
/** The real one, captured before any spec installs fake timers over it. */
const realSetImmediate = setImmediate;

/**
 * Run `work` to completion while fake timers stand in for the retry delays.
 *
 * `runAllTimersAsync` drains the timers that exist WHEN IT RUNS. The upload
 * path also does real asynchronous work between them: it streams a SHA-256 of
 * the file to fingerprint it. A retry timer scheduled after that hashing
 * finishes is one a single drain misses, and the awaited promise then sits
 * there until the spec's own 30 second timeout kills it. Which of the two wins
 * depends on how loaded the machine is, so a single drain is a race.
 *
 * These specs were seen timing out exactly that way during a heavily loaded
 * run and passing on a quiet one. That is consistent with this race but was
 * not reproducible on demand, so treat the loop as removing a known hazard
 * rather than as a diagnosis of that particular failure. Draining repeatedly,
 * and yielding to real work in between, settles the promise whatever the
 * order.
 */
async function settleUnderFakeTimers<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const guarded = work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  ).finally(() => { settled = true; });

  // Bounded, so a promise that genuinely never resolves still fails as a
  // timeout rather than spinning here forever.
  for (let pass = 0; pass < 1000 && !settled; pass += 1) {
    await jest.runAllTimersAsync();
    if (settled) break;
    await new Promise((resolve) => realSetImmediate(resolve));
  }

  const outcome = await guarded;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * The destination the service builds for a matter-scoped upload, which is what
 * a remembered session is keyed on. The uid matches the harness's signed-in
 * user (`tests/setup.ts` mocks Firebase with uid "test-uid").
 */
const matterDestination = (over: Partial<UploadDestination> = {}): UploadDestination => ({
  lawFirmId: LAW_FIRM_ID,
  userId: 'test-uid',
  context: 'matter',
  matterId: MATTER_ID,
  taskId: undefined,
  clientId: undefined,
  folderId: null,
  ...over,
});

/**
 * What the store keys a picked file on: its metadata AND a streamed SHA-256 of
 * its content. The service computes the same tuple, and `fingerprintFile`
 * memoises per File instance, so a spec and the code under test agree.
 */
const identity = async (file: File): Promise<FileIdentity> => ({
  name: file.name,
  size: file.size,
  lastModified: file.lastModified,
  fingerprint: await fingerprintFile(file),
});

// The data-carrying PUTs, leaving out the status queries (a Content-Range of
// "bytes" star slash total). A line comment on purpose: that header, written
// literally, would end a block comment.
const chunkPuts = (calls: RecordedXhrCall[]) =>
  calls.filter((c) => c.method === 'PUT' && !/^bytes \*\//.test(c.headers['content-range'] || ''));

beforeEach(() => {
  // Session memory is per file identity and jsdom's localStorage persists
  // across tests in a file, so a session an earlier case left open must not
  // make a later case skip its init call.
  window.localStorage.clear();
  api = installApiMock();
  xhr = installXhrMock();
  // jsdom has no Web Locks, and without them the service refuses to adopt a
  // remembered session at all: it cannot prove no other tab is driving it. One
  // tab in a browser that HAS the API is the ordinary case, so it is the
  // default here; the specs about the other cases install their own.
  locks = installWebLocks();
  // The dev-only duplicate-GET guard warns when a spec hits the same endpoint
  // twice inside its window, which is normal here and would otherwise bury the
  // real output.
  __resetDuplicateRequestGuard();

  // jsdom implements neither object urls nor a navigating anchor click, and the
  // zip download paths use both. Capturing them is also how a spec proves the
  // download was saved under the right name.
  clickedLinks = [];
  savedBlobs = [];
  window.URL.createObjectURL = ((blob: Blob | MediaSource) => {
    savedBlobs.push(blob);
    return 'blob:test/1';
  }) as typeof window.URL.createObjectURL;
  window.URL.revokeObjectURL = (() => {}) as typeof window.URL.revokeObjectURL;
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function click(this: HTMLAnchorElement) { clickedLinks.push(this); },
  );
});

afterEach(() => {
  clickSpy.mockRestore();
  locks.restore();
  api.restore();
  xhr.restore();
});

describe('the scope on the wire', () => {
  const EMPTY_LISTING = { prefix: '', count: 0, files: [] };

  // For the firm General Files the absence IS the instruction: the server reads
  // "no scope" as General Files, and a stray `matterId=undefined` would address
  // a matter of that name. A matter-linked task files its documents under the
  // matter's prefix, so matter+task is a filter over the matter rather than a
  // different location; dropping the matter id would look in the
  // standalone-task area, which is empty for this task.
  it.each([
    { area: 'the firm General Files', scope: FIRM_SCOPE, matterId: null, taskId: null, clientId: null },
    { area: 'a matter', scope: matterScope(MATTER_ID), matterId: MATTER_ID, taskId: null, clientId: null },
    {
      area: 'a matter narrowed to one of its tasks',
      scope: matterScope(MATTER_ID, TASK_ID),
      matterId: MATTER_ID,
      taskId: TASK_ID,
      clientId: null,
    },
    { area: 'a standalone task', scope: taskScope(TASK_ID), matterId: null, taskId: TASK_ID, clientId: null },
    { area: 'a client file area', scope: clientScope(CLIENT_ID), matterId: null, taskId: null, clientId: CLIENT_ID },
  ])('sends exactly the scope ids for $area', async ({ scope, ...expected }) => {
    api.get('/files/list-folder', EMPTY_LISTING);

    await filesService.listFolder(LAW_FIRM_ID, scope);

    const url = api.calls('GET')[0].url;
    const params = paramsOf(url);
    for (const key of ['matterId', 'taskId', 'clientId'] as const) {
      if (expected[key] === null) {
        expect(url).not.toContain(key);
      } else {
        expect(params.get(key)).toBe(expected[key]);
      }
    }
  });

  it('puts the firm in the PATH and repeats it in the body, agreeing', async () => {
    api.post('/files/create-folder', { message: 'Created' });

    await filesService.createFolder(LAW_FIRM_ID, matterScope(MATTER_ID), { folderName: 'Discovery' });

    // Unlike `matters.service`, this service sends the firm twice. Two sources
    // for one fact can disagree, and the body copy is the one a caller could
    // pass wrongly, so the invariant worth pinning is that they match.
    const call = api.calls('POST')[0];
    const body = call.body as Record<string, unknown>;
    expect(call.pathname).toContain(`/lawfirms/${LAW_FIRM_ID}/files/`);
    expect(body.lawFirmId).toBe(LAW_FIRM_ID);
    expect(body.matterId).toBe(MATTER_ID);
  });

  it('CHARACTERISATION: builds a request even with NO firm id', async () => {
    api.get('/files/list', { prefix: '', count: 0, files: [] });

    await filesService.listLawFirmFiles(undefined as unknown as string);

    // There is no guard here, unlike `matters.service.createMatter`, which
    // refuses before building a url. The request goes out against the literal
    // path segment "undefined" and returns a 404 the user reads as their files
    // having disappeared.
    expect(api.calls('GET')[0].pathname).toContain('/lawfirms/undefined/files/list');
  });
});

describe('listing and searching', () => {
  const EMPTY_LISTING = { prefix: '', count: 0, files: [] };

  it('lists one matter by query parameter, encoded', async () => {
    api.get('/files/list', EMPTY_LISTING);

    await filesService.listMatterFiles(LAW_FIRM_ID, 'matter/9');

    // An unencoded slash would split into extra path segments on a route that
    // takes the matter as a query value.
    expect(paramsOf(api.calls('GET')[0].url).get('matterId')).toBe('matter/9');
  });

  it('asks about several matters in one request, sending each id once', async () => {
    api.get('/files/list-matters', {
      filesByMatterId: { 'matter-a': { files: [{ name: 'a.pdf' }], truncated: false } },
    });

    const pages = await filesService.listMatterFilesBatch(
      LAW_FIRM_ID,
      ['matter-a', 'matter-b', 'matter-a', '', undefined as unknown as string],
    );

    expect(api.calls('GET')).toHaveLength(1);
    // A repeat and a blank both count against the server's cap of 100 without
    // adding a matter to the answer, so a caller holding a list with either in
    // it would chunk earlier than it needs to.
    expect(paramsOf(api.calls('GET')[0].url).get('matterIds')).toBe('matter-a,matter-b');
    expect(pages['matter-a'].files.map((f) => f.name)).toEqual(['a.pdf']);
    // A matter the caller cannot read is absent rather than empty, which is the
    // batch equivalent of the 403 the single listing answers.
    expect(pages['matter-b']).toBeUndefined();
  });

  it("asks for a client's task folders by client id, under the firm", async () => {
    api.get('/files/list-client-tasks', {
      tasks: [{ id: 'task-1', title: 'Intake', fileCount: 2 }],
    });

    const tasks = await filesService.listClientTaskFiles(LAW_FIRM_ID, 'client-7');

    const { url } = api.calls('GET')[0];
    expect(new URL(url).pathname).toBe(`/api/lawfirms/${LAW_FIRM_ID}/files/list-client-tasks`);
    expect(paramsOf(url).get('clientId')).toBe('client-7');
    expect(tasks).toEqual([{ id: 'task-1', title: 'Intake', fileCount: 2 }]);
  });

  it('asks nothing at all when there are no matters to ask about', async () => {
    api.get('/files/list-matters', { filesByMatterId: {} });

    expect(await filesService.listMatterFilesBatch(LAW_FIRM_ID, [])).toEqual({});

    // An empty `matterIds` is a 400 from the route, and there is nothing to
    // learn from it anyway.
    expect(api.calls('GET')).toHaveLength(0);
  });

  it('lists the firm General Files with no matter at all', async () => {
    api.get('/files/list', EMPTY_LISTING);

    await filesService.listLawFirmFiles(LAW_FIRM_ID);

    // Same endpoint as the matter listing, distinguished only by the absence of
    // the parameter. Leaking a matter id here shows a matter's documents on the
    // firm-wide screen.
    expect(api.calls('GET')[0].url).not.toContain('matterId');
  });

  it('carries the truncated flag on a listing', async () => {
    api.get('/files/list-folder', { prefix: '', count: 1, files: [{ name: 'a.pdf' }], truncated: true });

    const listing = await filesService.listFolder(LAW_FIRM_ID, matterScope(MATTER_ID));

    // Without it a short list is indistinguishable from a complete one, and the
    // reader concludes a document was never uploaded.
    expect(listing.truncated).toBe(true);
  });

  it('carries inheritedClientVisible so a folder listing can warn', async () => {
    api.get('/files/list-folder', { prefix: '', count: 0, files: [], inheritedClientVisible: true });

    const listing = await filesService.listFolder(LAW_FIRM_ID, matterScope(MATTER_ID), FOLDER_ID);

    // Every file dropped into this folder becomes client-visible by
    // inheritance. Losing the flag removes the only warning before that happens.
    expect(listing.inheritedClientVisible).toBe(true);
    expect(paramsOf(api.calls('GET')[0].url).get('folderId')).toBe(FOLDER_ID);
  });

  it('omits the folder id at the root of a scope', async () => {
    api.get('/files/list-folder', EMPTY_LISTING);

    await filesService.listFolder(LAW_FIRM_ID, matterScope(MATTER_ID));

    // `folderId=undefined` would address a folder of that name and list
    // nothing, which reads as an empty matter.
    expect(api.calls('GET')[0].url).not.toContain('folderId');
  });

  it('THROWS a refused listing rather than returning no files', async () => {
    api.get('/files/list-folder', { status: 403, body: { error: 'You do not have access to this matter' } });

    // An empty file list is what a matter with no documents looks like. It must
    // not also be what a refusal looks like.
    await expect(filesService.listFolder(LAW_FIRM_ID, matterScope(MATTER_ID)))
      .rejects.toThrow(/do not have access/i);
  });

  it('sends a search phrase with its spaces intact', async () => {
    api.get('/files/search', EMPTY_LISTING);

    await filesService.search(LAW_FIRM_ID, matterScope(MATTER_ID), 'settlement agreement');

    // Read back through URLSearchParams: a query string encodes a space as `+`,
    // which decodeURIComponent leaves alone, so that check would fail on a
    // perfectly correct url.
    expect(paramsOf(api.calls('GET')[0].url).get('query')).toBe('settlement agreement');
  });

  it('searches WITHIN the scope it was given', async () => {
    api.get('/files/search', EMPTY_LISTING);

    await filesService.search(LAW_FIRM_ID, taskScope(TASK_ID), 'nda');

    // The scope matters as much as the query. Without it the server searches the
    // firm's General Files, so a search run from a task's file view answers
    // about entirely different documents and reports "no results" for a file
    // that is plainly there.
    expect(paramsOf(api.calls('GET')[0].url).get('taskId')).toBe(TASK_ID);
  });

  it('CHARACTERISATION: drops an empty search query', async () => {
    api.get('/files/search', EMPTY_LISTING);

    await filesService.search(LAW_FIRM_ID, matterScope(MATTER_ID), '');

    // The url builder skips falsy values, so an empty box sends no `query` at
    // all rather than an explicit empty one, and the route answers on its own
    // terms instead of being told to match nothing.
    expect(api.calls('GET')[0].url).not.toContain('query');
  });
});

describe('sharing a file with the client portal', () => {
  const OK = { message: 'Updated', fileId: FILE_ID, clientVisible: true };

  /** The batched route's own envelope, built from the ids it could not apply. */
  const bulkOk = (call: RecordedCall, doomed: string[] = []) => {
    const { fileIds, clientVisible } = call.body as { fileIds: string[]; clientVisible: boolean };
    const failed = fileIds.filter((id) => doomed.includes(id));
    return {
      message: 'Bulk visibility update completed',
      requested: fileIds.length,
      updated: fileIds.length - failed.length,
      failed,
      errors: Object.fromEntries(failed.map((id) => [id, 'File not found'])),
      clientVisible,
    };
  };

  it('PATCHes the visibility route with the file and the scope', async () => {
    api.patch('/files/client-visibility', OK);

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: true,
    });

    const call = api.calls('PATCH')[0];
    const body = call.body as Record<string, unknown>;
    expect(call.pathname).toMatch(/\/files\/client-visibility$/);
    expect(body.fileId).toBe(FILE_ID);
    expect(body.matterId).toBe(MATTER_ID);
    expect(body.clientVisible).toBe(true);
  });

  it('sends an explicit FALSE when un-sharing', async () => {
    api.patch('/files/client-visibility', { ...OK, clientVisible: false });

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: false,
    });

    // The one value in this service that must survive as a literal `false`. A
    // body builder that skipped falsy fields would send nothing to change, the
    // server would answer 200, the row would flip in the UI, and the document
    // would still be readable in the client's portal.
    expect((api.calls('PATCH')[0].body as Record<string, unknown>).clientVisible).toBe(false);
  });

  it('OMITS visibleClientIds when sharing with everyone on the scope', async () => {
    api.patch('/files/client-visibility', OK);

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: true,
    });

    // Absent means "every client on the matter, including ones added later".
    // That is a different instruction from any list, so the key must not appear
    // at all.
    expect(api.calls('PATCH')[0].body as Record<string, unknown>)
      .not.toHaveProperty('visibleClientIds');
  });

  it('sends the exact audience when the share is restricted', async () => {
    api.patch('/files/client-visibility', OK);

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: true,
      visibleClientIds: ['client-a'],
    });

    // On a multi-client matter this list is the only thing keeping one client's
    // document away from the other clients on the same matter. A one-element
    // list unwrapped into a bare string would change the request shape for the
    // most common restricted share.
    expect((api.calls('PATCH')[0].body as Record<string, unknown>).visibleClientIds)
      .toEqual(['client-a']);
  });

  it('sends an EMPTY audience as an empty array', async () => {
    api.patch('/files/client-visibility', OK);

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: true,
      visibleClientIds: [],
    });

    // Distinct from omitting the field: an empty list names no client, where
    // absence names all of them. Collapsing the two turns "share with nobody in
    // particular yet" into "share with the whole matter".
    expect((api.calls('PATCH')[0].body as Record<string, unknown>).visibleClientIds)
      .toEqual([]);
  });

  it('forwards a suppressed notification', async () => {
    api.patch('/files/client-visibility', OK);

    await filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: taskScope(TASK_ID),
      fileId: FILE_ID,
      clientVisible: true,
      notifyClient: false,
    });

    // Defaults to true server-side, so a dropped `false` emails the client about
    // a document the firm meant to share quietly.
    const body = api.calls('PATCH')[0].body as Record<string, unknown>;
    expect(body.notifyClient).toBe(false);
    expect(body.taskId).toBe(TASK_ID);
  });

  it('throws when the share is refused', async () => {
    api.patch('/files/client-visibility', {
      status: 403, body: { error: 'This matter is under legal hold' },
    });

    // A swallowed refusal leaves the toggle looking switched, so the firm
    // believes a client can see a document they cannot, or vice versa.
    await expect(filesService.setClientVisibility({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileId: FILE_ID,
      clientVisible: true,
    })).rejects.toThrow(/legal hold/i);
  });

  it('sends a whole selection to the BULK route as one request', async () => {
    const ids = ['file-a', 'file-b', 'file-c'];
    api.patch('/files/bulk-client-visibility', (call) => bulkOk(call));

    const result = await filesService.setClientVisibilityBulk({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileIds: ids,
      clientVisible: true,
    });

    // One request for the set is the entire reason this method exists: the
    // single-file route took a selection one round trip at a time.
    expect(api.calls('PATCH')).toHaveLength(1);
    const body = api.calls('PATCH')[0].body as Record<string, unknown>;
    expect(body.fileIds).toEqual(ids);
    expect(body.matterId).toBe(MATTER_ID);
    expect(result).toMatchObject({ requested: 3, updated: 3, failed: [] });
  });

  it('merges the per-file outcomes the route reports instead of treating 200 as success', async () => {
    api.patch('/files/bulk-client-visibility', (call) => bulkOk(call, ['file-b']));

    const result = await filesService.setClientVisibilityBulk({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileIds: ['file-a', 'file-b'],
      clientVisible: true,
    });

    // The route applies what it can, so a 200 carrying failures has to reach the
    // caller: swallowing it would leave a row saying "shared" about a file that
    // is not.
    expect(result.failed).toEqual(['file-b']);
    expect(result.errors['file-b']).toBe('File not found');
    expect(result.updated).toBe(1);
  });

  it('chunks a selection past the route cap rather than letting it 400', async () => {
    const ids = Array.from({ length: MAX_BULK_VISIBILITY_FILE_IDS + 5 }, (_, i) => `file-${i}`);
    api.patch('/files/bulk-client-visibility', (call) => bulkOk(call));

    const result = await filesService.setClientVisibilityBulk({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileIds: ids,
      clientVisible: true,
    });

    // Over the cap the route answers 400 and writes nothing, so a select-all
    // over a very large folder has to be split here. Every id still goes, and
    // the counts add up across the chunks.
    expect(api.calls('PATCH')).toHaveLength(2);
    const sent = api.calls('PATCH').flatMap((call) => (call.body as { fileIds: string[] }).fileIds);
    expect(sent).toEqual(ids);
    expect((api.calls('PATCH')[0].body as { fileIds: string[] }).fileIds)
      .toHaveLength(MAX_BULK_VISIBILITY_FILE_IDS);
    expect(result).toMatchObject({ requested: ids.length, updated: ids.length });
  });

  it('sends nothing at all for an empty selection', async () => {
    const result = await filesService.setClientVisibilityBulk({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileIds: [],
      clientVisible: true,
    });

    // `fileIds` has a `min(1)` on the server, so an empty selection would be a
    // 400 the user never asked for.
    expect(api.calls('PATCH')).toHaveLength(0);
    expect(result).toMatchObject({ requested: 0, updated: 0, failed: [] });
  });

  it('throws when the whole batch is refused', async () => {
    api.patch('/files/bulk-client-visibility', {
      status: 403, body: { error: 'This matter is under legal hold' },
    });

    // A thrown error means NOTHING was applied, which is what lets a caller
    // roll the whole optimistic selection back rather than part of it.
    await expect(filesService.setClientVisibilityBulk({
      lawFirmId: LAW_FIRM_ID,
      scope: matterScope(MATTER_ID),
      fileIds: ['file-a', 'file-b'],
      clientVisible: true,
    })).rejects.toThrow(/legal hold/i);
  });

  it('previews what a client can see through the client-scoped route', async () => {
    api.get('/portal-files', { documents: [{ id: 'd1' }], sharedFolders: [], truncated: true });

    const result = await filesService.listClientVisibleDocuments(LAW_FIRM_ID, 'client/7');

    // The firm reads this panel as an audit of the client's portal, which is the
    // worst place for a partial list to pass as a complete one, and for an
    // unencoded client id to address a different route.
    expect(api.calls('GET')[0].pathname).toMatch(/\/clients\/client%2F7\/portal-files$/);
    expect(result.truncated).toBe(true);
    expect(result.documents).toHaveLength(1);
  });

  it('throws when the portal preview is refused', async () => {
    api.get('/portal-files', { status: 403, body: { error: 'Forbidden' } });

    await expect(filesService.listClientVisibleDocuments(LAW_FIRM_ID, CLIENT_ID))
      .rejects.toBeDefined();
  });
});

describe('creating, renaming, moving and deleting', () => {
  it('creates a folder with its parent and colour', async () => {
    api.post('/files/create-folder', { message: 'Created' });

    await filesService.createFolder(LAW_FIRM_ID, matterScope(MATTER_ID), {
      folderName: 'Discovery', parentId: FOLDER_ID, folderColor: 'blue',
    });

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.folderName).toBe('Discovery');
    expect(body.parentId).toBe(FOLDER_ID);
    expect(body.folderColor).toBe('blue');
  });

  it('renames the row it names, not a path it builds', async () => {
    api.post('/files/rename', { message: 'Renamed' });

    await filesService.rename(LAW_FIRM_ID, matterScope(MATTER_ID), FILE_ID, 'final.pdf');

    // An id and a name, so there is nothing to get the wrong way round. It used
    // to send an old path and a new one, two same-typed arguments the server
    // could not tell apart: swapping them renamed the file back to the name the
    // user was trying to leave behind, and reported success.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.fileId).toBe(FILE_ID);
    expect(body.newName).toBe('final.pdf');
  });

  it('moves an item into a folder', async () => {
    api.post('/files/move', { message: 'Moved' });

    await filesService.move(LAW_FIRM_ID, matterScope(MATTER_ID), {
      fileId: FILE_ID, destinationFolderId: FOLDER_ID,
    });

    // Two ids and nothing else. A move used to send a source path, a
    // destination path and an optional object path, because the address of a
    // row depended on where the browser was standing when the user clicked.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.fileId).toBe(FILE_ID);
    expect(body.destinationFolderId).toBe(FOLDER_ID);
  });

  it('omits the destination folder when moving to the scope root', async () => {
    api.post('/files/move', { message: 'Moved' });

    await filesService.move(LAW_FIRM_ID, matterScope(MATTER_ID), {
      fileId: FILE_ID, destinationFolderId: null,
    });

    // Sending it as null would name a folder whose id is the literal "null".
    // Leaving it out is what the server reads as "the scope's own root".
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('destinationFolderId');
  });

  it('sets a folder colour on its own endpoint', async () => {
    api.post('/files/update-folder-color', { message: 'Updated' });

    await filesService.updateFolderColor(LAW_FIRM_ID, matterScope(MATTER_ID), FOLDER_ID, 'blue');

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/files\/update-folder-color$/);
    expect((call.body as Record<string, unknown>).folderId).toBe(FOLDER_ID);
    expect((call.body as Record<string, unknown>).folderColor).toBe('blue');
  });

  it('DELETEs one row by its id, in its scope', async () => {
    api.delete('/files/delete', { message: 'Deleted' });

    await filesService.deleteItem(LAW_FIRM_ID, matterScope(MATTER_ID), FOLDER_ID);

    // One address. It used to carry two, a relative name and an object path,
    // because neither was sufficient on its own: the name depended on the
    // folder on screen and a search hit was not in it.
    const params = paramsOf(api.calls('DELETE')[0].url);
    expect(params.get('fileId')).toBe(FOLDER_ID);
    expect(params.get('matterId')).toBe(MATTER_ID);
    expect(params.get('fileName')).toBeNull();
  });

  it('throws when a delete is refused', async () => {
    api.delete('/files/delete', { status: 403, body: { error: 'This file is under legal hold' } });

    // The row must not disappear from the screen and return on the next load.
    await expect(filesService.deleteItem(LAW_FIRM_ID, matterScope(MATTER_ID), 'draft.pdf'))
      .rejects.toThrow(/legal hold/i);
  });
});

describe('signed urls', () => {
  it('uses the url a listing already carried, with NO request', async () => {
    const url = await filesService.ensureSignedUrl(LAW_FIRM_ID, {
      signedUrl: 'https://signed/existing', id: FILE_ID,
    });

    // Surfaces that receive a url from elsewhere (message attachments, the
    // portal document feed) pass through untouched. Re-minting one on every open
    // is a round trip per click for no gain.
    expect(url).toBe('https://signed/existing');
    expect(api.calls()).toHaveLength(0);
  });

  it('mints one when the listing carried none', async () => {
    api.get('/files/refresh-url', { signedUrl: 'https://signed/fresh' });

    const url = await filesService.ensureSignedUrl(LAW_FIRM_ID, { signedUrl: '', id: FILE_ID });

    // Directory listings return an empty `signedUrl` on purpose: a url minted at
    // list time is already partway through its TTL by the time a row is clicked.
    expect(url).toBe('https://signed/fresh');
  });

  it('refuses to build a request for a file with no record', async () => {
    await expect(filesService.ensureSignedUrl(LAW_FIRM_ID, { signedUrl: '', id: '' }))
      .rejects.toThrow(/no record/i);

    // Refused BEFORE any request. Without the guard the url would carry
    // `fileId=`, and the server would be asked to sign nothing at all.
    expect(api.calls()).toHaveLength(0);
  });

  it('sends the firm in the path AND the query when refreshing', async () => {
    api.get('/files/refresh-url', { signedUrl: 'https://signed/fresh' });

    await filesService.refreshSignedUrl(LAW_FIRM_ID, FILE_ID);

    // The second of the two places this service duplicates the firm id. They
    // have to agree, because the route reads one of them to authorise and the
    // other to locate.
    const call = api.calls('GET')[0];
    expect(call.pathname).toContain(`/lawfirms/${LAW_FIRM_ID}/files/refresh-url`);
    expect(paramsOf(call.url).get('lawFirmId')).toBe(LAW_FIRM_ID);
    expect(paramsOf(call.url).get('fileId')).toBe(FILE_ID);
  });

  it('adds matterId only when the caller supplies one', async () => {
    api.get('/files/refresh-url', { signedUrl: 'https://signed/fresh' });

    await filesService.refreshSignedUrl(LAW_FIRM_ID, FILE_ID, MATTER_ID);
    __resetDuplicateRequestGuard();
    await filesService.refreshSignedUrl(LAW_FIRM_ID, FILE_ID);

    expect(paramsOf(api.calls('GET')[0].url).get('matterId')).toBe(MATTER_ID);
    expect(api.calls('GET')[1].url).not.toContain('matterId');
  });

  it('throws when the file can no longer be signed', async () => {
    api.get('/files/refresh-url', { status: 404, body: { error: 'File not found' } });

    // Returning an empty string here would put an anchor with an empty href on
    // screen, which navigates to the current page and looks like nothing
    // happened.
    await expect(filesService.refreshSignedUrl(LAW_FIRM_ID, FILE_ID))
      .rejects.toThrow(/not found/i);
  });
});

describe('the resumable upload', () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    // The row `upload-init` claimed. Finalize names it; the browser never
    // builds a storage path of its own and cannot claim one it was not handed.
    fileId: FILE_ID,
    name: 'a.pdf',
    objectPath: OBJECT_PATH,
    uploadUrl: 'https://storage.googleapis.com/upload/session-1',
    contentType: 'application/pdf',
    declaredSize: 4,
    ...overrides,
  });

  /** What finalize answers for a file it stamped: the row, named by id. */
  const landed = (overrides: Record<string, unknown> = {}) => ({
    fileId: FILE_ID,
    objectPath: OBJECT_PATH,
    ...overrides,
  });

  // A cancel releases what the batch opened without the caller waiting on it,
  // so that request can still be on its way when the rejection reaches a spec.
  // Answered by default, and given a moment to land in this spec's fake rather
  // than the next one's. A spec about the release registers its own.
  beforeEach(() => {
    api.post('/files/upload-cancel', { cancelled: 0 });
  });
  afterEach(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it('makes NO request at all for an empty selection', async () => {
    const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), []);

    // Refused before building anything. An init call with zero files still
    // reserves quota and opens a session the finalize step would then have to
    // reconcile.
    expect(api.calls()).toHaveLength(0);
    expect(xhr.calls()).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it('declares each file name, size and content type up front', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [{ objectPath: session().objectPath }] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);

    // The init call is where quota is reserved and the plan's max file size is
    // enforced, so an understated size buys storage the firm has not paid for.
    const declared = (api.calls('POST')[0].body as { files: Array<Record<string, unknown>> }).files;
    expect(declared).toEqual([{ name: 'a.pdf', size: 4, contentType: 'application/pdf' }]);
  });

  it('defaults a typeless file to application/octet-stream', async () => {
    api.post('/files/upload-init', { uploads: [session({ contentType: 'application/octet-stream' })] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.bin', '')]);

    // An empty content type on a GCS resumable session is rejected outright, so
    // the fallback is what lets an extensionless file upload at all.
    const declared = (api.calls('POST')[0].body as { files: Array<Record<string, unknown>> }).files;
    expect(declared[0].contentType).toBe('application/octet-stream');
  });

  it('PUTs the bytes to the session url with NO credential', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);

    // The session url is already authorised: it was signed server-side. Adding
    // an Authorization header both breaks the signature and hands the firm's
    // Firebase credential to a third-party host.
    const [put] = xhr.calls('PUT');
    expect(put.url).toBe('https://storage.googleapis.com/upload/session-1');
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers['content-type']).toBe('application/pdf');
  });

  it('finalizes with the SERVER session descriptors', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [{ objectPath: session().objectPath }] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);

    // Finalize is where quota is reconciled and the file records are written, so
    // it has to echo what the server itself minted rather than anything measured
    // locally after the fact.
    const body = api.calls('POST')[1].body as { uploads: Array<Record<string, unknown>> };
    expect(body.uploads).toEqual([{
      fileId: FILE_ID,
      declaredSize: 4,
      contentType: 'application/pdf',
    }]);
  });

  it('holds progress below 100 until the upload is finalized', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { progress: [{ loaded: 2, total: 4 }], status: 200 });
    const seen: number[] = [];

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')], (p) => seen.push(p));

    // The bytes reaching GCS are not the end of the work: finalize still has to
    // verify the object and write the records. A bar that hit 100 at the last
    // byte would invite the user to navigate away mid-finalize.
    expect(seen).toEqual([50, 99, 100]);
  });

  it('aggregates progress across several files by bytes', async () => {
    api.post('/files/upload-init', {
      uploads: [
        session(),
        session({
          fileId: '8d4f2a10-0000-4000-8000-000000000002',
          name: 'b.pdf',
          objectPath: 'lawfirmids/firm-1/objects/8d4f2a10-0000-4000-8000-000000000002',
          uploadUrl: 'https://storage.googleapis.com/upload/session-2',
        }),
      ],
    });
    api.post('/files/upload-finalize', { files: [landed(), landed({ fileId: '8d4f2a10-0000-4000-8000-000000000002' })] });
    xhr.on('PUT', 'session-1', { status: 200 });
    xhr.on('PUT', 'session-2', { status: 200 });
    const seen: number[] = [];

    await filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID),
      // Four bytes and twelve bytes, so the two weightings give different
      // answers for the same moment.
      [fileNamed('a.pdf', 'application/pdf', 'abcd'), fileNamed('b.pdf', 'application/pdf', 'x'.repeat(12))],
      (p) => seen.push(p),
    );

    // Percentage of TOTAL BYTES, not of files finished. The small file lands
    // first and moves the bar a quarter of the way; averaging per file would
    // report half, which is how a 2 MB and a 2 GB upload end up sharing a bar
    // that sits at 50% for the rest of the transfer.
    expect(seen[0]).toBe(25);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('skips a file the server opened no session for', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [{ objectPath: session().objectPath }] });
    xhr.on('PUT', 'session-1', { status: 200 });

    const result = await filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
    );

    // The server may open fewer sessions than were asked for (quota, per-file
    // refusal). Indexing past the end and PUTting to `undefined` would take the
    // whole batch down with the one file that was refused.
    expect(xhr.calls('PUT')).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('uploads a matter-linked task INTO the task', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID, TASK_ID), [fileNamed('a.pdf')]);

    // The one place a task outranks the matter it belongs to: listing shows the
    // matter, uploading targets the task, so the stored object carries the task
    // id and lands in the task's view rather than loose in the matter's.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.context).toBe('task');
    expect(body.matterId).toBe(MATTER_ID);
    expect(body.taskId).toBe(TASK_ID);
  });

  it('names the firm General Files context "lawfirm"', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, FIRM_SCOPE, [fileNamed('a.pdf')]);

    // The endpoint's own name for the scope, which is not the same word the
    // scope union uses. A mismatch stores the file under a prefix nothing lists.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.context).toBe('lawfirm');
    expect(body).not.toHaveProperty('matterId');
  });

  it('forwards the destination folder to init', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(
      LAW_FIRM_ID, clientScope(CLIENT_ID), [fileNamed('a.pdf')], undefined, FOLDER_ID,
    );

    // The folder is chosen in the UI before the picker opens. Losing it puts
    // every upload at the root of the scope, where a client-visible folder's
    // inherited sharing would not apply to it.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.folderId).toBe(FOLDER_ID);
    expect(body.clientId).toBe(CLIENT_ID);
  });

  it('rejects with the expiry message when the session url has gone stale', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    // Finalize runs even when nothing landed: it is the only thing that gives
    // back the quota init reserved, and an empty `files` list is what makes
    // this a total failure rather than a partial one.
    api.post('/files/upload-finalize', { files: [] });
    xhr.on('PUT', 'session-1', { status: 403 });

    // A resumable session has a lifetime of its own. A 403 or 400 from GCS means
    // the link died mid-transfer, which the user fixes by retrying, so the copy
    // has to say so rather than blaming the file.
    await expect(filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]))
      .rejects.toThrow(/upload link expired/i);
  });

  it('rejects with a storage message once every retry of a 5xx is spent', async () => {
    jest.useFakeTimers();
    try {
      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [] });
      xhr.on('PUT', 'session-1', { status: 500 });

      // The negative half: a 500 is not an expired link, and telling the user to
      // retry a link that is fine sends them round a loop. It IS retried first,
      // because a 500 from storage is usually a blip, and the message arrives
      // only when the whole backoff schedule is exhausted.
      await expect(settleUnderFakeTimers(
        filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]),
      )).rejects.toThrow(/could not be uploaded to storage/i);

      // Attempts plus the status query after each failed one: more than a
      // single shot went out.
      expect(xhr.calls('PUT').length).toBeGreaterThan(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces a refused init instead of uploading anything', async () => {
    api.post('/files/upload-init', {
      status: 402, body: { error: 'Your firm has used all of its storage.' },
    });

    await expect(filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]))
      .rejects.toThrow(/used all of its storage/i);

    // Nothing may reach GCS once quota was refused, or the bytes land in a
    // bucket with no record and no reservation behind them.
    expect(xhr.calls('PUT')).toHaveLength(0);
  });

  it('labels the chunk with its byte range so GCS can assemble it', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);

    // Without Content-Range a resumable session treats the PUT as the whole
    // object. That works until the first file larger than one chunk.
    const [put] = xhr.calls('PUT');
    expect(put.headers['content-range']).toBe('bytes 0-3/4');
    expect((put.body as Blob).size).toBe(4);
  });

  it('remembers the session while the bytes are in flight', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed()] });
    // ONE File instance for both the upload and the lookup. The store keys on
    // name + size + lastModified, and `new File()` defaults lastModified to the
    // moment it was constructed, so two `fileNamed('a.pdf')` calls a millisecond
    // apart are two different files as far as the store is concerned. A real
    // picked file carries its own mtime and has no such problem.
    const file = fileNamed('a.pdf');
    const picked = await identity(file);
    let duringUpload: unknown = null;
    xhr.on('PUT', 'session-1', () => {
      duringUpload = loadUploadSession(matterDestination(), picked);
      return { status: 200 };
    });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

    // Saved BEFORE the first byte goes out, or a reload during the transfer
    // finds nothing to resume.
    expect(duringUpload).toMatchObject({ fileId: FILE_ID, uploadUrl: session().uploadUrl });
  });

  it('forgets the session once finalize has run', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    // Finalize must NAME the file it finalized. An empty list means nothing
    // finalized, and a descriptor for an unfinalized file is deliberately kept
    // so the upload can be retried rather than restarted.
    api.post('/files/upload-finalize', { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] });
    xhr.on('PUT', 'session-1', { status: 200 });
    const file = fileNamed('a.pdf');

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

    // A finalized row cannot be resumed into. Keeping the descriptor would make
    // the NEXT upload of this file skip init and PUT into a finished object.
    expect(loadUploadSession(matterDestination(), await identity(file))).toBeNull();
  });

  it('rethrows a cancellation as UploadCancelledError and does not finalize', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [] });
    const controller = new AbortController();
    const file = fileNamed('a.pdf');
    // The user cancels while the bytes are on the wire, which is the only time
    // a cancel can happen.
    xhr.on('PUT', 'session-1', () => {
      controller.abort();
      return { aborted: true };
    });

    await expect(filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [file], undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // The PUT did go out, so this is the cancel path and not an earlier refusal.
    expect(xhr.calls('PUT').length).toBeGreaterThan(0);
    // Finalize after a cancel settles a row whose object never landed and reports
    // the cancel back as a storage failure.
    expect(api.callsTo('/files/upload-finalize')).toHaveLength(0);
    // The cancel deletes the row the session names, so the descriptor goes too:
    // resuming into it would send bytes for a row that no longer exists.
    expect(loadUploadSession(matterDestination(), await identity(file))).toBeNull();
  });

  it('echoes the reservation init handed out for each file at finalize', async () => {
    api.post('/files/upload-init', { uploads: [session({ reservationId: 'res-1' })] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);

    // Finalize deletes the reservations the body names. One left out stays
    // live for two hours while the same bytes are also counted as saved, so
    // the firm is charged twice for the file until it lapses.
    const body = api.callsTo('/files/upload-finalize')[0].body as { uploads: Array<Record<string, unknown>> };
    expect(body.uploads.map((u) => u.reservationId)).toEqual(['res-1']);
  });

  it('releases the session at once on a cancel, naming the row and its reservation', async () => {
    api.post('/files/upload-init', { uploads: [session({ reservationId: 'res-1' })] });
    api.post('/files/upload-finalize', { files: [] });
    const controller = new AbortController();
    xhr.on('PUT', 'session-1', () => {
      controller.abort();
      return { aborted: true };
    });

    await expect(filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')], undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // Red without the release: the quota init reserved stays held for two
    // hours and the claimed name makes the next upload "a (1).pdf". The scope
    // travels too, since the route authorizes the rows against it.
    await waitFor(() => api.callsTo('/files/upload-cancel').length > 0);
    const [release] = api.callsTo('/files/upload-cancel');
    expect(release.body).toEqual({
      lawFirmId: LAW_FIRM_ID,
      context: 'matter',
      matterId: MATTER_ID,
      uploads: [{ fileId: FILE_ID, reservationId: 'res-1' }],
    });
  });

  it('does not hold the cancel back for the release, and never reports a refused one', async () => {
    api.post('/files/upload-init', { uploads: [session({ reservationId: 'res-1' })] });
    let answerRelease!: (response: unknown) => void;
    api.post('/files/upload-cancel', () => new Promise((resolve) => { answerRelease = resolve; }));
    const controller = new AbortController();
    xhr.on('PUT', 'session-1', () => {
      controller.abort();
      return { aborted: true };
    });

    const pending = filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')], undefined, undefined, controller.signal,
    );
    const outcome = await Promise.race([
      pending.then(() => 'resolved', (err) => err),
      new Promise((resolve) => setTimeout(() => resolve('waiting on the release'), 200)),
    ]);

    // Red if the rejection waits for the release to answer: the cancel control
    // would sit there for a request the user has no reason to wait on.
    expect(outcome).toMatchObject({ name: 'UploadCancelledError' });
    await waitFor(() => api.callsTo('/files/upload-cancel').length > 0);
    // Red if a refused release surfaced: the caller already heard the cancel,
    // and an unhandled rejection here is an error in the console for nothing.
    answerRelease({ status: 500, body: { error: 'Internal error' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(api.callsTo('/files/upload-cancel')).toHaveLength(1);
  });

  it('releases nothing once the upload has been filed', async () => {
    api.post('/files/upload-init', { uploads: [session({ reservationId: 'res-1' })] });
    api.post('/files/upload-finalize', { files: [landed()] });
    xhr.on('PUT', 'session-1', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Finalize already gave the reservation back. A release after it is a
    // request for nothing, and the route guards the filed row, not the client.
    expect(api.callsTo('/files/upload-cancel')).toHaveLength(0);
  });

  it('says the upload can no longer be stopped only once every byte has landed', async () => {
    const events: string[] = [];
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', () => {
      events.push('finalize');
      return { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] };
    });
    xhr.on('PUT', 'session-1', () => {
      events.push('put');
      return { status: 200 };
    });

    await filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')],
      undefined, undefined, undefined, () => events.push('finalizing'),
    );

    // Finalize files the document whatever the signal says, so a cancel shown
    // during it is a control that does nothing. Said too early, the user loses
    // the cancel while bytes are still moving; said late, not at all.
    expect(events).toEqual(['put', 'finalizing', 'finalize']);
  });

  it('never says a cancelled upload is finalizing', async () => {
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [] });
    const controller = new AbortController();
    const onFinalizing = jest.fn();
    xhr.on('PUT', 'session-1', () => {
      controller.abort();
      return { aborted: true };
    });

    await expect(filesService.upload(
      LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')],
      undefined, undefined, controller.signal, onFinalizing,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    expect(xhr.calls('PUT').length).toBeGreaterThan(0);
    expect(onFinalizing).not.toHaveBeenCalled();
  });

  it('resumes a remembered session without opening a new one', async () => {
    const file = fileNamed('a.pdf');
    saveUploadSession(matterDestination(), await identity(file), session());
    api.post('/files/upload-finalize', { files: [{ objectPath: session().objectPath }] });
    // GCS has bytes 0-1 of 4; the client must send 2-3 and nothing else.
    xhr.on('PUT', 'session-1', (call) => (
      call.headers['content-range'] === 'bytes */4'
        ? { status: 308, headers: { Range: 'bytes=0-1' } }
        : { status: 200 }
    ));

    const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

    // No init: a second session would reserve the quota twice and claim the
    // name a second time as "a (1).pdf".
    expect(api.callsTo('/files/upload-init')).toHaveLength(0);
    const data = chunkPuts(xhr.calls());
    expect(data).toHaveLength(1);
    expect(data[0].headers['content-range']).toBe('bytes 2-3/4');
    expect((data[0].body as Blob).size).toBe(2);
    // Finalize names the remembered row.
    const body = api.callsTo('/files/upload-finalize')[0].body as { uploads: Array<{ fileId: string }> };
    expect(body.uploads.map((u) => u.fileId)).toEqual([FILE_ID]);
    expect(result.count).toBe(1);
  });

  it('opens a new session when the remembered one is gone', async () => {
    const file = fileNamed('a.pdf');
    saveUploadSession(matterDestination(), await identity(file), session());
    api.post('/files/upload-init', {
      uploads: [session({ uploadUrl: 'https://storage.googleapis.com/upload/session-2' })],
    });
    api.post('/files/upload-finalize', { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] });
    xhr.on('PUT', 'session-1', { status: 404 });
    xhr.on('PUT', 'session-2', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

    // The dead session is dropped and replaced in ONE call, rather than
    // surfacing "link expired" and making the user pick the file again.
    expect(api.callsTo('/files/upload-init')).toHaveLength(1);
    expect(chunkPuts(xhr.calls()).map((c) => c.url)).toEqual(['https://storage.googleapis.com/upload/session-2']);
    expect(loadUploadSession(matterDestination(), await identity(file))).toBeNull();
  });

  it('mixes remembered and fresh files in one batch, in order', async () => {
    const a = fileNamed('a.pdf');
    const b = fileNamed('b.pdf');
    saveUploadSession(matterDestination(), await identity(b), session({
      fileId: '8d4f2a10-0000-4000-8000-000000000002',
      name: 'b.pdf',
      uploadUrl: 'https://storage.googleapis.com/upload/session-2',
    }));
    api.post('/files/upload-init', { uploads: [session()] });
    api.post('/files/upload-finalize', { files: [landed(), landed({ fileId: '8d4f2a10-0000-4000-8000-000000000002' })] });
    xhr.on('PUT', 'session-1', { status: 200 });
    xhr.on('PUT', 'session-2', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [a, b]);

    // Only `a` is declared to init; `b` already has a row. Finalize still lists
    // both, in the order the files were picked.
    const declared = (api.callsTo('/files/upload-init')[0].body as { files: Array<{ name: string }> }).files;
    expect(declared.map((f) => f.name)).toEqual(['a.pdf']);
    const finalized = api.callsTo('/files/upload-finalize')[0].body as { uploads: Array<{ fileId: string }> };
    expect(finalized.uploads.map((u) => u.fileId)).toEqual([FILE_ID, '8d4f2a10-0000-4000-8000-000000000002']);
  });

  it('KEEPS the descriptor of a file finalize reported as failed', async () => {
    const a = fileNamed('a.pdf');
    const b = fileNamed('b.pdf');
    const secondId = '8d4f2a10-0000-4000-8000-000000000002';
    api.post('/files/upload-init', {
      uploads: [
        session(),
        session({ fileId: secondId, name: 'b.pdf', uploadUrl: 'https://storage.googleapis.com/upload/session-2' }),
      ],
    });
    // Only the first file finalized; the second came back in `failures`.
    api.post('/files/upload-finalize', {
      files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
      failures: [{ objectPath: 'lawfirmids/firm-1/objects/x', error: 'Object was not uploaded' }],
    });
    xhr.on('PUT', 'session-1', { status: 200 });
    xhr.on('PUT', 'session-2', { status: 200 });

    await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [a, b]);

    // Clearing every descriptor threw away the resumable session of a file the
    // server merely failed transiently, turning a retry into a fresh upload
    // from byte zero. The one that finalized is forgotten; the one that did
    // not is kept so it can resume.
    expect(loadUploadSession(matterDestination(), await identity(a))).toBeNull();
    expect(loadUploadSession(matterDestination(), await identity(b))).toMatchObject({ fileId: secondId });
  });

  it('continues from the persisted offset after a transient failure', async () => {
    jest.useFakeTimers();
    try {
      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [landed()] });
      let dataPuts = 0;
      xhr.on('PUT', 'session-1', (call) => {
        if (call.headers['content-range'] === 'bytes */4') {
          return { status: 308, headers: { Range: 'bytes=0-1' } };
        }
        dataPuts += 1;
        return dataPuts === 1 ? { networkError: true } : { status: 200 };
      });

      await settleUnderFakeTimers(
        filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]),
      );

      // The second data PUT picks up at byte 2, which is the entire point of
      // the protocol: a 3 GB upload that drops at 2.9 GB sends 0.1 GB again.
      expect(chunkPuts(xhr.calls()).map((c) => c.headers['content-range'])).toEqual([
        'bytes 0-3/4',
        'bytes 2-3/4',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('the content fingerprint decides what "the same file" means', () => {
    /** Two files agreeing on name, size and mtime, differing only in content. */
    const twinOf = (body: string) =>
      new File([body], 'a.pdf', { type: 'application/pdf', lastModified: 1_700_000_000_000 });

    it('does NOT resume a session opened for different bytes', async () => {
      const first = twinOf('abcd');
      const second = twinOf('wxyz');
      saveUploadSession(matterDestination(), await identity(first), session());
      api.post('/files/upload-init', {
        uploads: [session({ uploadUrl: 'https://storage.googleapis.com/upload/session-2' })],
      });
      api.post('/files/upload-finalize', { files: [landed()] });
      xhr.on('PUT', 'session-2', { status: 200 });

      await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [second]);

      // Same name, same byte length, same last-modified, different document. On
      // metadata alone these are one file and the second resumes into the
      // first's session, producing one stored object with the front of one
      // document and the back of another at a size that looks correct.
      expect(api.callsTo('/files/upload-init')).toHaveLength(1);
      expect(chunkPuts(xhr.calls()).map((c) => c.url))
        .toEqual(['https://storage.googleapis.com/upload/session-2']);
    });

    it('resumes when the bytes are the same', async () => {
      const picked = twinOf('abcd');
      saveUploadSession(matterDestination(), await identity(twinOf('abcd')), session());
      api.post('/files/upload-finalize', { files: [landed()] });
      xhr.on('PUT', 'session-1', (call) => (
        call.headers['content-range'] === 'bytes */4'
          ? { status: 308, headers: { Range: 'bytes=0-1' } }
          : { status: 200 }
      ));

      await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [picked]);

      // The negative half. A fingerprint that failed to match itself would
      // disable resumption altogether while every other spec still passed.
      expect(api.callsTo('/files/upload-init')).toHaveLength(0);
      expect(chunkPuts(xhr.calls())[0].headers['content-range']).toBe('bytes 2-3/4');
    });
  });

  describe('two tabs with the same file picked', () => {
    it('opens an independent session rather than sharing the other tab\'s', async () => {
      const file = fileNamed('a.pdf');
      saveUploadSession(matterDestination(), await identity(file), session());
      locks.holdElsewhere();
      api.post('/files/upload-init', {
        uploads: [session({ uploadUrl: 'https://storage.googleapis.com/upload/session-2' })],
      });
      api.post('/files/upload-finalize', { files: [landed()] });
      xhr.on('PUT', 'session-2', { status: 200 });

      await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

      // Both tabs reading one descriptor PUT into ONE session from the same
      // offset. The bytes interleave and the object is corrupt, and neither tab
      // is told: both see 308s whose Range keeps advancing, because it does,
      // just not only because of them.
      expect(api.callsTo('/files/upload-init')).toHaveLength(1);
      expect(chunkPuts(xhr.calls()).map((c) => c.url))
        .toEqual(['https://storage.googleapis.com/upload/session-2']);
    });

    it('asks for the lock without waiting behind the other tab', async () => {
      const file = fileNamed('a.pdf');
      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [landed()] });
      xhr.on('PUT', 'session-1', { status: 200 });

      await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

      // The holder of an upload lock is a multi-gigabyte upload. A plain
      // request would queue behind it, so the second tab would sit on a
      // spinner for an hour instead of opening its own session.
      expect(locks.requests()).toHaveLength(1);
      expect(locks.requests()[0].options.ifAvailable).toBe(true);
    });

    it('does not resume at all in a browser with no Web Locks', async () => {
      const restore = removeWebLocks();
      try {
        const file = fileNamed('a.pdf');
        saveUploadSession(matterDestination(), await identity(file), session());
        api.post('/files/upload-init', {
          uploads: [session({ uploadUrl: 'https://storage.googleapis.com/upload/session-2' })],
        });
        api.post('/files/upload-finalize', { files: [landed()] });
        xhr.on('PUT', 'session-2', { status: 200 });

        await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

        // Nothing can be proved about the other tabs, so nothing is shared. The
        // cost is one extra upload; the cost of assuming is a document with
        // another document's bytes in the middle of it.
        expect(api.callsTo('/files/upload-init')).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  describe('a refresh after the bytes landed', () => {
    it('finalizes without sending a single byte again', async () => {
      const file = fileNamed('a.pdf');
      saveUploadSession(matterDestination(), await identity(file), session());
      api.post('/files/upload-finalize', {
        files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
      });
      // The whole object landed before the tab was closed; GCS answers the
      // status query with 200, which is the session already finalized.
      xhr.on('PUT', 'session-1', { status: 200 });

      const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [file]);

      // Re-sending a 3 GB object that storage already holds is the single most
      // expensive thing this code can get wrong, and it looks like a normal
      // upload while it happens.
      expect(chunkPuts(xhr.calls())).toHaveLength(0);
      expect(xhr.calls('PUT').map((c) => c.headers['content-range'])).toEqual(['bytes */4']);
      expect(api.callsTo('/files/upload-finalize')).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(loadUploadSession(matterDestination(), await identity(file))).toBeNull();
    });
  });

  describe('when one file in a batch cannot be uploaded', () => {
    const secondId = '8d4f2a10-0000-4000-8000-000000000002';

    /** Init opens two sessions; the second url is scripted per test. */
    function arrangeTwo() {
      api.post('/files/upload-init', {
        uploads: [
          session(),
          session({ fileId: secondId, name: 'b.pdf', uploadUrl: 'https://storage.googleapis.com/upload/session-2' }),
        ],
      });
      xhr.on('PUT', 'session-1', { status: 200 });
    }

    it('still finalizes, so the refused file releases its reservation', async () => {
      arrangeTwo();
      // A dead session: this file will never land.
      xhr.on('PUT', 'session-2', { status: 410 });
      api.post('/files/upload-finalize', {
        files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
        failures: [{ objectPath: null, error: 'Object was not uploaded' }],
      });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
      );

      // Init reserved quota against the DECLARED total of both files, and
      // finalize is the only thing that gives the unused part back: an entry
      // whose object never landed contributes nothing to the actual usage while
      // its declared size still counts toward the release. Throwing the batch
      // away before finalize leaves those bytes reserved forever, and the next
      // attempt reserves them a second time, so a firm can be locked out of its
      // own quota by retrying a failed upload.
      const finalized = api.callsTo('/files/upload-finalize')[0].body as { uploads: Array<{ fileId: string }> };
      expect(finalized.uploads.map((u) => u.fileId)).toEqual([FILE_ID, secondId]);
      expect(result.count).toBe(1);
    });

    it('names the file that failed instead of discarding the whole batch', async () => {
      arrangeTwo();
      xhr.on('PUT', 'session-2', { status: 410 });
      api.post('/files/upload-finalize', {
        files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
      });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
      );

      // Nineteen files uploaded and one refused used to reject the whole call,
      // so the caller reported a failure for nineteen documents that are in
      // storage and told the user nothing about which one was missing.
      expect(result.failures).toEqual([
        { name: 'b.pdf', error: expect.stringMatching(/upload link expired/i), index: 1 },
      ]);
      expect(result.files.map((f) => f.fileId)).toEqual([FILE_ID]);
    });

    it('KEEPS the descriptor of a file whose retries ran out', async () => {
      jest.useFakeTimers();
      try {
        const a = fileNamed('a.pdf');
        const b = fileNamed('b.pdf');
        arrangeTwo();
        // A 5xx is transient by nature, so the session is still worth resuming.
        xhr.on('PUT', 'session-2', { status: 503 });
        api.post('/files/upload-finalize', {
          files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
        });

        const result = await settleUnderFakeTimers(
          filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [a, b]),
        );

        expect(result.failures?.map((f) => f.name)).toEqual(['b.pdf']);
        // Kept, so picking the same file again resumes from where storage got
        // to rather than starting a 3 GB upload over at byte zero.
        expect(loadUploadSession(matterDestination(), await identity(b)))
          .toMatchObject({ fileId: secondId });
      } finally {
        jest.useRealTimers();
      }
    });

    it('names a file finalize refused, with the server\'s reason', async () => {
      xhr.on('PUT', 'session-1', { status: 200 });
      xhr.on('PUT', 'session-2', { status: 200 });
      const secondPath = 'lawfirmids/firm-1/objects/8d4f2a10-0000-4000-8000-000000000002';
      api.post('/files/upload-init', {
        uploads: [
          session(),
          session({ fileId: secondId, name: 'b.pdf', objectPath: secondPath, uploadUrl: 'https://storage.googleapis.com/upload/session-2' }),
        ],
      });
      api.post('/files/upload-finalize', {
        files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
        failures: [{ objectPath: secondPath, error: 'Rejected: file appears to be a Windows executable' }],
      });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
      );

      // Every byte of b.pdf reached storage, so nothing failed on the way up;
      // the server deleted it at finalize. Reading only `files` reported one
      // upload and said nothing about the document that is not there.
      expect(result.failures?.map(({ name, error }) => ({ name, error }))).toEqual([
        { name: 'b.pdf', error: 'Rejected: file appears to be a Windows executable' },
      ]);
    });

    it('rejects a single file finalize refused rather than resolving with nothing', async () => {
      api.post('/files/upload-init', { uploads: [session()] });
      xhr.on('PUT', 'session-1', { status: 200 });
      api.post('/files/upload-finalize', {
        files: [],
        failures: [{ objectPath: OBJECT_PATH, error: 'Rejected: 3 GB exceeds the 2 GB per-file limit for this plan.' }],
      });

      // Resolving here is "Uploaded 1 file" on screen and a cleared selection,
      // for a document the server deleted.
      await expect(filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]))
        .rejects.toThrow('Rejected: 3 GB exceeds the 2 GB per-file limit for this plan.');
    });

    it('names a file finalize reported in neither list', async () => {
      arrangeTwo();
      xhr.on('PUT', 'session-2', { status: 200 });
      // The refusal carries no path the browser can match ("Not an upload of
      // yours" names none), so only its absence from `files` says it failed.
      api.post('/files/upload-finalize', {
        files: [{ fileId: FILE_ID, objectPath: session().objectPath }],
        failures: [{ objectPath: null, error: 'Not an upload of yours' }],
      });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
      );

      expect(result.failures?.map((f) => f.name)).toEqual(['b.pdf']);
      expect(result.failures?.[0].error).toMatch(/could not be saved/i);
    });

    it('names a file init opened no session for', async () => {
      api.post('/files/upload-init', { uploads: [session()] });
      xhr.on('PUT', 'session-1', { status: 200 });
      api.post('/files/upload-finalize', { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf'), fileNamed('b.pdf')],
      );

      // Never sent, so never stored. Skipping it silently reports a batch of
      // two as a clean upload of one.
      expect(result.files.map((f) => f.fileId)).toEqual([FILE_ID]);
      expect(result.failures?.map((f) => f.name)).toEqual(['b.pdf']);
    });

    it('says WHICH of two same-named files failed, by position', async () => {
      arrangeTwo();
      xhr.on('PUT', 'session-2', { status: 410 });
      api.post('/files/upload-finalize', { files: [landed()] });

      const result = await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID),
        [fileNamed('Scan.pdf', 'application/pdf', 'abcd'), fileNamed('Scan.pdf', 'application/pdf', 'wxyz')],
      );

      // Two scans off one device share a name. By name alone the caller cannot
      // tell which one landed, keeps both selected, and uploads the one that
      // succeeded a second time as "Scan (1).pdf".
      expect(result.failures?.map((f) => f.index)).toEqual([1]);
    });

    it('rejects when NOTHING in the batch could be uploaded', async () => {
      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [] });
      xhr.on('PUT', 'session-1', { status: 403 });

      // A partial success is a result with failures in it; a total failure is
      // still an error, or a single-file upload that stored nothing would
      // resolve and the caller would report success.
      await expect(filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]))
        .rejects.toThrow(/upload link expired/i);
    });
  });

  describe('a batch larger than the server takes in one init', () => {
    const idFor = (n: number) => `8d4f2a10-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const pathFor = (id: string) => `lawfirmids/firm-1/objects/${id}`;
    const QUOTA = 'Your firm has used all of its storage.';
    let opened = 0;

    beforeEach(() => { opened = 0; });

    /**
     * Init as the backend answers it: more than 20 files is a 400, otherwise
     * one session per declared file. `refuse` names the init calls (1-based)
     * answered with a quota refusal instead.
     */
    function backendInit(refuse: number[] = []) {
      let calls = 0;
      api.post('/files/upload-init', (call) => {
        calls += 1;
        const declared = (call.body as { files: Array<{ name: string; size: number; contentType: string }> }).files;
        if (declared.length > 20) return { status: 400, body: { error: 'Too many files (max 20 per upload)' } };
        if (refuse.includes(calls)) return { status: 413, body: { error: QUOTA } };
        return {
          uploads: declared.map((f) => {
            opened += 1;
            const id = idFor(opened);
            return {
              fileId: id, name: f.name, objectPath: pathFor(id),
              uploadUrl: `https://storage.googleapis.com/upload/s-${opened}`,
              contentType: f.contentType, declaredSize: f.size, reservationId: `res-${opened}`,
            };
          }),
        };
      });
    }

    /** Finalize stamping every row it is handed. `onCall` runs first. */
    function backendFinalize(onCall: () => void = () => {}) {
      api.post('/files/upload-finalize', (call) => {
        onCall();
        const uploads = (call.body as { uploads: Array<{ fileId: string }> }).uploads;
        return { files: uploads.map((u) => ({ fileId: u.fileId, objectPath: pathFor(u.fileId) })), failures: [] };
      });
    }

    const picked = (count: number) =>
      Array.from({ length: count }, (_, i) => fileNamed(`doc-${i + 1}.pdf`));

    it('opens sessions in groups the server accepts, and uploads every file', async () => {
      backendInit();
      backendFinalize();
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', { status: 200 });

      const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), picked(25));

      // The server refuses more than 20 files per init, so one init for a
      // folder's worth of scans failed every one of them.
      const declared = api.callsTo('/files/upload-init')
        .map((c) => (c.body as { files: unknown[] }).files.length);
      expect(declared).toEqual([20, 5]);
      // Filed together, so no document is filed before the last byte lands.
      expect(api.callsTo('/files/upload-finalize')).toHaveLength(1);
      expect(result.count).toBe(25);
      expect(result.failures).toBeUndefined();
    });

    it('keeps what landed when a later group is refused, naming the rest', async () => {
      backendInit([2]);
      backendFinalize();
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', { status: 200 });

      const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), picked(25));

      expect(result.count).toBe(20);
      expect(result.failures?.map((f) => [f.name, f.index])).toEqual(
        Array.from({ length: 5 }, (_, i) => [`doc-${21 + i}.pdf`, 20 + i]),
      );
      expect(result.failures?.every((f) => f.error === QUOTA)).toBe(true);
    });

    it('rejects as a single batch would when every group is refused', async () => {
      backendInit([1, 2]);

      await expect(filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), picked(25)))
        .rejects.toThrow(QUOTA);
      expect(xhr.calls('PUT')).toHaveLength(0);
    });

    it('says the upload can no longer be stopped once, after the last group\'s bytes', async () => {
      const events: string[] = [];
      backendInit();
      backendFinalize(() => events.push('finalize'));
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', () => {
        events.push('put');
        return { status: 200 };
      });

      await filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), picked(25),
        undefined, undefined, undefined, () => events.push('finalizing'),
      );

      // Said after the first group, the cancel control would disappear while
      // the second group's bytes were still moving.
      expect(events.filter((e) => e === 'finalizing')).toHaveLength(1);
      expect(events.slice(events.indexOf('finalizing'))).toEqual(['finalizing', 'finalize']);
    });

    it('opens no further group once the user has cancelled', async () => {
      const controller = new AbortController();
      let calls = 0;
      api.post('/files/upload-init', (call) => {
        calls += 1;
        // The cancel lands while the first group's init is on the wire.
        controller.abort();
        const declared = (call.body as { files: Array<{ name: string; size: number; contentType: string }> }).files;
        return {
          uploads: declared.map((f, i) => {
            const id = idFor(calls * 100 + i);
            return {
              fileId: id, name: f.name, objectPath: pathFor(id), reservationId: `res-${id}`,
              uploadUrl: `https://storage.googleapis.com/upload/s-${calls}-${i}`,
              contentType: f.contentType, declaredSize: f.size,
            };
          }),
        };
      });
      api.post('/files/upload-cancel', { cancelled: 20 });

      await expect(filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), picked(25), undefined, undefined, controller.signal,
      )).rejects.toMatchObject({ name: 'UploadCancelledError' });

      // Each init reserves quota and claims names, so a group opened after the
      // cancel is work the user already withdrew.
      expect(api.callsTo('/files/upload-init')).toHaveLength(1);
      expect(xhr.calls('PUT')).toHaveLength(0);
    });

    it('moves the bar forward only, reaching 100 once at the end', async () => {
      backendInit();
      backendFinalize();
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', { status: 200 });
      const seen: number[] = [];

      await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), picked(25), (p) => seen.push(p));

      // Each group reporting its own 0 to 100 sent the bar back to the start
      // halfway through, and called the upload finished twice.
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(seen.filter((p) => p === 100)).toHaveLength(1);
      expect(seen[seen.length - 1]).toBe(100);
    });

    it('files nothing when the user cancels partway, releases every file, and starts over when picked again', async () => {
      const controller = new AbortController();
      backendInit();
      backendFinalize();
      // The cancel lands while the second group's bytes are moving, after every
      // byte of the first group is already in storage.
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', (call) => {
        if (call.url.endsWith('/s-21')) {
          controller.abort();
          return { aborted: true };
        }
        return { status: 200 };
      });
      const files = picked(25);

      await expect(filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), files, undefined, undefined, controller.signal,
      )).rejects.toMatchObject({ name: 'UploadCancelledError' });

      // A cancel is all or nothing, however many groups the selection spans:
      // finalizing each group as it landed left twenty documents filed from an
      // upload the user stopped.
      expect(api.callsTo('/files/upload-finalize')).toHaveLength(0);

      // Every row and reservation both inits opened is given back at once, in
      // calls no larger than the route takes, rather than held for two hours.
      await waitFor(() => api.callsTo('/files/upload-cancel').length === 2);
      const released = api.callsTo('/files/upload-cancel')
        .map((c) => (c.body as { uploads: Array<{ fileId: string; reservationId: string }> }).uploads);
      expect(released.map((u) => u.length)).toEqual([20, 5]);
      expect(released.flat()).toEqual(
        Array.from({ length: 25 }, (_, i) => ({ fileId: idFor(i + 1), reservationId: `res-${i + 1}` })),
      );

      // Those rows are gone, so picking the same files again opens fresh
      // sessions and files all of them together.
      xhr.on('PUT', 'storage.googleapis.com/upload/s-', { status: 200 });
      const result = await filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), files);

      expect(api.callsTo('/files/upload-init')).toHaveLength(4);
      const finalizes = api.callsTo('/files/upload-finalize');
      expect(finalizes).toHaveLength(1);
      expect((finalizes[0].body as { uploads: Array<{ fileId: string }> }).uploads.map((u) => u.fileId))
        .toEqual(Array.from({ length: 25 }, (_, i) => idFor(26 + i)));
      expect(result.count).toBe(25);
    });
  });

  describe('how many files move at once', () => {
    it('sends nothing until an upload slot is free', async () => {
      // The gate is app-wide, so a spec can hold it. Occupying both slots and
      // watching for bytes is deterministic, where counting overlap in a fake
      // whose responses all land on the same microtask is not.
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const held = [
        runWithUploadLimit(() => new Promise<void>((r) => { releaseFirst = r; })),
        runWithUploadLimit(() => new Promise<void>((r) => { releaseSecond = r; })),
      ];

      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] });
      xhr.on('PUT', 'session-1', { status: 200 });

      const upload = filesService.upload(LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')]);
      try {
        // Init is authorization and costs nothing on the uplink, so it may run.
        // The BYTES are what has to wait.
        await waitFor(() => api.callsTo('/files/upload-init').length === 1);
        // Then give the code every chance to send bytes it must not send yet.
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));
        expect(xhr.calls('PUT')).toHaveLength(0);
      } finally {
        // The gate is app-wide and outlives this spec, and so does the upload
        // it is holding. A slot left held, or an upload still running once the
        // transport fakes are restored, breaks a later spec somewhere
        // unrelated, which is worse than failing here.
        releaseFirst();
        releaseSecond();
        await Promise.all(held);
        await upload.catch(() => {});
      }

      expect(xhr.calls('PUT')).toHaveLength(1);
    });

    it('hears a cancel while still waiting for a slot', async () => {
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const held = [
        runWithUploadLimit(() => new Promise<void>((r) => { releaseFirst = r; })),
        runWithUploadLimit(() => new Promise<void>((r) => { releaseSecond = r; })),
      ];
      api.post('/files/upload-init', { uploads: [session()] });
      api.post('/files/upload-finalize', { files: [{ fileId: FILE_ID, objectPath: session().objectPath }] });
      xhr.on('PUT', 'session-1', { status: 200 });
      const controller = new AbortController();

      const upload = filesService.upload(
        LAW_FIRM_ID, matterScope(MATTER_ID), [fileNamed('a.pdf')], undefined, undefined, controller.signal,
      );
      let outcome: unknown = 'still waiting';
      upload.then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
      try {
        await waitFor(() => api.callsTo('/files/upload-init').length === 1);
        for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 1));
        controller.abort();
        await waitFor(() => outcome !== 'still waiting', 50);

        // Queued behind two other uploads, a cancel that is heard only when a
        // slot frees does nothing for as long as those take.
        expect(outcome).toMatchObject({ name: 'UploadCancelledError' });
        expect(xhr.calls('PUT')).toHaveLength(0);
        expect(api.callsTo('/files/upload-finalize')).toHaveLength(0);
      } finally {
        releaseFirst();
        releaseSecond();
        await Promise.all(held);
        await upload.catch(() => {});
      }
    });
  });
});

describe('task attachments', () => {
  const SESSION = 'https://storage.googleapis.com/upload/task-a';

  /** Answer the three legs of a direct upload for one file. */
  function arrangeUpload(files: unknown[] = []) {
    api.post('/files/upload-init', {
      uploads: [{
        fileId: 'file-1', name: 'a.pdf', objectPath: 'tasks/a.pdf',
        uploadUrl: SESSION, contentType: 'application/pdf', declaredSize: 5,
      }],
    });
    xhr.onExact('PUT', SESSION, { status: 200 });
    api.post('/files/upload-finalize', { files, failures: [] });
  }

  it('goes through the direct-to-storage pair, naming the task as the scope', async () => {
    // There used to be a separate multipart route that held ten files at a
    // hundred megabytes each in the API container. `context: 'task'` already
    // resolves the right folder and stamps the row's `task_id`, so removing it
    // needed no new upload path.
    arrangeUpload([{
      fileId: 'file-1', name: 'a.pdf', size: 5,
      contentType: 'application/pdf', signedUrl: 'https://signed/a', objectPath: 'tasks/a.pdf',
    }]);

    await filesService.uploadTaskAttachments(LAW_FIRM_ID, TASK_ID, [fileNamed('a.pdf')]);

    const init = api.callsTo('/files/upload-init')[0].body as any;
    expect(init.context).toBe('task');
    expect(init.taskId).toBe(TASK_ID);
    expect(init.lawFirmId).toBe(LAW_FIRM_ID);
    expect(init.files.map((f: any) => f.name)).toEqual(['a.pdf']);
  });

  it('sends the bytes to storage rather than through the API', async () => {
    arrangeUpload([{
      fileId: 'file-1', name: 'a.pdf', size: 5,
      contentType: 'application/pdf', signedUrl: 'https://signed/a', objectPath: 'tasks/a.pdf',
    }]);

    await filesService.uploadTaskAttachments(LAW_FIRM_ID, TASK_ID, [fileNamed('a.pdf')]);

    expect(xhr.calls('PUT')[0].url).toBe(SESSION);
  });

  it('shapes the result the task page stores', async () => {
    arrangeUpload([{
      fileId: 'file-1', name: 'a.pdf', size: 5,
      contentType: 'application/pdf', signedUrl: 'https://signed/a', objectPath: 'tasks/a.pdf',
    }]);

    const out = await filesService.uploadTaskAttachments(LAW_FIRM_ID, TASK_ID, [fileNamed('a.pdf')]);

    // The task page maps over these, so the shape is the contract, not the
    // finalize response's own field names.
    expect(out).toEqual([{
      id: 'file-1', name: 'a.pdf', size: 5,
      type: 'application/pdf', url: 'https://signed/a', objectPath: 'tasks/a.pdf',
    }]);
  });

  it('rejects when finalize stamped none of the attachments', async () => {
    arrangeUpload();

    // Finalize named the one attachment in neither list. Resolving with an
    // empty list told the task page the upload worked and stored nothing.
    await expect(filesService.uploadTaskAttachments(LAW_FIRM_ID, TASK_ID, [fileNamed('a.pdf')]))
      .rejects.toThrow(/could not be saved/i);
  });

  it('deletes one attachment by all three identifiers', async () => {
    api.delete('/files/delete-task-attachment', { message: 'Deleted' });

    await filesService.deleteTaskAttachment(LAW_FIRM_ID, TASK_ID, FILE_ID);

    const params = paramsOf(api.calls('DELETE')[0].url);
    expect(params.get('lawFirmId')).toBe(LAW_FIRM_ID);
    expect(params.get('taskId')).toBe(TASK_ID);
    expect(params.get('fileId')).toBe(FILE_ID);
  });

  it('throws when an attachment delete is refused', async () => {
    api.delete('/files/delete-task-attachment', { status: 403, body: { error: 'Forbidden' } });

    await expect(filesService.deleteTaskAttachment(LAW_FIRM_ID, TASK_ID, FILE_ID))
      .rejects.toBeDefined();
  });
});

describe('downloads', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('creates and waits for a selection export', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-1' });
    api.get('/files/export-job', {
      exportJob: { status: 'succeeded', downloadUrl: 'https://storage.test/files.zip' },
    });

    const pending = filesService.downloadZip(LAW_FIRM_ID, matterScope(MATTER_ID), [FILE_ID, FOLDER_ID]);
    await jest.advanceTimersByTimeAsync(1000);
    await pending;

    // Browsers honour only the first of several programmatic downloads fired in
    // a loop, so a multi-item download has to come back as a single archive. The
    // id list is the whole instruction; a folder in it is expanded server-side.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.fileIds).toEqual([FILE_ID, FOLDER_ID]);
    expect(body.matterId).toBe(MATTER_ID);
    expect(clickedLinks[0].href).toBe('https://storage.test/files.zip');
    expect(savedBlobs).toHaveLength(0);
  });

  it('creates a folder export by folder id', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-2' });
    api.get('/files/export-job', {
      exportJob: { status: 'succeeded', downloadUrl: 'https://storage.test/contracts.zip' },
    });

    const pending = filesService.downloadFolder(LAW_FIRM_ID, matterScope(MATTER_ID), FOLDER_ID);
    await jest.advanceTimersByTimeAsync(1000);
    await pending;

    // The name the user sees in their downloads tray. `undefined.zip` is what a
    // dropped argument produces, and it is indistinguishable from a corrupt one.
    expect((api.calls('POST')[0].body as Record<string, unknown>).folderId).toBe(FOLDER_ID);
    expect(clickedLinks[0].href).toBe('https://storage.test/contracts.zip');
  });

  /** Status reads of one export job, leaving out the create and the cancel. */
  const statusReads = () => api.calls('GET').filter((c) => c.url.includes('/files/export-job?'));

  it('polls the export at 1s, 2s, 5s, then every 10s', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-5' });
    const running = { exportJob: { status: 'running' } };
    api.get('/files/export-job', sequence(
      running, running, running, running,
      { exportJob: { status: 'succeeded', downloadUrl: 'https://storage.test/files.zip' } },
    ));

    const pending = filesService.downloadZip(LAW_FIRM_ID, matterScope(MATTER_ID), [FILE_ID]);
    const after = async (ms: number) => {
      await jest.advanceTimersByTimeAsync(ms);
      return statusReads().length;
    };

    // A large archive takes minutes. A read every second for all of it is
    // sixty requests a minute from each waiting tab, for a status that moves
    // once.
    expect(await after(999)).toBe(0);
    expect(await after(1)).toBe(1);
    expect(await after(1999)).toBe(1);
    expect(await after(1)).toBe(2);
    expect(await after(5000)).toBe(3);
    expect(await after(9999)).toBe(3);
    expect(await after(1)).toBe(4);
    expect(await after(10000)).toBe(5);
    await pending;

    expect(clickedLinks[0].href).toBe('https://storage.test/files.zip');
  });

  it('reads nothing while the tab is hidden, and resumes when it is shown', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-6' });
    api.get('/files/export-job', { exportJob: { status: 'running' } });
    api.post('/files/export-job-cancel', { message: 'Export job cancelled successfully' });
    const controller = new AbortController();
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    const pending = filesService.downloadZip(
      LAW_FIRM_ID, matterScope(MATTER_ID), [FILE_ID], controller.signal,
    );
    const settled = expect(pending).rejects.toThrow(/cancelled/i);
    await jest.advanceTimersByTimeAsync(60_000);
    // The job was created, so the loop is running; it just asked for nothing.
    expect(api.callsTo('/files/export-jobs')).toHaveLength(1);
    expect(statusReads()).toHaveLength(0);

    hidden.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(statusReads()).toHaveLength(1);

    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    await settled;
    hidden.mockRestore();
  });

  it('CANCELS the job when the caller aborts the wait', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-3' });
    api.get('/files/export-job', { exportJob: { status: 'running' } });
    api.post('/files/export-job-cancel', { message: 'Export job cancelled successfully' });
    const controller = new AbortController();

    const pending = filesService.downloadZip(
      LAW_FIRM_ID, matterScope(MATTER_ID), [FILE_ID], controller.signal,
    );
    const settled = expect(pending).rejects.toThrow(/cancelled/i);
    await jest.advanceTimersByTimeAsync(1000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(1000);
    await settled;

    // Abandoning the wait alone leaves the worker building an archive nobody
    // will fetch, filed and quota-charged against the firm. The cancel is the
    // only thing that reaches a worker already inside the build.
    const cancels = api.callsTo('/files/export-job-cancel');
    expect(cancels).toHaveLength(1);
    expect(paramsOf(cancels[0].url).get('jobId')).toBe('job-3');
    expect(clickedLinks).toHaveLength(0);
  });

  it('gives up on a job that never finishes, and cancels it', async () => {
    api.post('/files/export-jobs', { exportJobId: 'job-4' });
    api.get('/files/export-job', { exportJob: { status: 'running' } });
    api.post('/files/export-job-cancel', { message: 'Export job cancelled successfully' });

    const pending = filesService.downloadZip(LAW_FIRM_ID, matterScope(MATTER_ID), [FILE_ID]);
    const settled = expect(pending).rejects.toThrow(/longer than expected/i);
    // Past the ceiling. Without one this polls once a second for as long as the
    // tab is open, against a job that will never reach a terminal state.
    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);
    await settled;

    expect(api.callsTo('/files/export-job-cancel')).toHaveLength(1);
    expect(clickedLinks).toHaveLength(0);
  });

  it('saves NOTHING when a zip download is refused', async () => {
    api.post('/files/export-jobs', { status: 403, body: { error: 'Forbidden' } });

    await expect(filesService.downloadZip(LAW_FIRM_ID, matterScope(MATTER_ID), ['a.pdf']))
      .rejects.toThrow(/forbidden/i);

    // A refusal body written to disk as `files.zip` is a corrupt archive the
    // user blames the app for, with no sign that access was the problem.
    expect(clickedLinks).toHaveLength(0);
    expect(savedBlobs).toHaveLength(0);
  });

  it('hands the url to the browser instead of buffering the file', async () => {
    const url = 'https://storage.googleapis.com/signed/deposition.mp4?sig=abc';

    await filesService.downloadFile(url, 'deposition.mp4');

    // The old path fetched the whole response and built a Blob before saving,
    // so downloading a 3 GB file tried to hold 3 GB in the tab. The signed url
    // is already a complete, authorized download: the browser's own download
    // manager streams it to disk and the page holds nothing.
    expect(savedBlobs).toHaveLength(0);
    expect(api.calls()).toHaveLength(0);
    const [link] = clickedLinks;
    expect(link.href).toBe(url);
    expect(link.download).toBe('deposition.mp4');
  });

  it('sends no request at all, so no credential can travel with it', async () => {
    // The old path fetched the object from JavaScript, which is why it needed a
    // test proving no Authorization header rode along: the signed url is already
    // the authorization and adding the firm's token would hand it to storage.
    // Making no request is a stronger version of that guarantee.
    await filesService.downloadFile('https://storage.googleapis.com/signed/a.pdf', 'a.pdf');

    expect(api.calls()).toHaveLength(0);
  });

  it('opens nothing in a new tab and needs no CORS fallback', async () => {
    // There used to be a fallback that opened a tab when the cross-origin fetch
    // failed, because the fetch could fail on a bucket without CORS. Handing the
    // url to the download manager is not a cross-origin read from the page, so
    // there is no failure mode left to fall back from.
    await filesService.downloadFile('https://storage.googleapis.com/signed/a.pdf', 'a.pdf');

    expect(clickedLinks).toHaveLength(1);
    expect(clickedLinks[0].target).toBe('');
  });

});

describe('external share links', () => {
  const LINK = {
    token: 'tok-1', fileId: FILE_ID, displayName: 'nda.pdf', mimeType: 'application/pdf',
    permission: 'view', hasPassword: true, expiresAt: null, revoked: false, accessCount: 0,
    lastAccessedAt: null, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://app.paralegix.com/share/tok-1',
  };

  it('POSTs the file, the permission and the expiry', async () => {
    api.post('/file-share-links', { link: LINK });

    await filesService.createShareLink(LAW_FIRM_ID, {
      fileId: FILE_ID, permission: 'download', expiresInHours: 24,
    });

    // This mints a url anyone can open with no login, so every field is a term
    // of that grant. A dropped expiry makes the link permanent.
    const call = api.calls('POST')[0];
    const body = call.body as Record<string, unknown>;
    expect(call.pathname).toMatch(/\/file-share-links$/);
    expect(body.fileId).toBe(FILE_ID);
    expect(body.permission).toBe('download');
    expect(body.expiresInHours).toBe(24);
  });

  it('sends the password the firm set on the link', async () => {
    api.post('/file-share-links', { link: LINK });

    await filesService.createShareLink(LAW_FIRM_ID, { fileId: FILE_ID, password: 'correct horse' });

    // Asserted on the value, not on its absence from the whole body: a check
    // that merely looked for the string elsewhere would pass whether or not the
    // field arrived. A dropped password creates an unprotected public link that
    // the UI then describes as password-protected.
    expect((api.calls('POST')[0].body as Record<string, unknown>).password).toBe('correct horse');
  });

  it('omits the password field entirely for an open link', async () => {
    api.post('/file-share-links', { link: LINK });

    await filesService.createShareLink(LAW_FIRM_ID, { fileId: FILE_ID });

    expect(api.calls('POST')[0].body as Record<string, unknown>).not.toHaveProperty('password');
  });

  it('unwraps the created link rather than the envelope', async () => {
    api.post('/file-share-links', { link: LINK });

    const link = await filesService.createShareLink(LAW_FIRM_ID, { fileId: FILE_ID });

    // The `url` is what the firm copies and sends to the recipient. Handing back
    // the envelope puts `undefined` on the clipboard.
    expect(link.url).toBe('https://app.paralegix.com/share/tok-1');
  });

  it('lists the links for ONE file', async () => {
    api.get('/file-share-links', { links: [LINK] });

    const links = await filesService.listShareLinks(LAW_FIRM_ID, FILE_ID);

    // Without the filter the panel would show every live external link in the
    // firm against whichever file happened to be selected.
    expect(paramsOf(api.calls('GET')[0].url).get('fileId')).toBe(FILE_ID);
    expect(links).toHaveLength(1);
  });

  it('lists the links for a selection in one request, as comma-separated ids', async () => {
    api.get('/file-share-links', { links: [LINK] });

    await filesService.listShareLinks(LAW_FIRM_ID, ['file-a', 'file-b']);

    expect(api.calls('GET')).toHaveLength(1);
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('fileIds')).toBe('file-a,file-b');
    // The route takes exactly one of the two.
    expect(params.get('fileId')).toBeNull();
  });

  it('defaults a missing links list to empty', async () => {
    api.get('/file-share-links', {});

    // The panel maps over this to decide whether a file is shared at all.
    expect(await filesService.listShareLinks(LAW_FIRM_ID, OBJECT_PATH)).toEqual([]);
  });

  it('revokes by token, url-encoded', async () => {
    api.delete('/file-share-links/tok%2F1', { message: 'Revoked', token: 'tok/1' });

    await filesService.revokeShareLink(LAW_FIRM_ID, 'tok/1');

    // An unencoded token splits the path and addresses a different route, so the
    // revoke silently 404s and the link stays open.
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/file-share-links\/tok%2F1$/);
  });

  it('throws when a revoke is refused', async () => {
    api.delete('/file-share-links/tok-1', { status: 403, body: { error: 'Only the creator can revoke this link' } });

    // The worst refusal to swallow in this file: the row disappears, the firm
    // believes the link is dead, and it keeps serving the document.
    await expect(filesService.revokeShareLink(LAW_FIRM_ID, 'tok-1'))
      .rejects.toThrow(/only the creator/i);
  });
});

describe('storage usage', () => {
  it('reports the raw byte counts the server sent', async () => {
    api.get('/files/usage', {
      usedBytes: 1073741824, limitBytes: 10737418240, fileCount: 42,
      usedFormatted: '1 GB', limitFormatted: '10 GB', percentUsed: 10,
    });

    const usage = await filesService.getStorageUsage(LAW_FIRM_ID);

    // Compared as numbers. The settings screen draws its meter from
    // `percentUsed` and its copy from the formatted strings, so a service that
    // rescaled the bytes would leave the two disagreeing on the same screen.
    expect(usage.usedBytes).toBe(1073741824);
    expect(usage.percentUsed).toBe(10);
  });

  it('throws when usage cannot be read', async () => {
    api.get('/files/usage', { status: 500, body: { error: 'Server error' } });

    // A zeroed usage panel reads as an empty bucket, which is the opposite of
    // the condition that makes this endpoint matter.
    await expect(filesService.getStorageUsage(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});
