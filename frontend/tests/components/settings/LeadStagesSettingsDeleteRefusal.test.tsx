/**
 * A refused stage delete on the lead stages settings panel.
 *
 * The confirm dialog stays open when the delete fails, so the reason must be
 * inside it; the panel banner renders behind the backdrop. The stages hook is
 * replaced so the delete can be refused; the panel and dialog are real.
 */
import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../support/renderWithProviders';
import LeadStagesSettings from '@/components/settingsComp/LeadStagesSettings';

const mockDeleteStage = jest.fn();

jest.mock('@/hooks/leadHooks/useLeadStages', () => ({
  __esModule: true,
  default: () => ({
    stages: [{ id: 'stage-1', name: 'Consultation', practiceAreaId: null, sortOrder: 0, isClosed: false, parentStageId: null }],
    loading: false,
    error: null,
    createStage: jest.fn(),
    updateStage: jest.fn(),
    deleteStage: (...args: unknown[]) => mockDeleteStage(...args),
  }),
}));
jest.mock('@/hooks/practiceHooks/usePracticeAreas', () => ({
  __esModule: true,
  default: () => ({ practiceAreas: [] }),
}));

beforeEach(() => {
  mockDeleteStage.mockReset();
  mockDeleteStage.mockRejectedValue(new Error('Consultation still has 4 leads in it'));
});

it('shows a refused stage delete inside the still-open confirm dialog', async () => {
  renderWithProviders(<LeadStagesSettings />);

  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Consultation still has 4 leads in it');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});
