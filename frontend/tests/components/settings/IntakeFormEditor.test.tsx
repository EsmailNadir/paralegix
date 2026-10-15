/**
 * The full-page intake form editor and the list that routes into it, driven
 * through the REAL leads service against a fake transport.
 */
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import IntakeFormEditor from '@/components/settingsComp/IntakeFormEditor';
import IntakeFormsSettings from '@/components/settingsComp/IntakeFormsSettings';

// tests/setup.ts pins useParams to this firm.
const LAW_FIRM_ID = 'test-law-firm-id';
const FORMS_PATH = `/api/lawfirms/${LAW_FIRM_ID}/intake-forms`;
const LIST_HREF = `/lawfirm/${LAW_FIRM_ID}/settings/matter-config?tab=intakeForms`;

const TEMPLATE = {
  id: 'tpl-1',
  name: 'General Intake',
  publicToken: 'tok-1',
  isActive: true,
  hasAccessCode: false,
  fields: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }],
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  mockNavigate.mockReset();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('IntakeFormEditor', () => {
  it('creates a form from the page and returns to the list', async () => {
    api.getExact(FORMS_PATH, { templates: [] });
    api.postExact(FORMS_PATH, { template: { ...TEMPLATE, id: 'tpl-new' } });

    renderWithProviders(<IntakeFormEditor />);

    expect(screen.getByRole('heading', { name: 'New intake form' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name *'), 'Injury intake');
    await userEvent.type(screen.getByPlaceholderText('Field 1'), 'Accident date');
    await userEvent.click(screen.getByRole('button', { name: 'Create form' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(LIST_HREF));
    const [call] = api.callsTo('/intake-forms').filter((c) => c.method === 'POST');
    expect(call.body).toMatchObject({
      name: 'Injury intake',
      fields: [{ label: 'Accident date', type: 'text', required: false }],
      accessCode: null,
      isActive: true,
    });
  });

  it('saves dropdown options entered one row at a time, dropping blanks', async () => {
    api.getExact(FORMS_PATH, { templates: [] });
    api.postExact(FORMS_PATH, { template: { ...TEMPLATE, id: 'tpl-new' } });

    renderWithProviders(<IntakeFormEditor />);

    await userEvent.type(screen.getByLabelText('Name *'), 'Injury intake');
    await userEvent.type(screen.getByPlaceholderText('Field 1'), 'Practice area');
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Dropdown' }));
    await userEvent.type(screen.getByLabelText('Option 1'), ' Family law {Enter}Probate{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Create form' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(LIST_HREF));
    const [call] = api.callsTo('/intake-forms').filter((c) => c.method === 'POST');
    expect(call.body).toMatchObject({
      fields: [{ label: 'Practice area', type: 'select', options: ['Family law', 'Probate'] }],
    });
  });

  it('loads the matching form, saves edits to its url, and returns to the list', async () => {
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });
    api.putExact(`${FORMS_PATH}/tpl-1`, { template: { ...TEMPLATE, name: 'Renamed' } });

    renderWithProviders(<IntakeFormEditor formId="tpl-1" />);

    const nameInput = await screen.findByLabelText('Name *');
    expect(nameInput).toHaveValue('General Intake');
    expect(screen.getByDisplayValue('Full name')).toBeInTheDocument();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(LIST_HREF));
    const [call] = api.callsTo('/intake-forms/tpl-1').filter((c) => c.method === 'PUT');
    expect(call.body).toMatchObject({
      name: 'Renamed',
      fields: [{ key: 'full_name', label: 'Full name', required: true }],
    });
    // A blank access code on edit keeps the stored one, so the key stays out.
    expect(call.body).not.toHaveProperty('accessCode');
  });

  it('omits the key of a field added in the editor so the backend derives it', async () => {
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });
    api.putExact(`${FORMS_PATH}/tpl-1`, { template: TEMPLATE });

    renderWithProviders(<IntakeFormEditor formId="tpl-1" />);

    await screen.findByLabelText('Name *');
    await userEvent.click(screen.getByRole('button', { name: /Add field/ }));
    await userEvent.type(screen.getByPlaceholderText('Field 2'), 'Date of birth');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(LIST_HREF));
    const [call] = api.callsTo('/intake-forms/tpl-1').filter((c) => c.method === 'PUT');
    const { fields } = call.body as { fields: Array<Record<string, unknown>> };
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ key: 'full_name' });
    expect(fields[1]).toMatchObject({ label: 'Date of birth' });
    // An empty string here was refused by the backend's schema with a 400.
    expect(fields[1].key).toBeUndefined();
  });

  it('stays on the page and shows the error when the save is rejected', async () => {
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });
    api.putExact(`${FORMS_PATH}/tpl-1`, {
      status: 400,
      body: { error: 'Access code must be at least 8 characters' },
    });

    renderWithProviders(<IntakeFormEditor formId="tpl-1" />);

    await screen.findByLabelText('Name *');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Access code must be at least 8 characters'),
    ).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('says the form is gone when the id matches no template', async () => {
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });

    renderWithProviders(<IntakeFormEditor formId="tpl-missing" />);

    expect(await screen.findByText('This intake form no longer exists.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
  });

  it('shows the permission notice instead of the form without leads.manage', async () => {
    grantPermissions(['leads.view']);
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });

    renderWithProviders(<IntakeFormEditor formId="tpl-1" />);

    expect(screen.getByText(/permission to create or edit intake forms/)).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('/intake-forms').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
  });
});

describe('IntakeFormsSettings', () => {
  it('opens the editor pages instead of a modal', async () => {
    api.getExact(FORMS_PATH, { templates: [TEMPLATE] });

    renderWithProviders(<IntakeFormsSettings />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit form' }));
    expect(mockNavigate).toHaveBeenLastCalledWith(
      `/lawfirm/${LAW_FIRM_ID}/settings/matter-config/intake-forms/tpl-1`,
    );

    await userEvent.click(screen.getByRole('button', { name: /New form/ }));
    expect(mockNavigate).toHaveBeenLastCalledWith(
      `/lawfirm/${LAW_FIRM_ID}/settings/matter-config/intake-forms/new`,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
