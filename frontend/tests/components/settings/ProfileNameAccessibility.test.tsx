jest.unmock('@/services/auth.service');
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProfileNameSection from '@/components/settingsComp/ProfileNameSection';
import { ProfileContext } from '@/contexts/ProfileContext';
import type { User } from '@/types';
import { setupApiMock } from '../../support/apiMock';

const api = setupApiMock();
const profile = { name: 'Original Name', email: 'client@example.test', userType: 'client' } as User;
function renderEditor() { return render(<ProfileContext value={{ profile }}><ProfileNameSection /></ProfileContext>); }

it('focuses the name editor, describes its limit, and restores focus when cancelled', async () => {
  renderEditor();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Name *')).toHaveFocus();
  expect(screen.getByLabelText('Name *')).toBeRequired();
  expect(screen.getByLabelText('Name *')).toHaveAccessibleDescription('Maximum 100 characters.');
  await userEvent.type(screen.getByLabelText('Name *'), ' changed');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  expect(screen.getByText('Original Name')).toBeInTheDocument();
});

it('submits by Enter, announces the saved name, and restores focus', async () => {
  api.putExact('/api/users/update-name', { message: 'Saved', name: 'Updated Name' });
  renderEditor();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.clear(screen.getByLabelText('Name *'));
  await userEvent.type(screen.getByLabelText('Name *'), 'Updated Name{Enter}');
  expect(await screen.findByRole('status')).toHaveTextContent('Name updated successfully!');
  expect(api.calls('PUT')[0].body).toEqual({ name: 'Updated Name' });
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  expect(screen.getByText('Updated Name')).toBeInTheDocument();
});

it('keeps the saved name when closing the editor without a profile refresh', async () => {
  api.putExact('/api/users/update-name', { message: 'Saved', name: 'Updated Name' });
  renderEditor();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.clear(screen.getByLabelText('Name *'));
  await userEvent.type(screen.getByLabelText('Name *'), 'Updated Name');
  await userEvent.click(screen.getByRole('button', { name: 'Update Name' }));
  await screen.findByRole('status');
  expect(api.calls('PUT')[0].body).toEqual({ name: 'Updated Name' });
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Name *')).toHaveValue('Updated Name');
});

it('focuses a failed save and keeps the entered name for retry', async () => {
  api.putExact('/api/users/update-name', { status: 503, body: { error: 'Please try again later' } });
  renderEditor();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.clear(screen.getByLabelText('Name *'));
  await userEvent.type(screen.getByLabelText('Name *'), 'Updated Name');
  await userEvent.click(screen.getByRole('button', { name: 'Update Name' }));
  const alert = await screen.findByRole('alert');
  expect(alert.parentElement).toHaveFocus();
  expect(api.calls('PUT')).toHaveLength(1);
  expect(screen.getByLabelText('Name *')).toHaveValue('Updated Name');
  expect(screen.getByRole('button', { name: 'Update Name' })).toBeEnabled();
});
