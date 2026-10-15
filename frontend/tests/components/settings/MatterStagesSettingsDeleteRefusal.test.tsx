/**
 * A refused stage or pipeline delete on the matter stages settings panel.
 *
 * The confirm dialog stays open when the delete fails, so the reason must be
 * inside it; the panel banner renders behind the backdrop. The pipelines hook
 * is replaced so each delete can be refused; the panel and dialogs are real.
 */
import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../support/renderWithProviders';
import MatterStagesSettings from '@/components/settingsComp/MatterStagesSettings';

const mockDeletePipeline = jest.fn();

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
    updatePipeline: jest.fn(),
    deletePipeline: (...args: unknown[]) => mockDeletePipeline(...args),
  }),
}));
jest.mock('@/hooks/practiceHooks/usePracticeAreas', () => ({
  __esModule: true,
  default: () => ({ practiceAreas: [] }),
}));

beforeEach(() => {
  mockDeletePipeline.mockReset();
  mockDeletePipeline.mockRejectedValue(new Error('Litigation still has 12 matters on it'));
});

it('shows a refused pipeline delete inside the still-open confirm dialog', async () => {
  renderWithProviders(<MatterStagesSettings />);

  await userEvent.click(screen.getByRole('button', { name: 'Delete Litigation' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Litigation still has 12 matters on it',
  );
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});
