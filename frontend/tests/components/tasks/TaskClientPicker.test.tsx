jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: () => null,
}));

import React, { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskClientPicker from '@/components/taskComp/taskForm/TaskClientPicker';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, grantReadOnly, resetPermissions } from '../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
const onChange = jest.fn();
let created: boolean;

function Picker({ matterId = '' }: { matterId?: string }) {
  const [ids, setIds] = useState(['client-existing']);
  return <TaskClientPicker lawFirmId="firm-1" matterId={matterId} selectedIds={ids} onChange={(next) => {
    onChange(next);
    setIds(next);
  }} />;
}

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  onChange.mockReset();
  created = false;
  api.get('/clients/lookup', (call) => {
    const items = [{ id: 'client-existing', label: 'Ada Lovelace' }];
    if (created) items.push({ id: 'client-new', label: 'Dana Whitfield' });
    const ids = call.query.ids;
    return { items: ids ? items.filter((item) => ids.join(',').split(',').includes(item.id)) : items, hasMore: false };
  });
  api.get('/clients/client-existing/contacts', { contacts: [] });
  api.post('/clients', () => {
    created = true;
    return { status: 201, body: { clientId: 'client-new' } };
  });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

async function openCreation() {
  const user = userEvent.setup();
  renderWithProviders(<Picker />);
  await user.click(screen.getByRole('button', { name: 'Create a new client' }));
  const dialog = screen.getByRole('dialog', { name: 'Create New Client' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Name *' }), 'Dana Whitfield');
  return { user, dialog };
}

it('disables changing existing clients without client management permission', async () => {
  grantBaselineMember(['tasks.update']);
  renderWithProviders(<Picker />);
  const client = await screen.findByRole('button', { name: /Ada Lovelace/ });
  expect(client).toHaveAttribute('aria-pressed', 'true');
  expect(client).toBeDisabled();
  await userEvent.click(client);
  expect(onChange).not.toHaveBeenCalled();
});

it('creates and selects a client without losing the clients already selected', async () => {
  const { user, dialog } = await openCreation();
  await user.click(within(dialog).getByRole('button', { name: 'Create & Add' }));

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(['client-existing', 'client-new']));
  expect(api.callsTo('/clients')).toHaveLength(1);
  expect(api.callsTo('/clients')[0].body).toEqual(expect.objectContaining({ name: 'Dana Whitfield', clientType: 'person' }));
  expect(api.callsTo('/clients')[0].pathname).toBe('/api/lawfirms/firm-1/clients');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await screen.findByRole('button', { name: /Dana Whitfield/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toHaveAttribute('aria-pressed', 'true');
});

it('cancels creation without changing the selected clients', async () => {
  const { user, dialog } = await openCreation();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onChange).not.toHaveBeenCalled();
  expect(api.callsTo('/clients')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Create a new client' }));
  expect(screen.getByRole('textbox', { name: 'Name *' })).toHaveValue('');
});

it('offers organization creation through the same client form', async () => {
  const { user, dialog } = await openCreation();
  await user.click(within(dialog).getByRole('button', { name: /^Client Type/ }));
  await user.click(screen.getByRole('option', { name: 'Organization' }));
  await user.clear(within(dialog).getByRole('textbox', { name: 'Organization Name *' }));
  await user.type(within(dialog).getByRole('textbox', { name: 'Organization Name *' }), 'Whitfield Consulting');
  await user.click(within(dialog).getByRole('button', { name: 'Create & Add' }));

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(['client-existing', 'client-new']));
  expect(api.callsTo('/clients')[0].body).toEqual(expect.objectContaining({ name: 'Whitfield Consulting', clientType: 'company' }));
});

it('shows a refused create and leaves the task client selection unchanged', async () => {
  api.post('/clients', { status: 403, body: { error: 'You cannot create clients' } });
  const { user, dialog } = await openCreation();
  await user.click(within(dialog).getByRole('button', { name: 'Create & Add' }));

  expect(await screen.findByText('You cannot create clients')).toBeInTheDocument();
  expect(api.callsTo('/clients')).toHaveLength(1);
  expect(onChange).not.toHaveBeenCalled();
  expect(dialog).toBeInTheDocument();
});

it('keeps matter clients inherited instead of offering task-level creation', async () => {
  renderWithProviders(<Picker matterId="matter-1" />);

  expect(screen.getByText('Inherited from the selected matter.')).toBeInTheDocument();
  expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create a new client' })).not.toBeInTheDocument();
});

it('keeps existing clients selectable without offering creation to a read-only member', async () => {
  grantReadOnly();
  renderWithProviders(<Picker />);

  expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search clients...')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create a new client' })).not.toBeInTheDocument();
});
