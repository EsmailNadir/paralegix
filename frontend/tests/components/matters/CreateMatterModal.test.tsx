// A stable handle on the courts read, so a spec can count it. The global service
// mock hands out a fresh function on every property access.
const mockListCourts = jest.fn();
jest.mock('@/services/courts.service', () => ({
  __esModule: true,
  default: { listCourts: (...args: unknown[]) => mockListCourts(...args) },
}));

const mockListPracticeAreas = jest.fn();
jest.mock('@/services/practiceArea.service', () => ({
  __esModule: true,
  default: { listPracticeAreas: (...args: unknown[]) => mockListPracticeAreas(...args) },
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import CreateMatterModal from '@/components/matterComp/CreateMatterModal';

describe('CreateMatterModal', () => {
  beforeEach(() => {
    mockListCourts.mockReset().mockResolvedValue({ courts: [] });
    mockListPracticeAreas.mockReset().mockResolvedValue({ practiceAreas: [] });
  });

  it('shows the existing-client picker immediately when creating a matter', () => {
    renderWithProviders(
      <CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} />,
    );

    expect(screen.getByText('Search existing clients by name or email...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New Client' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Existing Client' })).not.toBeInTheDocument();
  });

  it('restores the existing-client picker after cancelling a new client and reopening the matter form', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const { rerender } = renderWithProviders(
      <CreateMatterModal open onClose={onClose} lawFirmId="firm-1" users={[]} />,
    );

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    const newClientName = screen.getByRole('textbox', { name: 'Name *' });
    await user.type(newClientName, 'Dana Whitfield');
    expect(screen.queryByText('Search existing clients by name or email...')).not.toBeInTheDocument();
    await user.click(within(newClientName.closest('.bg-surface-alt') as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Search existing clients by name or email...')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ New Client' }));
    expect(screen.getByRole('textbox', { name: 'Name *' })).toHaveValue('');

    rerender(<CreateMatterModal open={false} onClose={onClose} lawFirmId="firm-1" users={[]} />);
    rerender(<CreateMatterModal open onClose={onClose} lawFirmId="firm-1" users={[]} />);

    expect(screen.getByText('Search existing clients by name or email...')).toBeInTheDocument();
  });

  it('uses the staged-modal footer as its only way to leave the form', () => {
    renderWithProviders(
      <CreateMatterModal
        open
        onClose={jest.fn()}
        lawFirmId="firm-1"
        users={[]}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Create a New Matter' });
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  // The modal stays mounted while closed on every page that offers it, so its
  // court picker must not load the firm's courts until it opens.
  it('loads no courts while closed, and loads them once it opens', async () => {
    mockListCourts.mockReset().mockResolvedValue({ courts: [] });
    const { rerender } = renderWithProviders(
      <CreateMatterModal open={false} onClose={jest.fn()} lawFirmId="firm-1" users={[]} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockListCourts).not.toHaveBeenCalled();

    rerender(<CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} />);

    await waitFor(() => expect(mockListCourts).toHaveBeenCalledTimes(1));
    expect(mockListCourts).toHaveBeenCalledWith('firm-1');
  });

  // Practice areas feed only this modal's picker, so a page that merely mounts
  // the closed modal must not load them.
  it('loads no practice areas while closed, and loads them once it opens', async () => {
    mockListCourts.mockReset().mockResolvedValue({ courts: [] });
    mockListPracticeAreas.mockReset().mockResolvedValue({ practiceAreas: [] });
    const { rerender } = renderWithProviders(
      <CreateMatterModal open={false} onClose={jest.fn()} lawFirmId="firm-1" users={[]} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockListPracticeAreas).not.toHaveBeenCalled();

    rerender(<CreateMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={[]} />);

    await waitFor(() => expect(mockListPracticeAreas).toHaveBeenCalledTimes(1));
    expect(mockListPracticeAreas).toHaveBeenCalledWith('firm-1');
  });
});
