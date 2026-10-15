/**
 * The deadline sets (event calculation templates) service, tested OFFLINE against a fake transport.
 *
 * Unmocks deadlineSets.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, request payloads, tenant and matter scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/deadlineSets.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import deadlineSetsService from '@/services/deadlineSets.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const MATTER_ID = 'matter-88';
const TEMPLATE_ID = 'ds-456';

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

describe('deadlineSetsService.list', () => {
  it('requests the firm deadline sets list', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets`, {
      deadlineSets: [
        { id: TEMPLATE_ID, name: 'Civil Litigation Discovery', items: [] },
      ],
    });

    const res = await deadlineSetsService.list(LAW_FIRM_ID);

    expect(res.deadlineSets).toHaveLength(1);
    expect(res.deadlineSets[0].id).toBe(TEMPLATE_ID);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/deadline-sets`);
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/deadline-sets`, {
      deadlineSets: [],
    });

    await deadlineSetsService.list(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/deadline-sets`);
  });
});

describe('deadlineSetsService.create', () => {
  it('posts payload to /deadline-sets and returns created response', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets`, {
      message: 'Deadline set created',
      deadlineSetId: TEMPLATE_ID,
      deadlineSet: { id: TEMPLATE_ID, name: 'Probate Schedule' },
    });

    const res = await deadlineSetsService.create(LAW_FIRM_ID, {
      name: 'Probate Schedule',
      adjustForWeekends: true,
      items: [{ title: 'File Inventory', type: 'filing_deadline', offsetDays: 60, offsetDirection: 'after' }],
    });

    expect(res.deadlineSetId).toBe(TEMPLATE_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/deadline-sets`);
    expect(bodyOf(call)).toMatchObject({ name: 'Probate Schedule', adjustForWeekends: true });
  });

  it('surfaces ApiError when create fails', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets`, {
      status: 400,
      body: { error: 'Validation failed' },
    });

    await expect(
      deadlineSetsService.create(LAW_FIRM_ID, { name: '', items: [] })
    ).rejects.toThrow(ApiError);
  });
});

describe('deadlineSetsService.update', () => {
  it('sends PUT to template url with update payload', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets/${TEMPLATE_ID}`, {
      message: 'Deadline set updated',
      deadlineSet: { id: TEMPLATE_ID, name: 'Renamed Schedule' },
    });

    const res = await deadlineSetsService.update(LAW_FIRM_ID, TEMPLATE_ID, {
      name: 'Renamed Schedule',
    });

    expect(res.deadlineSet.name).toBe('Renamed Schedule');
    const call = api.calls('PUT')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/deadline-sets/${TEMPLATE_ID}`);
    expect(bodyOf(call)).toEqual({ name: 'Renamed Schedule' });
  });

  it('surfaces ApiError when template does not exist', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets/${TEMPLATE_ID}`, {
      status: 404,
      body: { error: 'Template not found' },
    });

    await expect(
      deadlineSetsService.update(LAW_FIRM_ID, TEMPLATE_ID, { name: 'New' })
    ).rejects.toThrow(ApiError);
  });
});

describe('deadlineSetsService.remove', () => {
  it('sends DELETE to template url', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/deadline-sets/${TEMPLATE_ID}`, {
      message: 'Deadline set deleted',
      deadlineSetId: TEMPLATE_ID,
    });

    const res = await deadlineSetsService.remove(LAW_FIRM_ID, TEMPLATE_ID);

    expect(res.deadlineSetId).toBe(TEMPLATE_ID);
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/deadline-sets/${TEMPLATE_ID}`);
  });
});

describe('deadlineSetsService.apply', () => {
  it('posts anchorDate to matter deadline set apply endpoint', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}/deadline-sets/${TEMPLATE_ID}/apply`, {
      message: 'Deadline set applied',
      created: 3,
      events: [],
    });

    const res = await deadlineSetsService.apply(LAW_FIRM_ID, MATTER_ID, TEMPLATE_ID, '2026-09-15');

    expect(res.created).toBe(3);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}/deadline-sets/${TEMPLATE_ID}/apply`);
    expect(bodyOf(call)).toEqual({ anchorDate: '2026-09-15' });
  });

  it('surfaces ApiError when applying fails', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}/deadline-sets/${TEMPLATE_ID}/apply`, {
      status: 400,
      body: { error: 'Anchor date is invalid' },
    });

    await expect(
      deadlineSetsService.apply(LAW_FIRM_ID, MATTER_ID, TEMPLATE_ID, 'invalid-date')
    ).rejects.toThrow(ApiError);
  });
});
