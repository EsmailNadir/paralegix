/**
 * Which Matter Config sub-tabs a member is offered.
 *
 * Every courts route, the list included, requires `courts.manage`. A tab that
 * every settings viewer could open would land a member without it on a read
 * the backend refuses.
 */
import { screen } from '@testing-library/react';

import MatterConfigPage from '@/app/lawfirm/[lawFirmId]/settings/matter-config/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

afterEach(() => {
  resetPermissions();
});

it('hides the Courts tab from a member without courts.manage', () => {
  grantBaselineMember();

  renderWithProviders(<MatterConfigPage />);

  expect(screen.getByRole('button', { name: /Practice Areas/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Courts/ })).not.toBeInTheDocument();
});

it('offers the Courts tab to a member holding courts.manage', () => {
  grantBaselineMember(['courts.manage']);

  renderWithProviders(<MatterConfigPage />);

  expect(screen.getByRole('button', { name: /Courts/ })).toBeInTheDocument();
});
