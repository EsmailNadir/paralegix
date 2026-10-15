/**
 * The catalog service (Courts & UTBMS catalogs), tested OFFLINE against a fake transport.
 *
 * Unmocks catalog.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, search parameters, adoption payloads,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/catalog.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import catalogService from '@/services/catalog.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('catalogService.searchCourts', () => {
  it('requests courts catalog with filter query parameters', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/catalog/courts`, {
      items: [{ id: 'court-1', fullName: 'U.S. District Court Northern District of California' }],
      totalItems: 1,
    });

    const res = await catalogService.searchCourts(LAW_FIRM_ID, {
      search: 'District',
      state: 'CA',
      courtType: 'federal',
      jurisdiction: 'federal_district',
      limit: 20,
      offset: 0,
    });

    expect(res.items).toHaveLength(1);
    expect(res.totalItems).toBe(1);

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('search')).toBe('District');
    expect(params.get('state')).toBe('CA');
    expect(params.get('courtType')).toBe('federal');
    expect(params.get('jurisdiction')).toBe('federal_district');
    expect(params.get('limit')).toBe('20');
    expect(params.get('offset')).toBe('0');
  });

  it('scopes court search to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/catalog/courts`, {
      items: [],
      totalItems: 0,
    });

    await catalogService.searchCourts(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/catalog/courts`);
  });
});

describe('catalogService.adoptCourts', () => {
  it('posts catalogCourtIds to /adopt endpoint and returns adoption stats', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/catalog/courts/adopt`, {
      message: 'Courts adopted',
      requested: 2,
      adopted: 2,
      skipped: 0,
    });

    const res = await catalogService.adoptCourts(LAW_FIRM_ID, ['court-1', 'court-2']);

    expect(res.adopted).toBe(2);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/catalog/courts/adopt`);
    expect(bodyOf(call)).toEqual({ catalogCourtIds: ['court-1', 'court-2'] });
  });

  it('surfaces ApiError when adoption is rejected', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/catalog/courts/adopt`, {
      status: 403,
      body: { error: 'Missing permission to add courts' },
    });

    await expect(
      catalogService.adoptCourts(LAW_FIRM_ID, ['court-1'])
    ).rejects.toThrow(ApiError);
  });
});

describe('catalogService.listUtbms', () => {
  it('requests UTBMS codes filtered by codeType', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/catalog/utbms`, {
      utbmsCodes: [{ id: 'u-1', code: 'A101', name: 'Plan and prepare for', codeType: 'activity' }],
      totalItems: 1,
    });

    const res = await catalogService.listUtbms(LAW_FIRM_ID, 'activity');

    expect(res.utbmsCodes).toHaveLength(1);
    expect(res.utbmsCodes[0].code).toBe('A101');

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('codeType')).toBe('activity');
  });
});

describe('catalogService.adoptChargeCodes and adoptExpenseCategories', () => {
  it('posts utbmsCodeIds to charge-codes adopt endpoint', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/catalog/charge-codes/adopt`, {
      message: 'Charge codes adopted',
      requested: 1,
      adopted: 1,
      skipped: 0,
    });

    const res = await catalogService.adoptChargeCodes(LAW_FIRM_ID, ['u-task-1']);

    expect(res.adopted).toBe(1);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/catalog/charge-codes/adopt`);
    expect(bodyOf(call)).toEqual({ utbmsCodeIds: ['u-task-1'] });
  });

  it('posts utbmsCodeIds to expense-categories adopt endpoint', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/catalog/expense-categories/adopt`, {
      message: 'Expense categories adopted',
      requested: 1,
      adopted: 1,
      skipped: 0,
    });

    const res = await catalogService.adoptExpenseCategories(LAW_FIRM_ID, ['u-exp-1']);

    expect(res.adopted).toBe(1);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/catalog/expense-categories/adopt`);
    expect(bodyOf(call)).toEqual({ utbmsCodeIds: ['u-exp-1'] });
  });
});
