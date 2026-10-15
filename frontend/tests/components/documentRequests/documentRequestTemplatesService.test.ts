/**
 * The document request templates service, tested OFFLINE against a fake transport.
 *
 * Unmocks documentRequestTemplates.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, query-parameter construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/documentRequestTemplates.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import documentRequestTemplatesService from '@/services/documentRequestTemplates.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const TEMPLATE_ID = 'drt-123';

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

describe('documentRequestTemplatesService.list', () => {
  it('requests active templates without includeArchived query parameter by default', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates`, {
      templates: [
        { id: TEMPLATE_ID, name: 'Tax Checklist', defaultTitle: 'Tax Return', archived: false },
      ],
    });

    const res = await documentRequestTemplatesService.list(LAW_FIRM_ID);

    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(TEMPLATE_ID);
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-request-templates`);
  });

  it('appends includeArchived=true when requested', async () => {
    api.getExact(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates?includeArchived=true`, {
      templates: [
        { id: TEMPLATE_ID, name: 'Old Checklist', defaultTitle: 'Archived', archived: true },
      ],
    });

    const res = await documentRequestTemplatesService.list(LAW_FIRM_ID, true);

    expect(res).toHaveLength(1);
    expect(res[0].archived).toBe(true);
    const call = api.calls('GET')[0];
    expect(call.url).toContain('includeArchived=true');
  });

  it('scopes to the requested law firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/document-request-templates`, {
      templates: [],
    });

    await documentRequestTemplatesService.list(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/document-request-templates`);
  });
});

describe('documentRequestTemplatesService.create', () => {
  it('posts payload and returns created template object and templateId', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates`, {
      message: 'Template created',
      templateId: TEMPLATE_ID,
      template: { id: TEMPLATE_ID, name: 'New Preset', defaultTitle: 'Default' },
    });

    const res = await documentRequestTemplatesService.create(LAW_FIRM_ID, {
      name: 'New Preset',
      defaultTitle: 'Default',
      items: [{ label: 'Passport copy', description: 'Color copy' }],
    });

    expect(res.templateId).toBe(TEMPLATE_ID);
    expect(res.template.id).toBe(TEMPLATE_ID);
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-request-templates`);
    expect(bodyOf(call)).toMatchObject({ name: 'New Preset', defaultTitle: 'Default' });
  });

  it('surfaces ApiError when create is rejected', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates`, {
      status: 400,
      body: { error: 'Name is required' },
    });

    await expect(
      documentRequestTemplatesService.create(LAW_FIRM_ID, { name: '', defaultTitle: '' })
    ).rejects.toThrow(ApiError);
  });
});

describe('documentRequestTemplatesService.update', () => {
  it('sends PUT with partial update payload', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`, {
      message: 'Template updated',
      template: { id: TEMPLATE_ID, name: 'Renamed Preset' },
    });

    const res = await documentRequestTemplatesService.update(LAW_FIRM_ID, TEMPLATE_ID, {
      name: 'Renamed Preset',
    });

    expect(res.template.name).toBe('Renamed Preset');
    const call = api.calls('PUT')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`);
    expect(bodyOf(call)).toEqual({ name: 'Renamed Preset' });
  });

  it('surfaces ApiError when update is rejected', async () => {
    api.put(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`, {
      status: 404,
      body: { error: 'Template not found' },
    });

    await expect(
      documentRequestTemplatesService.update(LAW_FIRM_ID, TEMPLATE_ID, { name: 'Ghost' })
    ).rejects.toThrow(ApiError);
  });
});

describe('documentRequestTemplatesService.remove', () => {
  it('sends DELETE to template url', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`, {
      message: 'Template deleted',
      templateId: TEMPLATE_ID,
    });

    const res = await documentRequestTemplatesService.remove(LAW_FIRM_ID, TEMPLATE_ID);

    expect(res.templateId).toBe(TEMPLATE_ID);
    const call = api.calls('DELETE')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`);
  });

  it('surfaces ApiError when remove is rejected', async () => {
    api.delete(`/api/lawfirms/${LAW_FIRM_ID}/document-request-templates/${TEMPLATE_ID}`, {
      status: 403,
      body: { error: 'Insufficient permissions' },
    });

    await expect(
      documentRequestTemplatesService.remove(LAW_FIRM_ID, TEMPLATE_ID)
    ).rejects.toThrow(ApiError);
  });
});
