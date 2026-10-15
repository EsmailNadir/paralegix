import React from 'react';
import { render, screen } from '@testing-library/react';
import InvalidLinkPage from '@/components/ui/InvalidLinkPage';
import { AppShellContext } from '@/contexts/AppShellContext';

it('makes the existing standalone invalid-link content a main landmark and focuses its result heading', () => {
  const view = render(<InvalidLinkPage title="The invitation expired" />);
  const heading = screen.getByRole('heading', { name: 'The invitation expired', level: 1 });
  expect(screen.getByRole('main')).toContainElement(heading);
  expect(heading).toHaveFocus();
  expect(screen.getByRole('link', { name: 'Back to login' })).toHaveAttribute('href', '/login');
  view.rerender(<InvalidLinkPage title="The reset link expired" />);
  expect(screen.getByRole('heading', { name: 'The reset link expired' })).toHaveFocus();
});

it('keeps one main landmark when the status screen is rendered inside the client shell', () => {
  render(<AppShellContext.Provider value><main><InvalidLinkPage /></main></AppShellContext.Provider>);
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
});
