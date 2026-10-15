/**
 * The document requests service, tested OFFLINE against a fake transport.
 *
 * Unmocks documentRequests.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, query-parameter construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/documentRequests.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import documentRequestsService from '@/services/documentRequests.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const MATTER_ID = 'matter-10';
const CLIENT_ID = 'client-20';
const REQUEST_ID = 'req-30';
const ITEM_ID = 'item-40';
const FULFILLMENT_ID = 'ful-50';

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

describe('documentRequestsService.list', () => {
  it('requests document requests scoped to matter with pagination parameters', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/document-requests`, {
      requests: [{ id: REQUEST_ID, title: 'W2 Forms', status: 'open' }],
      totalRequests: 1,
    });

    const res = await documentRequestsService.list(LAW_FIRM_ID, MATTER_ID, {
      page: 2,
      limit: 10,
    });

    expect(res.requests).toHaveLength(1);
    expect(res.requests[0].id).toBe(REQUEST_ID);
    expect(res.totalRequests).toBe(1);

    const call = api.calls('GET')[0];
    const params = paramsOf(call.url);
    expect(params.get('matterId')).toBe(MATTER_ID);
    expect(params.get('page')).toBe('2');
    expect(params.get('limit')).toBe('10');
  });

  it('scopes request to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/document-requests`, {
      requests: [],
      totalRequests: 0,
    });

    await documentRequestsService.list(OTHER_FIRM_ID, MATTER_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/document-requests`);
  });
});

describe('documentRequestsService.listForClient', () => {
  it('requests all requests addressed to a client across matters', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/clients/${CLIENT_ID}`, {
      requests: [{ id: REQUEST_ID, title: 'Client Documents', status: 'open' }],
    });

    const res = await documentRequestsService.listForClient(LAW_FIRM_ID, CLIENT_ID);

    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(REQUEST_ID);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/clients/${CLIENT_ID}`);
  });
});

describe('documentRequestsService.create', () => {
  it('posts payload to create a document request and returns request', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/document-requests`, {
      request: { id: REQUEST_ID, title: 'Bank Statements', clientId: CLIENT_ID },
    });

    const res = await documentRequestsService.create(LAW_FIRM_ID, {
      clientId: CLIENT_ID,
      matterId: MATTER_ID,
      title: 'Bank Statements',
      items: [{ label: 'Jan 2026 statement' }],
    });

    expect(res.id).toBe(REQUEST_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests`);
    expect(bodyOf(call)).toMatchObject({
      clientId: CLIENT_ID,
      matterId: MATTER_ID,
      title: 'Bank Statements',
    });
  });

  it('surfaces ApiError when create is rejected', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/document-requests`, {
      status: 400,
      body: { error: 'Client id is required' },
    });

    await expect(
      documentRequestsService.create(LAW_FIRM_ID, { clientId: '', title: 'Test' })
    ).rejects.toThrow(ApiError);
  });
});

describe('documentRequestsService.update', () => {
  it('sends PATCH with updated details and returns modified request', async () => {
    api.patch(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}`, {
      request: { id: REQUEST_ID, title: 'Updated Title', status: 'completed' },
    });

    const res = await documentRequestsService.update(LAW_FIRM_ID, REQUEST_ID, {
      title: 'Updated Title',
      status: 'completed',
    });

    expect(res.title).toBe('Updated Title');
    const call = api.calls('PATCH')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}`);
    expect(bodyOf(call)).toMatchObject({ title: 'Updated Title', status: 'completed' });
  });

  it('surfaces ApiError when update is rejected', async () => {
    api.patch(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}`, {
      status: 404,
      body: { error: 'Document request not found' },
    });

    await expect(
      documentRequestsService.update(LAW_FIRM_ID, REQUEST_ID, { title: 'Ghost' })
    ).rejects.toThrow(ApiError);
  });
});

describe('documentRequestsService.remove', () => {
  it('sends DELETE to remove a request and returns message', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}`, {
      message: 'Document request deleted',
      requestId: REQUEST_ID,
    });

    const res = await documentRequestsService.remove(LAW_FIRM_ID, REQUEST_ID);

    expect(res.requestId).toBe(REQUEST_ID);
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}`);
  });
});

describe('documentRequestsService item mutations', () => {
  it('setItemStatus sends PATCH with new status', async () => {
    api.patch(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}`, {
      request: { id: REQUEST_ID, items: [{ id: ITEM_ID, status: 'received' }] },
    });

    const res = await documentRequestsService.setItemStatus(LAW_FIRM_ID, REQUEST_ID, ITEM_ID, 'received');

    expect(res.id).toBe(REQUEST_ID);
    const call = api.calls('PATCH')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}`);
    expect(bodyOf(call)).toEqual({ status: 'received' });
  });

  it('linkFile sends POST with the file id to attach a document the firm holds', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}/link-file`, {
      request: { id: REQUEST_ID, items: [{ id: ITEM_ID, status: 'received' }] },
    });

    const res = await documentRequestsService.linkFile(
      LAW_FIRM_ID,
      REQUEST_ID,
      ITEM_ID,
      'a1b2c3d4-0000-4000-8000-000000000001'
    );

    expect(res.id).toBe(REQUEST_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}/link-file`);
    expect(bodyOf(call)).toEqual({ fileId: 'a1b2c3d4-0000-4000-8000-000000000001' });
  });

  it('unlinkFile sends DELETE to remove linked fulfillment', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}/files/${FULFILLMENT_ID}`, {
      request: { id: REQUEST_ID, items: [{ id: ITEM_ID, fulfillments: [] }] },
    });

    const res = await documentRequestsService.unlinkFile(
      LAW_FIRM_ID,
      REQUEST_ID,
      ITEM_ID,
      FULFILLMENT_ID
    );

    expect(res.id).toBe(REQUEST_ID);
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-requests/${REQUEST_ID}/items/${ITEM_ID}/files/${FULFILLMENT_ID}`);
  });
});
