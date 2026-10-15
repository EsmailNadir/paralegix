/**
 * The matters service, tested OFFLINE against a fake transport.
 *
 * `matters.service.ts` reports 0%. A matter is the entity everything else hangs
 * off, and this is the mirror of the backend routes the server-side suite covers
 * heavily. The failures worth catching here are the ones a stubbed service hides
 * entirely: a request built against the wrong url, a filter dropped so a firm
 * sees more than it asked for, or a bulk operation sending the wrong id list.
 *
 * BULK OPERATIONS GET THE MOST ATTENTION. `bulk-delete`,
 * `bulk-update-status` and `bulk-update-practice-area` each take an id list and
 * act on every entry. A wrong list is destructive and reports success either
 * way, so the tests assert the exact ids that left the browser.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import mattersService from '@/services/matters.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-9';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('creating a matter', () => {
  it('POSTs to the firm matters route', async () => {
    api.post('/matters', { matterId: 'matter-new' });

    await mattersService.createMatter({ lawFirmId: LAW_FIRM_ID, name: 'New Matter' } as never);

    const [call] = api.calls('POST');
    expect(api.calls('POST')).toHaveLength(1);
    expect(call.pathname).toContain(LAW_FIRM_ID);
    expect(call.pathname).toMatch(/\/matters$/);
    expect(call.body).toEqual({ name: 'New Matter' });
    expect(call.headers['x-timezone']).toBeTruthy();
  });

  it('refuses to build a request with no firm id', async () => {
    await expect(mattersService.createMatter({ name: 'Orphan' } as never))
      .rejects.toThrow(/lawFirmId is required/i);

    // Refused BEFORE any request. Without the guard the url would contain
    // `/lawfirms/undefined/matters`, which is a 404 the user reads as the
    // feature being broken.
    expect(api.calls()).toHaveLength(0);
  });

  it('throws when the server refuses the create', async () => {
    api.post('/matters', { status: 400, body: { error: 'Name is required' } });

    await expect(mattersService.createMatter({ lawFirmId: LAW_FIRM_ID } as never))
      .rejects.toBeDefined();
  });
});

describe('reading one matter', () => {
  it('GETs the matter by id', async () => {
    api.get(`/matters/${MATTER_ID}`, { id: MATTER_ID, name: 'Host Matter' });

    const result = await mattersService.getMatterById(MATTER_ID, LAW_FIRM_ID);

    expect(result.name).toBe('Host Matter');
    expect(api.calls('GET')[0].pathname).toContain(`/matters/${MATTER_ID}`);
    expect(api.calls('GET')[0].headers.authorization).toMatch(/^Bearer /);
  });

  it('THROWS on a failure rather than returning a blank matter', async () => {
    api.get(`/matters/${MATTER_ID}`, { status: 404, body: { error: 'Matter not found' } });

    // A matter page rendered from a swallowed 404 shows empty fields, which
    // reads as a matter with no details rather than one that does not exist.
    await expect(mattersService.getMatterById(MATTER_ID, LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('the paged matter list', () => {
  const PAGE = { matters: [], totalItems: 0 };

  it('always sends a limit', async () => {
    api.get('/matters', PAGE);

    await mattersService.getMattersPaged(LAW_FIRM_ID);

    expect(api.calls('GET')[0].url).toContain('limit=');
  });

  it('CLAMPS a limit above the maximum', async () => {
    api.get('/matters', PAGE);

    await mattersService.getMattersPaged(LAW_FIRM_ID, { limit: 100000 });

    // The cap is what stops one request pulling every matter a firm has ever
    // opened.
    const limit = Number(new URL(api.calls('GET')[0].url, 'http://x').searchParams.get('limit'));
    expect(limit).toBeLessThanOrEqual(500);
  });

  it('passes each filter through under its own key', async () => {
    api.get('/matters', PAGE);

    await mattersService.getMattersPaged(LAW_FIRM_ID, {
      status: 'active',
      practiceAreaId: 'pa-1',
      clientId: 'client-7',
      leadUserId: 'member-3',
      category: 'Litigation > Appeals',
    });

    const url = api.calls('GET')[0].url;
    for (const pair of ['status=active', 'practiceAreaId=pa-1', 'clientId=client-7',
      'leadUserId=member-3']) {
      expect(url).toContain(pair);
    }
    // The category is a full ' > '-joined path and must survive encoding intact,
    // because the server matches the whole subtree from it.
    //
    // Read back through URLSearchParams rather than decodeURIComponent: query
    // strings encode a space as `+`, which decodeURIComponent leaves alone, so
    // that assertion would fail on a perfectly correct url.
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('category')).toBe('Litigation > Appeals');
  });

  it('OMITS a filter that was not given', async () => {
    api.get('/matters', PAGE);

    await mattersService.getMattersPaged(LAW_FIRM_ID, { status: 'active' });

    // Sending `clientId=undefined` filters to a client of that name, which is
    // none, and the screen shows an empty firm.
    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('clientId');
    expect(url).not.toContain('practiceAreaId');
  });

  it('sends paymentOngoing only when true', async () => {
    api.get('/matters', PAGE);

    await mattersService.getMattersPaged(LAW_FIRM_ID, { paymentOngoing: true });
    await mattersService.getMattersPaged(LAW_FIRM_ID, { paymentOngoing: false });

    // Its own filter rather than a status value, and "false" is a truthy string
    // server-side, so sending it would filter when the user asked not to.
    expect(api.calls('GET')[0].url).toContain('paymentOngoing=true');
    expect(api.calls('GET')[1].url).not.toContain('paymentOngoing');
  });

  it('defaults a missing envelope to an empty page', async () => {
    api.get('/matters', {});

    const page = await mattersService.getMattersPaged(LAW_FIRM_ID);

    // A missing key must not become `undefined` on a list the UI maps over.
    expect(page.matters).toEqual([]);
    expect(page.totalItems).toBe(0);
  });

  it('keeps the server values when present', async () => {
    api.get('/matters', { matters: [{ id: 'm1' }], totalItems: 42 });

    const page = await mattersService.getMattersPaged(LAW_FIRM_ID);

    // The positive half: defaults that overwrote real values would show every
    // firm an empty matter list.
    expect(page.matters).toHaveLength(1);
    expect(page.totalItems).toBe(42);
  });
});

describe('updating and deleting', () => {
  it('DELETEs one matter by id', async () => {
    api.delete(`/matters/${MATTER_ID}`, { message: 'Deleted' });

    await mattersService.deleteMatter(LAW_FIRM_ID, MATTER_ID);

    expect(api.calls('DELETE')[0].pathname).toContain(`/matters/${MATTER_ID}`);
  });

  it('throws when a delete is refused', async () => {
    api.delete(`/matters/${MATTER_ID}`, {
      status: 403, body: { error: 'This matter is under legal hold and cannot be deleted.' },
    });

    // The backend refuses a matter under legal hold. The client has to surface
    // that, or the row disappears from the screen and returns on the next load.
    await expect(mattersService.deleteMatter(LAW_FIRM_ID, MATTER_ID))
      .rejects.toThrow(/legal hold/i);
  });
});

describe('bulk operations send the EXACT id list', () => {
  it('bulk-deletes only the ids given', async () => {
    api.post('/matters/bulk-delete', { message: 'ok', requested: 2, deleted: 2 });

    await mattersService.deleteMultipleMatters(LAW_FIRM_ID, ['m1', 'm2']);

    // The id list is the whole instruction. A bulk delete that sent the wrong
    // list, or an empty one the server read as "everything", is destructive and
    // reports success either way.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.matterIds).toEqual(['m1', 'm2']);
  });

  it('preserves a single-element list', async () => {
    api.post('/matters/bulk-delete', { message: 'ok' });

    await mattersService.deleteMultipleMatters(LAW_FIRM_ID, ['m1']);

    // A service that unwrapped a one-element array into a bare string would
    // change the request shape for exactly the most common bulk case.
    expect((api.calls('POST')[0].body as Record<string, unknown>).matterIds).toEqual(['m1']);
  });

  it('sends an EMPTY list as an empty array', async () => {
    api.post('/matters/bulk-delete', { message: 'ok', requested: 0, deleted: 0 });

    await mattersService.deleteMultipleMatters(LAW_FIRM_ID, []);

    // `undefined` here would let the server apply its own default, and a
    // bulk-delete with no scope is the worst possible default.
    expect((api.calls('POST')[0].body as Record<string, unknown>).matterIds).toEqual([]);
  });

  it('bulk-updates status with the ids and the status', async () => {
    api.post('/matters/bulk-update-status', { message: 'ok' });

    await mattersService.bulkUpdateStatus(LAW_FIRM_ID, ['m1', 'm2'], 'closed');

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.matterIds).toEqual(['m1', 'm2']);
    expect(body.status).toBe('closed');
  });

  it('bulk-updates practice area WITHOUT sending a name', async () => {
    api.post('/matters/bulk-update-practice-area', { message: 'ok' });

    await mattersService.bulkUpdatePracticeArea(LAW_FIRM_ID, ['m1'], 'pa-1');

    // The server resolves the name from the id. Sending a name too would let the
    // two disagree, and the stored label would drift from the practice area it
    // points at.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.practiceAreaId).toBe('pa-1');
    expect(body.practiceAreaName).toBeUndefined();
  });

  it('routes each bulk operation to its OWN endpoint', async () => {
    api.post('/matters/bulk-delete', { message: 'ok' });
    api.post('/matters/bulk-update-status', { message: 'ok' });
    api.post('/matters/bulk-update-practice-area', { message: 'ok' });

    await mattersService.deleteMultipleMatters(LAW_FIRM_ID, ['m1']);
    await mattersService.bulkUpdateStatus(LAW_FIRM_ID, ['m1'], 'closed');
    await mattersService.bulkUpdatePracticeArea(LAW_FIRM_ID, ['m1'], 'pa-1');

    // Three destructive-or-sweeping operations behind three near-identical
    // signatures. Sending one to another's endpoint would close matters the user
    // asked to delete, or delete ones they asked to close.
    const paths = api.calls('POST').map((c) => c.pathname);
    expect(paths[0]).toMatch(/bulk-delete$/);
    expect(paths[1]).toMatch(/bulk-update-status$/);
    expect(paths[2]).toMatch(/bulk-update-practice-area$/);
  });

  it('throws when a bulk operation is refused', async () => {
    api.post('/matters/bulk-delete', { status: 403, body: { error: 'Forbidden' } });

    await expect(mattersService.deleteMultipleMatters(LAW_FIRM_ID, ['m1']))
      .rejects.toBeDefined();
  });
});


describe('the typeahead lookup', () => {
  it('sends search and limit as query params', async () => {
    api.get('/matters/lookup', { items: [], hasMore: false });

    await mattersService.lookupMatters(LAW_FIRM_ID, { search: 'smith', limit: 10 });

    const [call] = api.calls('GET');
    expect(call.pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/matters/lookup$`));
    expect(call.query.search).toEqual(['smith']);
    expect(call.query.limit).toEqual(['10']);
    expect(call.headers['x-timezone']).toBeTruthy();
  });

  it('sends ids comma separated', async () => {
    api.get('/matters/lookup', { items: [], hasMore: false });

    await mattersService.lookupMatters(LAW_FIRM_ID, { ids: ['m1', 'm2'] });

    expect(api.calls('GET')[0].query.ids).toEqual(['m1,m2']);
  });

  it('omits params that were not supplied', async () => {
    api.get('/matters/lookup', { items: [], hasMore: false });

    await mattersService.lookupMatters(LAW_FIRM_ID);

    expect(api.calls('GET')[0].query).toEqual({});
  });

  it('passes through the extra matter fields a picker needs', async () => {
    api.get('/matters/lookup', {
      items: [{ id: 'm1', label: 'Smith v Jones', sublabel: 'Ada Smith', courtId: 'c1', courtName: 'Superior' }],
      hasMore: true,
    });

    const result = await mattersService.lookupMatters(LAW_FIRM_ID, { search: 'smith' });

    expect(result.hasMore).toBe(true);
    expect(result.items[0]).toMatchObject({ id: 'm1', courtId: 'c1', courtName: 'Superior' });
  });

  it('normalizes a malformed response instead of throwing', async () => {
    api.get('/matters/lookup', null);

    await expect(mattersService.lookupMatters(LAW_FIRM_ID)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });
});

/**
 * Exact-path cases for the rest of the matter surface. `getExact`/`postExact`
 * match the WHOLE pathname and query, so a request that drifts to another
 * firm, another matter, or picks up a stray parameter matches nothing and the
 * transport throws.
 */
