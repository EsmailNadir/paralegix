/**
 * The Word-first library's "New template" flow, through the real service and a
 * faked transport: the chooser, the scan, the review, and the two ways a save
 * comes back (client details left in the file, or a template of the same name).
 *
 * Red if New stops opening the chooser, if "Start in the editor" stops leading
 * to the Word-first editor, if a scanned upload saves without the review, if a
 * leftovers refusal stops turning the save into "Save anyway" with those values
 * acknowledged, or if "Save as a copy" stops resending with the copy strategy.
 */
jest.unmock('@/services/requestDeduplicator');

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { scanAccessibility } from '../../support/accessibility';
import WordTemplatesLibrary from '@/components/wordTemplates/WordTemplatesLibrary';

const navigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate, isNavigating: false }),
}));

const FIRM = 'firm-1';
const BASE = `/api/lawfirms/${FIRM}/word-templates`;
const SESSION = 'https://storage.googleapis.com/upload/word-1';
const OBJECT = 'word-templates/firm-1/uploads/engagement.docx';

const proposal = {
  kind: 'literal',
  literal: '$1,500.00',
  category: 'money',
  suggestedTag: 'flat_fee_amount',
  canonical: true,
  occurrences: 1,
  contextSnippet: 'The flat fee is $1,500.00 payable on signing.',
};

let api: ApiMock;
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  navigate.mockClear();
  api.getExact(BASE, { templates: [] });
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

function openScan() {
  api.postExact(`${BASE}/upload-init`, { uploadUrl: SESSION, objectPath: OBJECT, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  xhr.onExact('PUT', SESSION, { status: 200 });
  api.postExact(`${BASE}/detect`, { proposals: [proposal] });
}

async function uploadThroughChooser() {
  fireEvent.click((await screen.findAllByRole('button', { name: /New template/ }))[0]);
  const chooser = await screen.findByRole('dialog', { name: 'New template' });
  const input = document.querySelector('input[type="file"][data-testid="new-template-docx-input"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [new File(['PK'], 'engagement.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })],
    },
  });
  return chooser;
}

it('offers the two ways to start a template, with the toggle above the library', async () => {
  renderWithProviders(<WordTemplatesLibrary lawFirmId={FIRM} versionToggle={<span>version switch</span>} />);

  expect(screen.getByText('version switch')).toBeInTheDocument();
  fireEvent.click((await screen.findAllByRole('button', { name: /New template/ }))[0]);

  const chooser = await screen.findByRole('dialog', { name: 'New template' });
  expect(within(chooser).getByText('Upload a Word document or fillable PDF')).toBeInTheDocument();
  expect(
    within(chooser).getByText('Keeps the original formatting exactly. Finds the fill-in blanks for you to name.'),
  ).toBeInTheDocument();
  expect(within(chooser).getByText('Start in the editor')).toBeInTheDocument();
  expect((await scanAccessibility(chooser)).violations).toEqual([]);
});

it('starts in the Word-first editor from "Start in the editor"', async () => {
  renderWithProviders(<WordTemplatesLibrary lawFirmId={FIRM} />);
  fireEvent.click((await screen.findAllByRole('button', { name: /New template/ }))[0]);

  fireEvent.click(await screen.findByRole('button', { name: /Start in the editor/ }));

  expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates/word/new`);
});

it('scans an upload, shows the review, and saves the reviewed fields', async () => {
  openScan();
  api.postExact(`${BASE}/commit`, { status: 201, body: { message: 'saved', templateId: 'tpl-7', template: { id: 'tpl-7' } } });
  renderWithProviders(<WordTemplatesLibrary lawFirmId={FIRM} />);

  await uploadThroughChooser();

  const review = await screen.findByRole('dialog', { name: 'Review detected fields' });
  expect(within(review).getByText(/1 field found in engagement\.docx/)).toBeInTheDocument();
  fireEvent.click(within(review).getByRole('button', { name: 'Save template' }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates/word/tpl-7`));
  expect(api.callsTo(`${BASE}/commit`)[0].body).toEqual({
    objectPath: OBJECT,
    fileName: 'engagement.docx',
    name: 'engagement',
    edits: [{ kind: 'literal', find: '$1,500.00', tag: 'flat_fee_amount' }],
  });
});

it('keeps client details only when the reviewer chooses Save anyway', async () => {
  openScan();
  const leftover = {
    literal: 'Quillon Vantress',
    canonicalId: 'client_name',
    occurrences: 1,
    contextSnippet: 'Dear Quillon Vantress,',
    parts: ['body'],
  };
  api.postExact(`${BASE}/commit`, sequence(
    {
      status: 409,
      body: {
        error: 'Client details would stay in this template. Review them before saving.',
        code: 'TEMPLATE_CLIENT_TEXT',
        details: { leftovers: [leftover], clientTextRefused: true },
      },
    },
    { status: 201, body: { message: 'saved', templateId: 'tpl-8', template: { id: 'tpl-8' } } },
  ));
  renderWithProviders(<WordTemplatesLibrary lawFirmId={FIRM} />);
  await uploadThroughChooser();
  const review = await screen.findByRole('dialog', { name: 'Review detected fields' });

  fireEvent.click(within(review).getByRole('button', { name: 'Save template' }));

  expect(await within(review).findByText('Quillon Vantress')).toBeInTheDocument();
  fireEvent.click(within(review).getByRole('button', { name: 'Save anyway' }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates/word/tpl-8`));
  expect(api.callsTo(`${BASE}/commit`)[1].body).toMatchObject({ acknowledgedLeftovers: ['Quillon Vantress'] });
});

it('offers Save as a copy when a template of the same name exists', async () => {
  openScan();
  api.postExact(`${BASE}/commit`, sequence(
    {
      status: 409,
      body: {
        error: 'A template with this name already exists.',
        code: 'TEMPLATE_DUPLICATE',
        details: { duplicate: { id: 'tpl-1', name: 'engagement' } },
      },
    },
    { status: 201, body: { message: 'saved', templateId: 'tpl-9', template: { id: 'tpl-9' } } },
  ));
  renderWithProviders(<WordTemplatesLibrary lawFirmId={FIRM} />);
  await uploadThroughChooser();
  const review = await screen.findByRole('dialog', { name: 'Review detected fields' });
  fireEvent.click(within(review).getByRole('button', { name: 'Save template' }));

  const duplicate = await screen.findByRole('dialog', { name: 'Template already exists' });
  expect(within(duplicate).getByText('A template named “engagement” already exists.')).toBeInTheDocument();
  fireEvent.click(within(duplicate).getByRole('button', { name: /Save as a copy/ }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/templates/word/tpl-9`));
  expect(api.callsTo(`${BASE}/commit`)[1].body).toMatchObject({ duplicateStrategy: 'copy' });
});
