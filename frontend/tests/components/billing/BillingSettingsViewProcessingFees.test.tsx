/**
 * The online payment fee settings live on the Payments settings page
 * (`tests/app/lawfirm/settings/PaymentsSettingsPage.test.tsx`), beside the
 * Stripe connection they depend on. Billing settings no longer carries them,
 * so a firm has one place to set its card and bank transfer fees.
 *
 * Red if the "Online Payment Fees" section, the card fee setting or the bank
 * transfer switch comes back to Billing settings, or if Billing settings starts
 * reading the card fee setting again.
 */
import React from 'react';
import { screen } from '@testing-library/react';
import BillingSettingsView from '@/components/billingComp/BillingSettingsView';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
});

afterEach(() => {
  api.restore();
});

it('no longer shows the online payment fee settings', async () => {
  renderWithProviders(
    <FirmSettingsProvider lawFirmId="firm-a" initialSettings={{}}>
      <BillingSettingsView lawFirmId="firm-a" />
    </FirmSettingsProvider>,
  );

  // The page has rendered its other sections before the absence is checked.
  expect(await screen.findByRole('heading', { name: 'Client Payment Emails' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Late Fees' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Online Payment Fees' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Clients pay the bank transfer fee' })).not.toBeInTheDocument();
  expect(screen.queryByText('Clients pay a fee on credit cards')).not.toBeInTheDocument();
  expect(api.callsTo('/billing/card-fees')).toHaveLength(0);
});
