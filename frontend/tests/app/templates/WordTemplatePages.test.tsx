/**
 * The Word-first sub-pages under /templates/word: the editor host for a new and
 * an existing template, and the fill link.
 *
 * Red if a fillable-PDF template opens the HTML editor (it has no HTML, so it
 * would land on an empty page) instead of going back to its detail page, if
 * saving or leaving the editor stops returning to the right page, or if the
 * fill link stops opening the library's fill form for that template.
 */
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const navigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate, isNavigating: false }),
}));

let params: Record<string, string> = { lawFirmId: 'firm-1' };
jest.mock('next/navigation', () => ({
  useParams: () => params,
  useSearchParams: () => new URLSearchParams('matterId=matter-4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/lawfirm/firm-1/templates/word',
}));

jest.mock('@/components/ui/RequireFeature', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

let editorProps: any = null;
jest.mock('@/components/wordTemplates/TemplateEditor', () => ({
  __esModule: true,
  default: (props: any) => {
    editorProps = props;
    return React.createElement('div', { 'data-testid': 'word-editor' }, props.templateId ?? 'new');
  },
}));

import NewWordTemplatePage from '@/app/lawfirm/[lawFirmId]/templates/word/new/page';
import EditWordTemplatePage from '@/app/lawfirm/[lawFirmId]/templates/word/[templateId]/edit/page';
import FillWordTemplatePage from '@/app/lawfirm/[lawFirmId]/templates/word/[templateId]/fill/page';

const BASE = '/api/lawfirms/firm-1/word-templates';
let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  navigate.mockClear();
  editorProps = null;
});

afterEach(() => api.restore());

it('opens the editor on its upload step for a new template, and returns to the library', async () => {
  params = { lawFirmId: 'firm-1' };
  render(<NewWordTemplatePage />);

  expect(await screen.findByTestId('word-editor')).toHaveTextContent('new');
  expect(editorProps.lawFirmId).toBe('firm-1');
  editorProps.onSaved();
  expect(navigate).toHaveBeenLastCalledWith('/lawfirm/firm-1/templates');
  editorProps.onBack();
  expect(navigate).toHaveBeenLastCalledWith('/lawfirm/firm-1/templates');
});

it('opens a web template in the editor and returns to its page on save', async () => {
  params = { lawFirmId: 'firm-1', templateId: 'tpl-1' };
  api.getExact(`${BASE}/tpl-1`, { template: { id: 'tpl-1', name: 'A', type: 'html', fields: [], folderId: null, createdAt: 'x', html: '<p/>' } });

  renderWithProviders(<EditWordTemplatePage />);

  expect(await screen.findByTestId('word-editor')).toHaveTextContent('tpl-1');
  expect(editorProps.converterEnabled).toBe(true);
  editorProps.onSaved();
  expect(navigate).toHaveBeenLastCalledWith('/lawfirm/firm-1/templates/word/tpl-1');
});

it('sends a fillable-PDF template back to its detail page instead of the editor', async () => {
  params = { lawFirmId: 'firm-1', templateId: 'tpl-2' };
  api.getExact(`${BASE}/tpl-2`, { template: { id: 'tpl-2', name: 'Form', type: 'pdf-form', fields: [], folderId: null, createdAt: 'x' } });

  renderWithProviders(<EditWordTemplatePage />);

  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/lawfirm/firm-1/templates/word/tpl-2'));
  expect(screen.queryByTestId('word-editor')).not.toBeInTheDocument();
});

it('opens the library fill form for the template, keeping the matter', async () => {
  params = { lawFirmId: 'firm-1', templateId: 'tpl-3' };
  render(<FillWordTemplatePage />);

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('/lawfirm/firm-1/templates?fill=tpl-3&matterId=matter-4'),
  );
});