const MATTERS = `/api/lawfirms/${LAW_FIRM_ID}/matters`;
const MATTER = `${MATTERS}/${MATTER_ID}`;

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('the full matter list', () => {
  it('returns the matters from the envelope', async () => {
    api.getExact(MATTERS, { matters: [{ id: 'm-1' }, { id: 'm-2' }] });

    const matters = await mattersService.getMatters(LAW_FIRM_ID);

    expect(matters.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('returns an empty list for an envelope with no matters key', async () => {
    api.getExact(MATTERS, {});

    await expect(mattersService.getMatters(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('treats a 404 as a firm with no matters yet', async () => {
    api.getExact(MATTERS, { status: 404, body: { error: 'Not found' } });

    await expect(mattersService.getMatters(LAW_FIRM_ID)).resolves.toEqual([]);
    expect(api.calls('GET')).toHaveLength(1);
  });

  it('rethrows any other failure instead of rendering an empty list', async () => {
    api.getExact(MATTERS, { status: 403, body: { error: 'Forbidden' } });

    const error = await rejectionOf(mattersService.getMatters(LAW_FIRM_ID));
    expect(error.status).toBe(403);
    expect(error.message).toBe('Forbidden');
  });
});

describe('the select-all id list', () => {
  it('sends each filter under its own key and trims the search', async () => {
    api.getExact(
      `${MATTERS}/ids?status=open&paymentOngoing=true&practiceAreaId=pa-1&clientId=client-7&leadUserId=u-1&category=Litigation&search=acme`,
      { ids: ['m-1', 'm-2'], truncated: true, limit: 2 },
    );

    const result = await mattersService.listMatterIds(LAW_FIRM_ID, {
      status: 'open',
      paymentOngoing: true,
      practiceAreaId: 'pa-1',
      clientId: 'client-7',
      leadUserId: 'u-1',
      category: 'Litigation',
      search: '  acme  ',
    });

    expect(result).toEqual({ ids: ['m-1', 'm-2'], truncated: true, limit: 2 });
  });

  it('omits a blank search and defaults a bare envelope', async () => {
    api.getExact(`${MATTERS}/ids`, {});

    const result = await mattersService.listMatterIds(LAW_FIRM_ID, { search: '   ' });

    // `truncated: false` and `ids: []`: a missing flag must not read as
    // "complete" and a missing list must not be undefined.
    expect(result).toEqual({ ids: [], truncated: false, limit: 0 });
  });
});

describe('editing a matter', () => {
  it('PUTs the matter with the firm and matter ids stripped from the body', async () => {
    api.putExact(MATTER, { message: 'Matter updated' });

    const result = await mattersService.updateMatter({
      lawFirmId: LAW_FIRM_ID,
      matterId: MATTER_ID,
      name: 'Renamed',
      budget: 12500.5,
    } as never);

    expect(onlyCall('PUT').body).toEqual({ name: 'Renamed', budget: 12500.5 });
    expect(result).toEqual({ message: 'Matter updated' });
  });

  it('refuses to build a request without both ids', async () => {
    await expect(mattersService.updateMatter({ lawFirmId: LAW_FIRM_ID } as never))
      .rejects.toThrow('lawFirmId and matterId are required to update a matter');
    expect(api.calls()).toHaveLength(0);
  });

  it('changes one matter practice area without sending a name', async () => {
    api.postExact(`${MATTER}/update-practice-area`, { message: 'ok' });

    await mattersService.updatePracticeArea({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, practiceAreaId: 'pa-2' });

    expect(onlyCall('POST').body).toEqual({ practiceAreaId: 'pa-2' });
  });

  it('PATCHes the legal hold with its reason', async () => {
    api.patchExact(`${MATTER}/legal-hold`, { message: 'ok', matter: { id: MATTER_ID, legalHold: true } });

    const result = await mattersService.setLegalHold(LAW_FIRM_ID, MATTER_ID, true, 'Litigation pending');

    expect(onlyCall('PATCH').body).toEqual({ legalHold: true, reason: 'Litigation pending' });
    expect(result.matter).toEqual({ id: MATTER_ID, legalHold: true });
  });
});

describe('matter members', () => {
  it('adds members with exactly the user ids and role', async () => {
    api.postExact(`${MATTER}/members`, { message: 'ok' });

    await mattersService.addMembers({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, targetUserIds: ['u-1', 'u-2'], role: 'paralegal' });

    expect(onlyCall('POST').body).toEqual({ targetUserIds: ['u-1', 'u-2'], role: 'paralegal' });
  });

  it('removes members on the remove sub-route, not with a DELETE', async () => {
    api.postExact(`${MATTER}/members/remove`, { message: 'ok' });

    await mattersService.removeMembers({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, targetUserIds: ['u-2'] });

    expect(onlyCall('POST').body).toEqual({ targetUserIds: ['u-2'] });
  });

  it('PUTs a member hourly rate exactly as given', async () => {
    api.putExact(`${MATTER}/members/hourly-rate`, { message: 'ok' });

    await mattersService.updateMemberHourlyRate({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, userId: 'u-1', hourlyRate: 325.5 });

    expect(onlyCall('PUT').body).toEqual({ userId: 'u-1', hourlyRate: 325.5 });
  });

  it('clears a member hourly rate with an explicit null', async () => {
    api.putExact(`${MATTER}/members/hourly-rate`, { message: 'ok' });

    await mattersService.updateMemberHourlyRate({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, userId: 'u-1', hourlyRate: null });

    expect(onlyCall('PUT').body).toEqual({ userId: 'u-1', hourlyRate: null });
  });

  it('previews a bulk assign without writing, and returns the split as sent', async () => {
    const preview = { toAdd: ['m-1'], alreadyAssigned: ['m-2'], failed: [{ matterId: 'm-3', error: 'No access' }] };
    api.postExact(`${MATTERS}/bulk-add-member/preview`, preview);

    const result = await mattersService.previewBulkAddMember({ lawFirmId: LAW_FIRM_ID, userId: 'u-1', matterIds: ['m-1', 'm-2', 'm-3'] });

    expect(onlyCall('POST').body).toEqual({ userId: 'u-1', matterIds: ['m-1', 'm-2', 'm-3'] });
    expect(result).toEqual(preview);
  });

  it('bulk-assigns on the write route with the exact id list', async () => {
    const outcome = { added: ['m-1'], alreadyAssigned: [], failed: [] };
    api.postExact(`${MATTERS}/bulk-add-member`, outcome);

    const result = await mattersService.bulkAddMember({ lawFirmId: LAW_FIRM_ID, userId: 'u-1', matterIds: ['m-1'] });

    expect(onlyCall('POST').body).toEqual({ userId: 'u-1', matterIds: ['m-1'] });
    expect(result).toEqual(outcome);
  });
});

describe('the firm-wide notes list', () => {
  it('scopes to one matter when asked and fills every count', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notes`, {
      notes: [{ id: 'n-1', matterId: MATTER_ID }],
      totalNotes: 7,
      counts: { all: 7, withTime: 3, withoutTime: 4 },
      tags: ['urgent'],
    });

    const page = await mattersService.listFirmNotes(LAW_FIRM_ID, { matterId: MATTER_ID });

    expect(new URL(onlyCall('GET').url).searchParams.get('matterId')).toBe(MATTER_ID);
    expect(page).toEqual({
      notes: [{ id: 'n-1', matterId: MATTER_ID }],
      totalNotes: 7,
      counts: { all: 7, withTime: 3, withoutTime: 4 },
      tags: ['urgent'],
    });
  });

  it('normalizes a malformed body to an empty page with zero counts', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notes`, { notes: 'nope', tags: null });

    await expect(mattersService.listFirmNotes(LAW_FIRM_ID)).resolves.toEqual({
      notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [],
    });
  });

  it('throws its own message on a bare refusal', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/notes`, { status: 422, body: {} });

    const error = await rejectionOf(mattersService.listFirmNotes(LAW_FIRM_ID));
    expect(error.message).toBe('Failed to load notes');
  });
});

describe('matter notes delegate to the shared notes routes under this matter', () => {
  const NOTE = `${MATTER}/notes/note-1`;
  const rows: Array<[string, string, string, () => Promise<unknown>]> = [
    ['listMatterNotes', 'GET', `${MATTER}/notes`, () => mattersService.listMatterNotes(LAW_FIRM_ID, MATTER_ID)],
    ['addNoteToMatter', 'POST', `${MATTER}/notes`, () => mattersService.addNoteToMatter(LAW_FIRM_ID, MATTER_ID, { content: 'x' } as never)],
    ['updateNoteInMatter', 'PUT', NOTE, () => mattersService.updateNoteInMatter(LAW_FIRM_ID, MATTER_ID, 'note-1', { content: 'y' } as never)],
    ['retractNoteFromMatter', 'DELETE', NOTE, () => mattersService.retractNoteFromMatter(LAW_FIRM_ID, MATTER_ID, 'note-1', 'wrong matter')],
    ['addNoteTimeEntry', 'POST', `${NOTE}/time`, () => mattersService.addNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, 'note-1', { hours: 1 } as never)],
    ['updateNoteTimeEntry', 'PUT', `${NOTE}/time/te-1`, () => mattersService.updateNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, 'note-1', 'te-1', { hours: 2 } as never)],
    ['removeNoteTimeEntry', 'DELETE', `${NOTE}/time/te-1`, () => mattersService.removeNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, 'note-1', 'te-1')],
    ['setNotePinned', 'PUT', `${NOTE}/pin`, () => mattersService.setNotePinned(LAW_FIRM_ID, MATTER_ID, 'note-1', true)],
    ['listNoteVersions', 'GET', `${NOTE}/versions`, () => mattersService.listNoteVersions(LAW_FIRM_ID, MATTER_ID, 'note-1')],
    ['getNote', 'GET', NOTE, () => mattersService.getNote(LAW_FIRM_ID, MATTER_ID, 'note-1')],
    ['listNoteReplies', 'GET', `${NOTE}/replies`, () => mattersService.listNoteReplies(LAW_FIRM_ID, MATTER_ID, 'note-1')],
    ['addNoteReply', 'POST', `${NOTE}/replies`, () => mattersService.addNoteReply(LAW_FIRM_ID, MATTER_ID, 'note-1', { content: 'r' } as never)],
    ['updateNoteReply', 'PUT', `${NOTE}/replies/rep-1`, () => mattersService.updateNoteReply(LAW_FIRM_ID, MATTER_ID, 'note-1', 'rep-1', { content: 'r2' } as never)],
    ['retractNoteReply', 'DELETE', `${NOTE}/replies/rep-1`, () => mattersService.retractNoteReply(LAW_FIRM_ID, MATTER_ID, 'note-1', 'rep-1')],
  ];

  it.each(rows)('%s', async (_name, method, path, run) => {
    // A path-only route: the shared notes module owns response shaping and has
    // its own specs. What this pins is that the matter wrapper reaches the
    // right verb on the right route under the right matter.
    const register = { GET: api.get, POST: api.post, PUT: api.put, DELETE: api.delete }[method]!;
    register(path, { status: 422, body: { error: 'stop here' } });

    await expect(run()).rejects.toThrow('stop here');

    const call = onlyCall(method);
    expect(call.pathname).toBe(path);
  });
});

describe('note links and client updates', () => {
  const NOTE = `${MATTER}/notes/note-1`;

  it('creates a task from a note with exactly the task fields', async () => {
    api.postExact(`${NOTE}/tasks`, { taskId: 'task-1', link: { id: 'link-1' } });

    const result = await mattersService.createTaskFromNote(LAW_FIRM_ID, MATTER_ID, 'note-1', { title: 'Follow up', dueDate: '2026-04-01' });

    expect(onlyCall('POST').body).toEqual({ title: 'Follow up', dueDate: '2026-04-01' });
    expect(result).toEqual({ taskId: 'task-1', link: { id: 'link-1' } });
  });

  it('links an existing task and an existing file on their own routes', async () => {
    api.postExact(`${NOTE}/links/task`, { link: { id: 'l-t' } });
    api.postExact(`${NOTE}/links/file`, { link: { id: 'l-f' } });

    await expect(mattersService.linkTaskToNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 'task-1')).resolves.toEqual({ link: { id: 'l-t' } });
    await expect(mattersService.linkFileToNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 'files/a.pdf')).resolves.toEqual({ link: { id: 'l-f' } });

    const [taskCall, fileCall] = api.calls('POST');
    expect(taskCall.body).toEqual({ taskId: 'task-1' });
    expect(fileCall.body).toEqual({ fileId: 'files/a.pdf' });
  });

  it('removes one link by id', async () => {
    api.deleteExact(`${NOTE}/links/link-1`, { message: 'removed' });

    await expect(mattersService.unlinkFromNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 'link-1')).resolves.toEqual({ message: 'removed' });
  });

  it('sends a client update with exactly the message and recipients', async () => {
    api.postExact(`${NOTE}/client-update`, { message: 'sent', conversationId: 'conv-1' });

    const result = await mattersService.sendNoteAsClientUpdate(LAW_FIRM_ID, MATTER_ID, 'note-1', {
      message: 'Hearing moved', recipientClientIds: ['client-7'],
    });

    expect(onlyCall('POST').body).toEqual({ message: 'Hearing moved', recipientClientIds: ['client-7'] });
    expect(result).toEqual({ message: 'sent', conversationId: 'conv-1' });
  });

  it.each([
    ['createTaskFromNote', 'post', `${NOTE}/tasks`, () => mattersService.createTaskFromNote(LAW_FIRM_ID, MATTER_ID, 'note-1', {}), 'Failed to create task'],
    ['linkTaskToNote', 'post', `${NOTE}/links/task`, () => mattersService.linkTaskToNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 't'), 'Failed to link task'],
    ['linkFileToNote', 'post', `${NOTE}/links/file`, () => mattersService.linkFileToNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 'f'), 'Failed to link document'],
    ['unlinkFromNote', 'delete', `${NOTE}/links/link-1`, () => mattersService.unlinkFromNote(LAW_FIRM_ID, MATTER_ID, 'note-1', 'link-1'), 'Failed to remove link'],
    ['sendNoteAsClientUpdate', 'post', `${NOTE}/client-update`, () => mattersService.sendNoteAsClientUpdate(LAW_FIRM_ID, MATTER_ID, 'note-1', { message: 'm' }), 'Failed to send client update'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, method, path, run, message) => {
    ({ post: api.postExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});

describe('the clients on a matter', () => {
  it('lists one matter clients from the envelope', async () => {
    api.getExact(`${MATTER}/clients`, { clients: [{ id: 'client-7', billingPortionBp: 10000 }] });

    await expect(mattersService.listClients(LAW_FIRM_ID, MATTER_ID))
      .resolves.toEqual([{ id: 'client-7', billingPortionBp: 10000 }]);
  });

  it('returns no clients for an envelope with no clients key', async () => {
    api.getExact(`${MATTER}/clients`, {});

    await expect(mattersService.listClients(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual([]);
  });

  it('sends no request for an empty or blank id list', async () => {
    await expect(mattersService.listClientsForMatters(LAW_FIRM_ID, ['', ''])).resolves.toEqual({});
    expect(api.calls()).toHaveLength(0);
  });

  it('dedupes the ids, chunks at 100, sends the chunks in order and merges the maps', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `m-${i}`);
    api.get(`${MATTERS}/clients`, (call) => {
      const chunk = new URL(call.url).searchParams.get('matterIds')!.split(',');
      return { clientsByMatterId: Object.fromEntries(chunk.map((id) => [id, [{ id: `c-${id}` }]])) };
    });

    const map = await mattersService.listClientsForMatters(LAW_FIRM_ID, [...ids, 'm-0']);

    const chunks = api.calls('GET').map((c) => new URL(c.url).searchParams.get('matterIds')!.split(','));
    expect(chunks).toEqual([ids.slice(0, 100), ['m-100']]);
    expect(Object.keys(map)).toHaveLength(101);
    expect(map['m-100']).toEqual([{ id: 'c-m-100' }]);
  });

  it('PUTs a billing split in basis points exactly as given', async () => {
    api.putExact(`${MATTER}/clients/billing-portions`, { message: 'ok', clients: [] });

    await mattersService.setClientBillingPortions(LAW_FIRM_ID, MATTER_ID, { 'client-7': 3333, 'client-8': 6667 });

    // Basis points, integers that must total 10000. A percent here (33.33)
    // would be read as a third of a percent.
    expect(onlyCall('PUT').body).toEqual({ portions: { 'client-7': 3333, 'client-8': 6667 } });
  });

  it('adds a client wrapped in a client key', async () => {
    api.postExact(`${MATTER}/clients`, { message: 'ok', clientId: 'client-9' });

    const result = await mattersService.addClient({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, client: { clientId: 'client-9' } } as never);

    expect(onlyCall('POST').body).toEqual({ client: { clientId: 'client-9' } });
    expect(result).toEqual({ message: 'ok', clientId: 'client-9' });
  });

  it('removes one client from the matter by id', async () => {
    api.deleteExact(`${MATTER}/clients/client-7`, { message: 'removed' });

    await expect(mattersService.removeClient({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, clientId: 'client-7' } as never))
      .resolves.toEqual({ message: 'removed' });
  });

  it('throws the server reason when a client removal is refused', async () => {
    api.deleteExact(`${MATTER}/clients/client-7`, { status: 409, body: { error: 'Client has invoices on this matter' } });

    const error = await rejectionOf(mattersService.removeClient({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, clientId: 'client-7' } as never));
    expect(error.message).toBe('Client has invoices on this matter');
  });
});

describe('client profiles read through the matter service', () => {
  const CLIENT = `/api/lawfirms/${LAW_FIRM_ID}/clients/client-7`;

  it('returns the profile body as is', async () => {
    api.getExact(CLIENT, { id: 'client-7', name: 'Acme Holdings' });

    await expect(mattersService.getClientProfile(LAW_FIRM_ID, 'client-7')).resolves.toEqual({ id: 'client-7', name: 'Acme Holdings' });
  });

  it('returns null for a client that does not exist', async () => {
    api.getExact(CLIENT, { status: 404, body: { error: 'Client not found' } });

    await expect(mattersService.getClientProfile(LAW_FIRM_ID, 'client-7')).resolves.toBeNull();
    expect(api.calls('GET')).toHaveLength(1);
  });

  it('rethrows any other failure', async () => {
    api.getExact(CLIENT, { status: 500, body: { error: 'Database unavailable' } });

    const error = await rejectionOf(mattersService.getClientProfile(LAW_FIRM_ID, 'client-7'));
    expect(error.status).toBe(500);
  });

  it('reads many profiles in one deduped batch keyed by id', async () => {
    api.getExact(`/api/lawfirms/${LAW_FIRM_ID}/clients?ids=client-7,client-8`, {
      clients: [{ id: 'client-7', name: 'A' }, { id: 'client-8', name: 'B' }, { name: 'no id' }],
    });

    const byId = await mattersService.getClientProfilesByIds(LAW_FIRM_ID, ['client-7', 'client-8', 'client-7', '']);

    expect(byId).toEqual({ 'client-7': { id: 'client-7', name: 'A' }, 'client-8': { id: 'client-8', name: 'B' } });
  });

  it('sends no request for an empty id list', async () => {
    await expect(mattersService.getClientProfilesByIds(LAW_FIRM_ID, [])).resolves.toEqual({});
    expect(api.calls()).toHaveLength(0);
  });

  it('PUTs a profile edit as the bare client object', async () => {
    api.putExact(CLIENT, { message: 'ok' });

    await mattersService.updateClientProfile({ lawFirmId: LAW_FIRM_ID, clientId: 'client-7', client: { phone: '555-0100' } } as never);

    expect(onlyCall('PUT').body).toEqual({ phone: '555-0100' });
  });
});

describe('conflicts', () => {
  it('POSTs the names, emails and organizations to check and returns the verdict', async () => {
    const verdict = { hasConflicts: true, conflicts: [{ name: 'Acme', matterId: 'm-2' }] };
    api.postExact(`${MATTERS}/conflict-check`, verdict);

    const params = { names: ['Jane Roe'], emails: ['jane@roe.test'], organizations: ['Acme'], excludeClientIds: ['client-7'] };
    const result = await mattersService.checkConflicts(LAW_FIRM_ID, params);

    expect(onlyCall('POST').body).toEqual(params);
    expect(result).toEqual(verdict);
  });

  it('throws its own message when the check is refused with no reason', async () => {
    api.postExact(`${MATTERS}/conflict-check`, { status: 422, body: {} });

    const error = await rejectionOf(mattersService.checkConflicts(LAW_FIRM_ID, {}));
    expect(error.message).toBe('Conflict check failed');
  });

  it('lists the stored checks for a matter', async () => {
    api.getExact(`${MATTER}/conflict-checks`, { conflictChecks: [{ id: 'cc-1' }] });

    await expect(mattersService.listConflictChecks(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual([{ id: 'cc-1' }]);
  });

  it('re-runs the check with a bodiless POST', async () => {
    api.postExact(`${MATTER}/conflict-checks/run`, { conflictChecks: [] });

    await mattersService.rerunConflictCheck(LAW_FIRM_ID, MATTER_ID);

    const call = onlyCall('POST');
    expect(call.body).toBeNull();
    expect(call.headers['content-type']).toBeUndefined();
  });
});

describe('related contacts on a matter', () => {
  it('lists the contacts, empty for a bare envelope', async () => {
    api.getExact(`${MATTER}/contacts`, {});

    await expect(mattersService.listContacts(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual([]);
  });

  it('creates, updates and unlinks by link id on the contacts sub-route', async () => {
    api.postExact(`${MATTER}/contacts`, { contact: { id: 'link-1' } });
    api.putExact(`${MATTER}/contacts/link-1`, { contact: { id: 'link-1', role: 'Witness' } });
    api.deleteExact(`${MATTER}/contacts/link-1`, { message: 'removed' });

    await mattersService.createContact(LAW_FIRM_ID, MATTER_ID, { contactId: 'ct-1', role: 'Expert' } as never);
    const updated = await mattersService.updateContact(LAW_FIRM_ID, MATTER_ID, 'link-1', { role: 'Witness' } as never);
    await mattersService.deleteContact(LAW_FIRM_ID, MATTER_ID, 'link-1');

    expect(onlyCall('POST').body).toEqual({ contactId: 'ct-1', role: 'Expert' });
    expect(onlyCall('PUT').body).toEqual({ role: 'Witness' });
    expect(updated).toEqual({ contact: { id: 'link-1', role: 'Witness' } });
    expect(onlyCall('DELETE').pathname).toBe(`${MATTER}/contacts/link-1`);
  });
});

describe('the matter activity feed', () => {
  it('sends the window and repeats type once per filter', async () => {
    api.getExact(`${MATTER}/activity?limit=20&offset=40&type=note&type=status`, { activity: [{ id: 'a-1' }], totalItems: 61 });

    const page = await mattersService.listActivity(LAW_FIRM_ID, MATTER_ID, { limit: 20, offset: 40, activityTypes: ['note', 'status'] });

    expect(page).toEqual({ activity: [{ id: 'a-1' }], totalItems: 61 });
  });

  it('falls back to the row count, then zero, for the total', async () => {
    api.getExact(`${MATTER}/activity`, { activity: [{ id: 'a-1' }, { id: 'a-2' }] });

    await expect(mattersService.listActivity(LAW_FIRM_ID, MATTER_ID)).resolves.toEqual({
      activity: [{ id: 'a-1' }, { id: 'a-2' }], totalItems: 2,
    });
  });
});

describe('firm matter configuration', () => {
  const FIELD_DEFS = `/api/lawfirms/${LAW_FIRM_ID}/matter-field-defs`;
  const STAGES = `/api/lawfirms/${LAW_FIRM_ID}/matter-stages`;
  const PIPELINES = `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines`;

  it('lists custom fields, archived ones only when asked', async () => {
    api.getExact(`${FIELD_DEFS}?includeArchived=true`, { fieldDefs: [{ id: 'fd-1' }] });

    await expect(mattersService.listFieldDefs(LAW_FIRM_ID, true)).resolves.toEqual([{ id: 'fd-1' }]);
  });

  it('lists active custom fields with no query, empty for a bare envelope', async () => {
    api.getExact(FIELD_DEFS, {});

    await expect(mattersService.listFieldDefs(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('creates, updates and deletes a custom field on its own routes', async () => {
    api.postExact(FIELD_DEFS, { fieldDef: { id: 'fd-1' } });
    api.putExact(`${FIELD_DEFS}/fd-1`, { fieldDef: { id: 'fd-1', label: 'Court' } });
    api.deleteExact(`${FIELD_DEFS}/fd-1`, { message: 'deleted' });

    await mattersService.createFieldDef(LAW_FIRM_ID, { label: 'Court', fieldType: 'text' } as never);
    await mattersService.updateFieldDef(LAW_FIRM_ID, 'fd-1', { label: 'Court' } as never);
    await expect(mattersService.deleteFieldDef(LAW_FIRM_ID, 'fd-1')).resolves.toEqual({ message: 'deleted' });

    expect(onlyCall('POST').body).toEqual({ label: 'Court', fieldType: 'text' });
    expect(onlyCall('PUT').body).toEqual({ label: 'Court' });
  });

  it('creates, updates and deletes a stage on its own routes', async () => {
    api.postExact(STAGES, { stage: { id: 's-1' } });
    api.putExact(`${STAGES}/s-1`, { stage: { id: 's-1' } });
    api.deleteExact(`${STAGES}/s-1`, { message: 'deleted' });

    await mattersService.createStage(LAW_FIRM_ID, { name: 'Discovery' } as never);
    await mattersService.updateStage(LAW_FIRM_ID, 's-1', { sortOrder: 2 } as never);
    await mattersService.deleteStage(LAW_FIRM_ID, 's-1');

    expect(onlyCall('POST').body).toEqual({ name: 'Discovery' });
    expect(onlyCall('PUT').body).toEqual({ sortOrder: 2 });
    expect(onlyCall('DELETE').pathname).toBe(`${STAGES}/s-1`);
  });

  it('lists pipelines, empty for a bare envelope', async () => {
    api.getExact(PIPELINES, {});

    await expect(mattersService.listPipelines(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('creates a pipeline with its stages exactly as given', async () => {
    api.postExact(PIPELINES, { pipeline: { id: 'p-1' } });

    const pipeline = {
      name: 'Litigation',
      practiceAreaId: null,
      isDefault: false,
      stages: [{ clientId: 'tmp-1', name: 'Intake', color: null, sortOrder: 0, isClosed: false, parentClientId: null }],
    };
    await mattersService.createPipeline(LAW_FIRM_ID, pipeline);

    expect(onlyCall('POST').body).toEqual(pipeline);
  });

  it('updates and deletes a pipeline by id', async () => {
    api.putExact(`${PIPELINES}/p-1`, { pipeline: { id: 'p-1', isDefault: true } });
    api.deleteExact(`${PIPELINES}/p-1`, { message: 'deleted' });

    await mattersService.updatePipeline(LAW_FIRM_ID, 'p-1', { isDefault: true });
    await mattersService.deletePipeline(LAW_FIRM_ID, 'p-1');

    expect(onlyCall('PUT').body).toEqual({ isDefault: true });
    expect(onlyCall('DELETE').pathname).toBe(`${PIPELINES}/p-1`);
  });
});

describe('matter categories', () => {
  it('lists the flat list and the tree from their own routes', async () => {
    api.getExact(`${MATTERS}/categories`, { categories: [{ id: 'cat-1' }] });
    api.getExact(`${MATTERS}/categories/tree`, { categories: [{ id: 'cat-1', children: [] }] });

    await expect(mattersService.listCategories(LAW_FIRM_ID)).resolves.toEqual([{ id: 'cat-1' }]);
    await expect(mattersService.listCategoriesTree(LAW_FIRM_ID)).resolves.toEqual([{ id: 'cat-1', children: [] }]);
  });

  it('returns no categories for a bare envelope', async () => {
    api.getExact(`${MATTERS}/categories`, {});
    api.getExact(`${MATTERS}/categories/tree`, {});

    await expect(mattersService.listCategories(LAW_FIRM_ID)).resolves.toEqual([]);
    await expect(mattersService.listCategoriesTree(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('creates a top-level category with an explicit null parent', async () => {
    api.postExact(`${MATTERS}/categories`, { message: 'ok', category: { id: 'cat-2' } });

    await mattersService.createCategory(LAW_FIRM_ID, 'Estates', '');

    // `parentId || null`: an empty string from a cleared select becomes null,
    // not a parent id of "".
    expect(onlyCall('POST').body).toEqual({ name: 'Estates', parentId: null });
  });

  it('creates a child category under its parent', async () => {
    api.postExact(`${MATTERS}/categories`, { message: 'ok', category: { id: 'cat-3' } });

    await mattersService.createCategory(LAW_FIRM_ID, 'Probate', 'cat-2');

    expect(onlyCall('POST').body).toEqual({ name: 'Probate', parentId: 'cat-2' });
  });

  it('updates and deletes a category by id', async () => {
    api.putExact(`${MATTERS}/categories/cat-2`, { message: 'ok', category: { id: 'cat-2' } });
    api.deleteExact(`${MATTERS}/categories/cat-2`, { message: 'deleted' });

    await mattersService.updateCategory(LAW_FIRM_ID, 'cat-2', { order: 3 });
    await expect(mattersService.deleteCategory(LAW_FIRM_ID, 'cat-2')).resolves.toEqual({ message: 'deleted' });

    expect(onlyCall('PUT').body).toEqual({ order: 3 });
  });

  it.each([
    ['listCategories', 'get', `${MATTERS}/categories`, () => mattersService.listCategories(LAW_FIRM_ID)],
    ['listCategoriesTree', 'get', `${MATTERS}/categories/tree`, () => mattersService.listCategoriesTree(LAW_FIRM_ID)],
    ['createCategory', 'post', `${MATTERS}/categories`, () => mattersService.createCategory(LAW_FIRM_ID, 'x')],
    ['updateCategory', 'put', `${MATTERS}/categories/cat-2`, () => mattersService.updateCategory(LAW_FIRM_ID, 'cat-2', {})],
    ['deleteCategory', 'delete', `${MATTERS}/categories/cat-2`, () => mattersService.deleteCategory(LAW_FIRM_ID, 'cat-2')],
  ] as const)('%s throws the server reason on a refusal', async (_name, method, path, run) => {
    ({ get: api.getExact, post: api.postExact, put: api.putExact, delete: api.deleteExact })[method](
      path, { status: 409, body: { error: 'Category is in use' } },
    );

    const error = await rejectionOf(run());
    expect(error.message).toBe('Category is in use');
    expect(error.status).toBe(409);
  });
});

describe('a mutation refused with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'post' | 'put' | 'patch' | 'delete', string, () => Promise<unknown>, string]> = [
    ['updateMatter', 'put', MATTER, () => mattersService.updateMatter({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID } as never), 'Failed to update matter'],
    ['updatePracticeArea', 'post', `${MATTER}/update-practice-area`, () => mattersService.updatePracticeArea({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, practiceAreaId: 'p' }), 'Failed to update practice area'],
    ['addMembers', 'post', `${MATTER}/members`, () => mattersService.addMembers({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, targetUserIds: [] }), 'Failed to add members'],
    ['removeMembers', 'post', `${MATTER}/members/remove`, () => mattersService.removeMembers({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, targetUserIds: [] }), 'Failed to remove members'],
    ['updateMemberHourlyRate', 'put', `${MATTER}/members/hourly-rate`, () => mattersService.updateMemberHourlyRate({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, userId: 'u', hourlyRate: 1 }), 'Failed to update hourly rate'],
    ['previewBulkAddMember', 'post', `${MATTERS}/bulk-add-member/preview`, () => mattersService.previewBulkAddMember({ lawFirmId: LAW_FIRM_ID, userId: 'u', matterIds: [] }), 'Failed to preview bulk assign member'],
    ['bulkAddMember', 'post', `${MATTERS}/bulk-add-member`, () => mattersService.bulkAddMember({ lawFirmId: LAW_FIRM_ID, userId: 'u', matterIds: [] }), 'Failed to bulk assign member'],
    ['setClientBillingPortions', 'put', `${MATTER}/clients/billing-portions`, () => mattersService.setClientBillingPortions(LAW_FIRM_ID, MATTER_ID, {}), 'Failed to update the billing split'],
    ['addClient', 'post', `${MATTER}/clients`, () => mattersService.addClient({ lawFirmId: LAW_FIRM_ID, matterId: MATTER_ID, client: {} } as never), 'Failed to add client'],
    ['updateClientProfile', 'put', `/api/lawfirms/${LAW_FIRM_ID}/clients/client-7`, () => mattersService.updateClientProfile({ lawFirmId: LAW_FIRM_ID, clientId: 'client-7', client: {} } as never), 'Failed to update client profile'],
    ['setLegalHold', 'patch', `${MATTER}/legal-hold`, () => mattersService.setLegalHold(LAW_FIRM_ID, MATTER_ID, false), 'Failed to update legal hold'],
    ['rerunConflictCheck', 'post', `${MATTER}/conflict-checks/run`, () => mattersService.rerunConflictCheck(LAW_FIRM_ID, MATTER_ID), 'Failed to run conflict check'],
    ['createContact', 'post', `${MATTER}/contacts`, () => mattersService.createContact(LAW_FIRM_ID, MATTER_ID, {}), 'Failed to add contact'],
    ['updateContact', 'put', `${MATTER}/contacts/link-1`, () => mattersService.updateContact(LAW_FIRM_ID, MATTER_ID, 'link-1', {}), 'Failed to update contact'],
    ['deleteContact', 'delete', `${MATTER}/contacts/link-1`, () => mattersService.deleteContact(LAW_FIRM_ID, MATTER_ID, 'link-1'), 'Failed to remove contact'],
    ['createFieldDef', 'post', `/api/lawfirms/${LAW_FIRM_ID}/matter-field-defs`, () => mattersService.createFieldDef(LAW_FIRM_ID, {}), 'Failed to create custom field'],
    ['updateFieldDef', 'put', `/api/lawfirms/${LAW_FIRM_ID}/matter-field-defs/fd-1`, () => mattersService.updateFieldDef(LAW_FIRM_ID, 'fd-1', {}), 'Failed to update custom field'],
    ['deleteFieldDef', 'delete', `/api/lawfirms/${LAW_FIRM_ID}/matter-field-defs/fd-1`, () => mattersService.deleteFieldDef(LAW_FIRM_ID, 'fd-1'), 'Failed to delete custom field'],
    ['createStage', 'post', `/api/lawfirms/${LAW_FIRM_ID}/matter-stages`, () => mattersService.createStage(LAW_FIRM_ID, {}), 'Failed to create stage'],
    ['updateStage', 'put', `/api/lawfirms/${LAW_FIRM_ID}/matter-stages/s-1`, () => mattersService.updateStage(LAW_FIRM_ID, 's-1', {}), 'Failed to update stage'],
    ['deleteStage', 'delete', `/api/lawfirms/${LAW_FIRM_ID}/matter-stages/s-1`, () => mattersService.deleteStage(LAW_FIRM_ID, 's-1'), 'Failed to delete stage'],
    ['createPipeline', 'post', `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines`, () => mattersService.createPipeline(LAW_FIRM_ID, { name: 'n', practiceAreaId: null, isDefault: false, stages: [] }), 'Failed to create pipeline'],
    ['updatePipeline', 'put', `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines/p-1`, () => mattersService.updatePipeline(LAW_FIRM_ID, 'p-1', {}), 'Failed to update pipeline'],
    ['deletePipeline', 'delete', `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines/p-1`, () => mattersService.deletePipeline(LAW_FIRM_ID, 'p-1'), 'Failed to delete pipeline'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ post: api.postExact, put: api.putExact, patch: api.patchExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});
