import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Terms from '@/app/terms/page';
import Privacy from '@/app/privacy/page';
import Subprocessors from '@/app/subprocessors/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { scanAccessibility } from '../../support/accessibility';
it.each([
  [Terms, 'Terms of Service', '/terms'], [Privacy, 'Privacy Policy', '/privacy'], [Subprocessors, 'Sub-processors', '/subprocessors'],
] as const)('provides native legal destinations, current state and a working skip target on %s', async (Page, title, href) => {
  const { container } = renderWithProviders(<Page />);
  const nav = screen.getByRole('navigation', { name: 'Legal' });
  expect(within(nav).getByRole('link', { name: title })).toHaveAttribute('href', href);
  expect(within(nav).getByRole('link', { name: title })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/login');
  expect(screen.getByRole('link', { name: 'Get Started' })).toHaveAttribute('href', '/register');
  expect(screen.getByRole('link', { name: 'Paralegix home' })).toHaveAttribute('href', '/');
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('main')).toHaveFocus();
  expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});
