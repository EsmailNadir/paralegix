/**
 * The firm courts service, tested OFFLINE against a fake transport.
 *
 * Unmocks courts.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, payload construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/courts.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import courtsService from '@/services/courts.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const COURT_ID = 'court-10';

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('courtsService.listCourts', () => {
  it('requests the firm courts list and unwraps courts array', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/courts`, {
      courts: [{ id: COURT_ID, name: 'Superior Court of San Francisco' }],
    });

    const res = await courtsService.listCourts(LAW_FIRM_ID);

    expect(res.courts).toHaveLength(1);
    expect(res.courts[0].id).toBe(COURT_ID);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/courts`);
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/courts`, {
      courts: [],
    });

    await courtsService.listCourts(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/courts`);
  });
});

describe('courtsService.createCourt', () => {
  it('posts court data to /courts and returns courtId', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/courts`, {
      message: 'Court created',
      courtId: COURT_ID,
    });

    const res = await courtsService.createCourt(LAW_FIRM_ID, {
      name: 'U.S. District Court',
      courtType: 'federal',
      city: 'San Francisco',
      state: 'CA',
    });

    expect(res.courtId).toBe(COURT_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/courts`);
    expect(bodyOf(call)).toMatchObject({ name: 'U.S. District Court', courtType: 'federal' });
  });

  it('surfaces ApiError when court creation fails', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/courts`, {
      status: 400,
      body: { error: 'Court name is required' },
    });

    await expect(
      courtsService.createCourt(LAW_FIRM_ID, { name: '' })
    ).rejects.toThrow(ApiError);
  });
});

describe('courtsService.updateCourt', () => {
  it('sends PUT to court url and returns mattersUpdated count', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`, {
      message: 'Court updated',
      mattersUpdated: 4,
    });

    const res = await courtsService.updateCourt(LAW_FIRM_ID, COURT_ID, {
      abbreviation: 'USDC-NDCA',
    });

    expect(res.mattersUpdated).toBe(4);
    const call = api.calls('PUT')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`);
    expect(bodyOf(call)).toEqual({ abbreviation: 'USDC-NDCA' });
  });

  it('surfaces ApiError when court not found', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`, {
      status: 404,
      body: { error: 'Court not found' },
    });

    await expect(
      courtsService.updateCourt(LAW_FIRM_ID, COURT_ID, { name: 'Nonexistent' })
    ).rejects.toThrow(ApiError);
  });
});

describe('courtsService.deleteCourt', () => {
  it('sends DELETE to court url', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`, {
      message: 'Court deleted',
    });

    const res = await courtsService.deleteCourt(LAW_FIRM_ID, COURT_ID);

    expect(res.message).toBe('Court deleted');
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`);
  });

  it('surfaces ApiError when court cannot be deleted because of matters', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/courts/${COURT_ID}`, {
      status: 409,
      body: { error: 'Cannot delete court assigned to active matters' },
    });

    await expect(
      courtsService.deleteCourt(LAW_FIRM_ID, COURT_ID)
    ).rejects.toThrow(ApiError);
  });
});
