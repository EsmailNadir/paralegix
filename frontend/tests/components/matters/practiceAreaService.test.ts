/**
 * The firm practice area service, tested OFFLINE against a fake transport.
 *
 * Unmocks practiceArea.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, payload construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import practiceAreaService from '@/services/practiceArea.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const PRACTICE_AREA_ID = 'pa-101';

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

describe('practiceAreaService.listPracticeAreas', () => {
  it('requests the firm practice areas list and unwraps practiceAreas array', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas`, {
      practiceAreas: [{ id: PRACTICE_AREA_ID, name: 'Immigration' }],
    });

    const res = await practiceAreaService.listPracticeAreas(LAW_FIRM_ID);

    expect(res.practiceAreas).toHaveLength(1);
    expect(res.practiceAreas[0].id).toBe(PRACTICE_AREA_ID);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/practice-areas`);
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/practice-areas`, {
      practiceAreas: [],
    });

    await practiceAreaService.listPracticeAreas(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/practice-areas`);
  });
});

describe('practiceAreaService.createPracticeArea', () => {
  it('posts name to /practice-areas and returns practiceArea object', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas`, {
      message: 'Practice area created',
      practiceArea: { id: PRACTICE_AREA_ID, name: 'Corporate Law' },
    });

    const res = await practiceAreaService.createPracticeArea(LAW_FIRM_ID, 'Corporate Law');

    expect(res.practiceArea.id).toBe(PRACTICE_AREA_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/practice-areas`);
    expect(bodyOf(call)).toEqual({ name: 'Corporate Law' });
  });

  it('surfaces ApiError when practice area creation is rejected', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas`, {
      status: 400,
      body: { error: 'Duplicate practice area name' },
    });

    await expect(
      practiceAreaService.createPracticeArea(LAW_FIRM_ID, 'Existing')
    ).rejects.toThrow(ApiError);
  });
});

describe('practiceAreaService.updatePracticeArea', () => {
  it('sends PUT to practice area url with updated name', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`, {
      message: 'Practice area updated',
    });

    const res = await practiceAreaService.updatePracticeArea(LAW_FIRM_ID, PRACTICE_AREA_ID, 'M&A');

    expect(res.message).toBe('Practice area updated');
    const call = api.calls('PUT')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`);
    expect(bodyOf(call)).toEqual({ name: 'M&A' });
  });

  it('surfaces ApiError when practice area not found', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`, {
      status: 404,
      body: { error: 'Practice area not found' },
    });

    await expect(
      practiceAreaService.updatePracticeArea(LAW_FIRM_ID, PRACTICE_AREA_ID, 'Ghost')
    ).rejects.toThrow(ApiError);
  });
});

describe('practiceAreaService.deletePracticeArea', () => {
  it('sends DELETE to practice area url', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`, {
      message: 'Practice area deleted',
    });

    const res = await practiceAreaService.deletePracticeArea(LAW_FIRM_ID, PRACTICE_AREA_ID);

    expect(res.message).toBe('Practice area deleted');
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`);
  });

  it('surfaces ApiError when delete is refused by active matters', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/practice-areas/${PRACTICE_AREA_ID}`, {
      status: 409,
      body: { error: 'Cannot delete practice area assigned to matters' },
    });

    await expect(
      practiceAreaService.deletePracticeArea(LAW_FIRM_ID, PRACTICE_AREA_ID)
    ).rejects.toThrow(ApiError);
  });
});
