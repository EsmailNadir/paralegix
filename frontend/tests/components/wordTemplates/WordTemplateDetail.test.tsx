/**
 * The Word-first template detail page: what the template is, the placeholders
 * it carries, and the source-document actions (Re-upload, Delete), through the
 * real service against a faked transport.
 *
 * Red if the page stops reading fields by their vocabulary label, if a Word
 * template stops offering Re-upload, if a re-upload that still holds client
 * details stops asking before saving it anyway, or if Delete stops confirming
 * and returning to the library.
 */
jest.unmock('@/services/requestDeduplicator');

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import WordTemplateDetail from '@/components/wordTemplates/WordTemplateDetail';

const navigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate, isNavigating: false }),
}));

const FIRM = 'firm-1';
const BASE = `/api/lawfirms/${FIRM}/word-templates`;

const wordTemplate = {
  id: 'tpl-1',
  name: 'Engagement letter',
  type: 'docx',
  fields: ['client_name', 'case_number', 'payments.payment_amount'],
  repeaters: [{ name: 'payments', fields: ['payment_amount'] }],
  folderId: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  html: null,
  docxStoragePath: 'word-templates/firm-1/tpl-1.docx',
  originalFileName: 'Engagement.docx',
  assets: [],
};

let api: ApiMock;
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  navigate.mockClear();
  grantPermissions(['templates.view', 'templates.manage']);
});

afterEach(() => {
  api.restore();
  xhr.restore();
  resetPermissions();
});

it('describes a Word template and lists its placeholders by name', async () => {
  api.getExact(`${BASE}/tpl-1`, { template: wordTemplate });

  renderWithProviders(<WordTemplateDetail lawFirmId={FIRM} templateId="tpl-1" />);

  expect(await screen.findByRole('heading', { name: 'Engagement letter' })).toBeInTheDocument();
  expect(screen.getByText('Word template')).toBeInTheDocument();
  expect(screen.getByText(/2 fields · 1 repeating section · Engagement\.docx/)).toBeInTheDocument();
  expect(screen.getByText('Client full name')).toBeInTheDocument();
  expect(screen.getByText('Case number')).toBeInTheDocument();
  expect(screen.getByText('Scanned from the uploaded .docx.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Re-upload \.docx/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
});

it('hides the source actions from someone who cannot manage templates', async () => {
  grantPermissions(['templates.view']);
  api.getExact(`${BASE}/tpl-1`, { template: wordTemplate });

  renderWithProviders(<WordTemplateDetail lawFirmId={FIRM} templateId="tpl-1" />);

  await screen.findByRole('heading', { name: 'Engagement letter' });
  expect(screen.queryByRole('button', { name: /Re-upload/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Delete template/ })).not.toBeInTheDocument();
});

it('asks before re-uploading a document that still names a client, then keeps it on Save anyway', async () => {
  api.getExact(`${BASE}/tpl-1`, { template: wordTemplate });
  api.postExact(`${BASE}/upload-init`, { uploadUrl: 'https://storage.example/upload', objectPath: 'obj/v2.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  xhr.onExact('PUT', 'https://storage.example/upload', { status: 200 });
  const leftover = {
    literal: 'Quillon Vantress', canonicalId: 'client_name', occurrences: 2, contextSnippet: 'Dear Quillon Vantress,', parts: ['body'],
  };
  api.postExact(`${BASE}/tpl-1/replace-source`, sequence(
    { status: 409, body: { error: 'Client details would stay.', code: 'TEMPLATE_CLIENT_TEXT', details: { leftovers: [leftover], clientTextRefused: true } } },
    { message: 'replaced', templateId: 'tpl-1', template: { id: 'tpl-1' } },
  ));
  renderWithProviders(<WordTemplateDetail lawFirmId={FIRM} templateId="tpl-1" />);
  await screen.findByRole('heading', { name: 'Engagement letter' });

  const input = document.querySelector('input[data-testid="replace-docx-input"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['PK'], 'v2.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })] } });

  const dialog = await screen.findByRole('dialog', { name: 'Client details are still in this document' });
  expect(within(dialog).getByText('Quillon Vantress')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save anyway' }));

  await waitFor(() => expect(api.callsTo(`${BASE}/tpl-1/replace-source`)).toHaveLength(2));
  expect(api.callsTo(`${BASE}/tpl-1/replace-source`)[1].body).toEqual({
    objectPath: 'obj/v2.docx',
    fileName: 'v2.docx',
    acknowledgedLeftovers: ['Quillon Vantress'],
  });
});

it('deletes after confirming and returns to the library', async () => {
  api.getExact(`${BASE}/tpl-1`, { template: wordTemplate });
  api.deleteExact(`${BASE}/tpl-1`, { message: 'deleted', templateId: 'tpl-1' });
  renderWithProviders(<WordTemplateDetail lawFirmId={FIRM} templateId="tpl-1" />);
  await screen.findByRole('heading', { name: 'Engagement letter' });

  fireEvent.click(screen.getByRole('button', { name: /Delete template/ }));
  const confirm = await screen.findByRole('dialog', { name: 'Delete template' });
  expect(within(confirm).getByText('Are you sure you want to delete "Engagement letter"? This cannot be undone.')).toBeInTheDocument();
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates`));
  expect(api.calls('DELETE')).toHaveLength(1);
});

it('offers Edit for a web template and reads its fields from the html', async () => {
  api.getExact(`${BASE}/tpl-2`, { template: {
    ...wordTemplate,
    id: 'tpl-2',
    name: 'Web letter',
    type: 'html',
    fields: [],
    repeaters: [],
    html: '<p><span data-placeholder-chip="firm_name">{firm_name}</span></p>',
    docxStoragePath: null,
    originalFileName: null,
  } });

  renderWithProviders(<WordTemplateDetail lawFirmId={FIRM} templateId="tpl-2" />);

  expect(await screen.findByText('Web template')).toBeInTheDocument();
  expect(screen.getByText('Firm name')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates/word/tpl-2/edit`);
});
