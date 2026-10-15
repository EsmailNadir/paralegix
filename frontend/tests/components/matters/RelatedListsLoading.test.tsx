import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';

const mockListClients = jest.fn();
const mockListSubtasks = jest.fn();

jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: { listClients: (...args: unknown[]) => mockListClients(...args) },
}));
jest.mock('@/services/tasks.service', () => ({
  __esModule: true,
  default: { listSubtasks: (...args: unknown[]) => mockListSubtasks(...args) },
}));

import InviteMatterClientsModal from '@/components/matterComp/InviteMatterClientsModal';
import TaskSubtasks from '@/components/taskComp/TaskSubtasks';

it('shows rows while the portal invitation client list is loading', async () => {
  let release: ((value: unknown) => void) | undefined;
  mockListClients.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  renderWithProviders(<InviteMatterClientsModal open onClose={jest.fn()} lawFirmId="firm-1" matterId="matter-1" />);

  expect(screen.getByRole('status', { name: 'Loading clients' })).toBeInTheDocument();
  expect(screen.queryByText("Everyone's on the portal")).not.toBeInTheDocument();
  await waitFor(() => expect(release).toBeDefined());
  release?.([]);
  expect(await screen.findByText("Everyone's on the portal")).toBeInTheDocument();
});

it('shows rows while subtasks are loading', async () => {
  let release: ((value: unknown) => void) | undefined;
  mockListSubtasks.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  renderWithProviders(<TaskSubtasks lawFirmId="firm-1" taskId="task-1" />);

  expect(screen.getByRole('status', { name: 'Loading subtasks' })).toBeInTheDocument();
  await waitFor(() => expect(release).toBeDefined());
  release?.([]);
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading subtasks' })).not.toBeInTheDocument());
});
