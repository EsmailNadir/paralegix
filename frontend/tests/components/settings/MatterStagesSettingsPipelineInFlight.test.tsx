/**
 * The pipeline rename dialog on the matter stages settings panel, while its save
 * is in flight. A pending rename must keep the dialog on screen: otherwise
 * Escape closes it mid-save and a refused rename reports into a closed dialog.
 *
 * The pipelines hook is replaced so the rename can be held open with a
 * deferred answer; the dialog, the panel and the shared Modal are real.
 */
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse, type HeldResponse } from '../../support/deferred';
import MatterStagesSettings from '@/components/settingsComp/MatterStagesSettings';

let held: HeldResponse;
const mockUpdatePipeline = jest.fn();

jest.mock('@/hooks/matterConfigHooks/useMatterPipelines', () => ({
  __esModule: true,
  default: () => ({
    pipelines: [{ id: 'pipe-1', name: 'Litigation', practiceAreaId: null, isDefault: false }],
    stages: [],
    loading: false,
    error: null,
    createStage: jest.fn(),
    updateStage: jest.fn(),
    deleteStage: jest.fn(),
    updatePipeline: (...args: unknown[]) => mockUpdatePipeline(...args),
    deletePipeline: jest.fn(),
  }),
}));
jest.mock('@/hooks/practiceHooks/usePracticeAreas', () => ({
  __esModule: true,
  default: () => ({ practiceAreas: [] }),
}));

beforeEach(() => {
  held = holdResponse();
  mockUpdatePipeline.mockReset();
  mockUpdatePipeline.mockImplementation(() => held.handler());
});

describe('Escape while a pipeline rename is in flight', () => {
  // Red if: the rename dialog stays dismissible while the update is pending,
  // so Escape closes it and the dialog is gone before the save settles.
  it('keeps the rename dialog open until the save settles', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MatterStagesSettings />);

    await user.click(screen.getByRole('button', { name: 'Rename Litigation' }));
    const name = await screen.findByLabelText('Name *');
    await user.clear(name);
    await user.type(name, 'Trial');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await held.untilRequested();
    expect(mockUpdatePipeline).toHaveBeenCalledWith('pipe-1', expect.objectContaining({ name: 'Trial' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    // The panel's close only flips its open flag, and the Modal stays mounted
    // for its 100ms exit animation, so the check has to outlast that window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByRole('dialog', { name: 'Rename pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => held.release({}));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename pipeline' })).not.toBeInTheDocument(),
    );
  });
});
