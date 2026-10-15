/**
 * The note types and note templates services, tested OFFLINE against a fake transport.
 *
 * Unmocks noteTypes.service, noteTemplates.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, payload construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/noteTypes.service');
jest.unmock('@/services/noteTemplates.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import noteTypesService from '@/services/noteTypes.service';
import noteTemplatesService from '@/services/noteTemplates.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';

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

describe('noteTypesService', () => {
  it('listNoteTypes requests firm note types and unwraps list', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/note-types`, {
      noteTypes: [{ value: 'client_call', label: 'Client Call', color: '#3B82F6' }],
    });

    const res = await noteTypesService.listNoteTypes(LAW_FIRM_ID);

    expect(res.noteTypes).toHaveLength(1);
    expect(res.noteTypes[0].value).toBe('client_call');
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/note-types`);
  });

  it('listNoteTypes scopes to requested firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/note-types`, {
      noteTypes: [],
    });

    await noteTypesService.listNoteTypes(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toContain(`/lawfirms/${OTHER_FIRM_ID}/note-types`);
  });

  it('createNoteType posts label to /note-types and returns created type', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/note-types`, {
      message: 'Note type created',
      noteType: { value: 'court_hearing', label: 'Court Hearing', color: '#10B981' },
    });

    const res = await noteTypesService.createNoteType(LAW_FIRM_ID, 'Court Hearing');

    expect(res.noteType.value).toBe('court_hearing');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/note-types`);
    expect(bodyOf(call)).toEqual({ label: 'Court Hearing' });
  });

  it('createNoteType surfaces ApiError on rejection', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/note-types`, {
      status: 400,
      body: { error: 'Duplicate note type' },
    });

    await expect(
      noteTypesService.createNoteType(LAW_FIRM_ID, 'Existing')
    ).rejects.toThrow(ApiError);
  });

  it('updateNoteTypeColor sends PATCH to note type color endpoint', async () => {
    api.patch(`/api/lawfirms/${LAW_FIRM_ID}/note-types/client_call/color`, {
      message: 'Color updated',
      noteType: { value: 'client_call', label: 'Client Call', color: '#EF4444' },
    });

    const res = await noteTypesService.updateNoteTypeColor(LAW_FIRM_ID, 'client_call', '#EF4444');

    expect(res.noteType.color).toBe('#EF4444');
    const call = api.calls('PATCH')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/note-types/client_call/color`);
    expect(bodyOf(call)).toEqual({ color: '#EF4444' });
  });
});

describe('noteTemplatesService', () => {
  it('listNoteTemplates requests firm note templates and unwraps list', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/note-templates`, {
      noteTemplates: [{ id: 'tpl-1', label: 'Intake Summary', contentHtml: '<p>Notes</p>' }],
    });

    const res = await noteTemplatesService.listNoteTemplates(LAW_FIRM_ID);

    expect(res.noteTemplates).toHaveLength(1);
    expect(res.noteTemplates[0].label).toBe('Intake Summary');
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/note-templates`);
  });

  it('createNoteTemplate posts input payload to /note-templates', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/note-templates`, {
      message: 'Template created',
      noteTemplate: { id: 'tpl-2', label: 'Deposition Notes' },
    });

    const res = await noteTemplatesService.createNoteTemplate(LAW_FIRM_ID, {
      label: 'Deposition Notes',
      noteType: 'deposition',
      subject: 'Witness Exam',
      contentHtml: '<p>Questions</p>',
    });

    expect(res.noteTemplate.id).toBe('tpl-2');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/note-templates`);
    expect(bodyOf(call)).toMatchObject({
      label: 'Deposition Notes',
      noteType: 'deposition',
      subject: 'Witness Exam',
    });
  });

  it('createNoteTemplate surfaces ApiError when payload is invalid', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/note-templates`, {
      status: 400,
      body: { error: 'Label is required' },
    });

    await expect(
      noteTemplatesService.createNoteTemplate(LAW_FIRM_ID, { label: '' })
    ).rejects.toThrow(ApiError);
  });
});
