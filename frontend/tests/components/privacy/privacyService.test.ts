/**
 * The privacy and data-subject rights service, tested OFFLINE against a fake transport.
 *
 * Unmocks privacy.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, request body construction, tenant and client scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/privacy.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import privacyService from '@/services/privacy.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-42';

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

describe('privacyService.acceptTerms', () => {
  it('posts to /api/privacy/accept-terms with empty body when version omitted', async () => {
    api.post('/api/privacy/accept-terms', {
      message: 'Terms accepted',
      consentVersion: 'v1.0',
    });

    const res = await privacyService.acceptTerms();

    expect(res.consentVersion).toBe('v1.0');
    const call = api.calls('POST')[0];
    expect(call.url).toBe('http://localhost:5001/api/privacy/accept-terms');
    expect(bodyOf(call)).toEqual({});
  });

  it('posts explicit consent version in payload', async () => {
    api.post('/api/privacy/accept-terms', {
      message: 'Terms accepted',
      consentVersion: '2026-09-01',
    });

    const res = await privacyService.acceptTerms('2026-09-01');

    expect(res.consentVersion).toBe('2026-09-01');
    const call = api.calls('POST')[0];
    expect(bodyOf(call)).toEqual({ version: '2026-09-01' });
  });

  it('surfaces ApiError when accept-terms fails', async () => {
    api.post('/api/privacy/accept-terms', {
      status: 400,
      body: { error: 'Invalid terms version' },
    });

    await expect(privacyService.acceptTerms('invalid'))
      .rejects
      .toThrow(ApiError);
  });
});

describe('privacyService.exportMyData', () => {
  it('sends GET to /api/privacy/me/export and returns archive json', async () => {
    api.get('/api/privacy/me/export', {
      exportedAt: '2026-09-01T00:00:00Z',
      user: { id: 'u-1', email: 'user@example.test' },
      activity: [],
    });

    const res = await privacyService.exportMyData();

    expect(res.exportedAt).toBe('2026-09-01T00:00:00Z');
    const call = api.calls('GET')[0];
    expect(call.url).toBe('http://localhost:5001/api/privacy/me/export');
  });

  it('surfaces ApiError when self-export is refused', async () => {
    api.get('/api/privacy/me/export', {
      status: 403,
      body: { error: 'Export not permitted' },
    });

    await expect(privacyService.exportMyData())
      .rejects
      .toThrow(ApiError);
  });
});

describe('privacyService.eraseMyAccount', () => {
  it('sends DELETE to /api/privacy/me and returns erase confirmation', async () => {
    api.delete('/api/privacy/me', {
      message: 'Account erasure scheduled',
      erasedAt: '2026-09-01T00:00:00Z',
    });

    const res = await privacyService.eraseMyAccount();

    expect(res.message).toBe('Account erasure scheduled');
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe('http://localhost:5001/api/privacy/me');
  });

  it('surfaces ApiError when account erasure is refused by active firm ownership', async () => {
    api.delete('/api/privacy/me', {
      status: 400,
      body: { error: 'Transfer firm ownership before requesting erasure' },
    });

    await expect(privacyService.eraseMyAccount())
      .rejects
      .toThrow(ApiError);
  });
});

describe('privacyService.exportClientData', () => {
  it('sends GET to /api/lawfirms/:firmId/clients/:clientId/data-export', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/data-export`, {
      exportedAt: '2026-09-01T00:00:00Z',
      client: { id: CLIENT_ID, name: 'Protected Client' },
      matters: [],
    });

    const res = await privacyService.exportClientData(LAW_FIRM_ID, CLIENT_ID);

    expect(res.exportedAt).toBe('2026-09-01T00:00:00Z');
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/data-export`);
  });

  it('surfaces ApiError when client export is forbidden', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/data-export`, {
      status: 403,
      body: { error: 'Missing permission to export client data' },
    });

    await expect(privacyService.exportClientData(LAW_FIRM_ID, CLIENT_ID))
      .rejects
      .toThrow(ApiError);
  });
});

describe('privacyService.eraseClient', () => {
  it('sends POST to /api/lawfirms/:firmId/clients/:clientId/erase', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/erase`, {
      message: 'Client erased successfully',
      clientId: CLIENT_ID,
    });

    const res = await privacyService.eraseClient(LAW_FIRM_ID, CLIENT_ID);

    expect(res.clientId).toBe(CLIENT_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/erase`);
    expect(bodyOf(call)).toEqual({});
  });

  it('surfaces ApiError when client erasure is refused by legal hold', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/erase`, {
      status: 409,
      body: { error: 'Client is under an active legal hold' },
    });

    await expect(privacyService.eraseClient(LAW_FIRM_ID, CLIENT_ID))
      .rejects
      .toThrow(ApiError);
  });
});
