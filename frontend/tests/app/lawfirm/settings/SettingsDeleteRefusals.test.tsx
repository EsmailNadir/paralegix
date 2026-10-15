/**
 * A refused delete on the Matter Config reference lists.
 *
 * The confirm dialog stays open when the server refuses, so the reason has to
 * be inside it: the page's own error banner renders behind the backdrop, where
 * the user sees nothing happen. The services run for real against a faked
 * transport.
 */
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/chargeCodes.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import PracticeAreasPage from '@/app/lawfirm/[lawFirmId]/settings/practice-area/page';
import ChargeCodesPage from '@/app/lawfirm/[lawFirmId]/settings/charge-codes/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

// tests/setup.ts pins useParams to this firm.
const LAW_FIRM_ID = 'test-law-firm-id';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

afterEach(() => {
  resetPermissions();
});

async function confirmAndExpectRefusalInDialog(reason: string) {
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  return dialog;
}

describe('practice areas', () => {
  const LIST_URL = `${API}/lawfirms/${LAW_FIRM_ID}/practice-areas`;

  it('shows the refusal inside the confirm dialog, and clears it on the next open', async () => {
    grantBaselineMember(['practiceAreas.manage']);
    api.getExact(LIST_URL, { practiceAreas: [{ id: 'pa-1', name: 'Family Law' }] });
    api.deleteExact(`${LIST_URL}/pa-1`, {
      status: 409,
      body: { error: 'Practice area is used by 4 matters' },
    });

    renderWithProviders(<PracticeAreasPage />);

    await screen.findByText('Family Law');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await confirmAndExpectRefusalInDialog('Practice area is used by 4 matters');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('charge codes', () => {
  const BASE = `${API}/lawfirms/${LAW_FIRM_ID}/billing/charge-codes`;

  it('shows the refusal inside the confirm dialog', async () => {
    grantBaselineMember(['billing.manageRates', 'billing.viewRates']);
    api.getExact(`${BASE}?includeInactive=false`, {
      chargeCodes: [{
        id: 'cc-1', lawFirmId: LAW_FIRM_ID, code: 'RESEARCH', name: 'Legal research',
        isActive: true, order: 0, createdBy: 'u-1',
      }],
    });
    api.deleteExact(`${BASE}/cc-1`, {
      status: 409,
      body: { error: 'Charge code is used by billed time entries' },
    });

    renderWithProviders(<ChargeCodesPage />);

    await screen.findByText('Legal research');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await confirmAndExpectRefusalInDialog('Charge code is used by billed time entries');
  });
});
