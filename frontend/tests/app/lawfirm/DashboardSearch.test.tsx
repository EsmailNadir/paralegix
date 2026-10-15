/**
 * The firm dashboard's search bar and its results menu.
 *
 * The menu stays mounted for its exit animation after it closes. The clear
 * button empties the query in the same click that closes it, so a menu reading
 * the live query fades out saying 'No results for ""'. It must keep the term it
 * was showing until it is gone.
 *
 * The page's data hooks are replaced: the summary aggregate and the firm-wide
 * search are covered by their own specs, and the subject here is only what the
 * page draws from the query while the menu closes.
 */
// Each mocked hook hands back the same object on every render, as React Query
// does for settled data. A fresh object per render re-runs the page's effects
// that depend on it and never settles.
jest.mock('@/hooks/dashboardHooks/useDashboardSummary', () => {
  const summary = { data: {}, isLoading: false, error: null, refetch: jest.fn() };
  return { __esModule: true, useDashboardSummary: () => summary };
});

// A term that matches nothing, answered at once, so the menu shows its empty
// state rather than a spinner.
jest.mock('@/hooks/dashboardHooks/useDashboardSearch', () => {
  const search = {
    results: { matters: [], clients: [], tasks: [], conversations: [] },
    loading: false,
  };
  return { __esModule: true, useDashboardSearch: () => search };
});

jest.mock('@/hooks/useSigningRealtime', () => ({
  __esModule: true,
  useFirmSigningRealtime: () => undefined,
}));

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import LawFirmDashboardPage from '@/app/lawfirm/[lawFirmId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';

describe('dashboard search results menu', () => {
  it('keeps the searched term in the empty-results line while the cleared menu animates closed', async () => {
    renderWithProviders(<LawFirmDashboardPage />);

    const input = await screen.findByPlaceholderText('Search matters, tasks, clients, or messages...');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'abc' } });

    const emptyLine = screen.getByText('No results for “abc”');
    const menu = emptyLine.closest('.origin-top') as HTMLElement;
    expect(menu).toHaveClass('overlay-menu-enter');

    // The clear button is the only control inside the search box besides the input.
    const clear = input.parentElement!.querySelector('button') as HTMLButtonElement;
    fireEvent.click(clear);

    expect(input).toHaveValue('');
    expect(menu).toHaveClass('overlay-menu-exit');
    expect(menu).toHaveTextContent('No results for “abc”');
  });
});
