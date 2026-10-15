/**
 * The late-fee setting is on the billing Settings page, visible without
 * expanding anything, says it is off by default, and starts unchecked for a
 * firm that has never saved it. Turning it on saves the whole late-fee group
 * with `enabled: true` and everything else at its default.
 *
 * Red if the toggle defaults to checked, if the heading or the off-by-default
 * line is removed or moved behind a disclosure, or if the save sends a partial
 * group or `enabled: false`.
 */
const mockUpdateFirmSettings = jest.fn();

jest.mock('@/services/settings.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    updateFirmSettings: (...args: unknown[]) => mockUpdateFirmSettings(...args),
  }),
);

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingSettingsView from '@/components/billingComp/BillingSettingsView';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';

let api: ApiMock;

beforeEach(() => {
  // Stripe status and the firm record are direct fetches this spec is not about.
  api = installApiMock();
  api.allowUnhandled();
  mockUpdateFirmSettings.mockReset();
  mockUpdateFirmSettings.mockResolvedValue({ message: 'ok' });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

function renderSettings() {
  // Seeded with nothing: the state of a firm that has never saved a late fee.
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId="firm-a" initialSettings={{}}>
      <BillingSettingsView lawFirmId="firm-a" />
    </FirmSettingsProvider>,
  );
}

describe('late fee setting', () => {
  it('is visible, unchecked, and says it is off by default', () => {
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Late Fees' })).toBeVisible();
    const toggle = screen.getByRole('checkbox', { name: /Charge a late fee on overdue invoices/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Off by default/)).toBeInTheDocument();
    // The amount fields stay hidden until the firm opts in.
    expect(screen.queryByText('Flat amount')).not.toBeInTheDocument();
  });

  it('saves the full late-fee group with enabled true when turned on', async () => {
    renderSettings();

    await userEvent.click(screen.getByRole('checkbox', { name: /Charge a late fee on overdue invoices/ }));

    await waitFor(() => expect(mockUpdateFirmSettings).toHaveBeenCalledTimes(1));
    const [firmId, partial] = mockUpdateFirmSettings.mock.calls[0];
    expect(firmId).toBe('firm-a');
    expect(partial.billing.lateFee).toEqual({
      enabled: true, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false,
    });
    // Revealed after opting in, which proves the change took on screen.
    expect(await screen.findByText('Flat amount')).toBeInTheDocument();
  });

  it('is shown read-only to a member who cannot manage firm settings', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    renderSettings();

    const toggle = screen.getByRole('checkbox', { name: /Charge a late fee on overdue invoices/ });
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle);
    expect(mockUpdateFirmSettings).not.toHaveBeenCalled();
  });
});
