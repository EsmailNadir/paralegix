/**
 * Which top-level settings tabs a member is offered.
 *
 * Every member holds `settings.viewFirm`, so every member reaches this layout.
 * The Payments tab reads the Stripe status and card fee settings, both gated on
 * `billing.viewInvoices`, so it is offered only to a member who can read them.
 */
jest.mock('@/contexts/FirmSettingsContext', () => ({
  __esModule: true,
  useFirmSettings: () => ({ features: {} }),
}));
jest.mock('@/hooks/useGetStartedProgress', () => ({
  __esModule: true,
  useGetStartedProgress: () => ({ complete: true }),
}));

import { screen } from '@testing-library/react';

import SettingsLayout from '@/app/lawfirm/[lawFirmId]/settings/layout';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

afterEach(() => {
  resetPermissions();
});

function renderLayout() {
  return renderWithProviders(<SettingsLayout><div>panel</div></SettingsLayout>);
}

it('hides Payments from a member without billing.viewInvoices', () => {
  grantBaselineMember();

  renderLayout();

  expect(screen.getByRole('link', { name: /General/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Payments/ })).not.toBeInTheDocument();
});

it('offers Payments to a member holding billing.viewInvoices', () => {
  grantBaselineMember(['billing.viewInvoices']);

  renderLayout();

  expect(screen.getByRole('link', { name: /Payments/ })).toBeInTheDocument();
});
