/**
 * The court-name field searches the global court directory through the REAL
 * catalog service against a fake transport. The cases here pin what the menu
 * says when the directory has nothing to offer, since a silent empty menu reads
 * as a broken field.
 */
jest.unmock('@/services/requestDeduplicator');

import React, { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import CourtNameAutocomplete from '@/components/courtsComp/CourtNameAutocomplete';

const SEARCH_PATH = '/api/lawfirms/firm-1/catalog/courts';

let api: ApiMock;
const onSelect = jest.fn();

function Harness() {
  const [value, setValue] = useState('');
  return <CourtNameAutocomplete value={value} onChange={setValue} onSelect={onSelect} lawFirmId="firm-1" />;
}

beforeEach(() => {
  api = installApiMock();
  onSelect.mockReset();
});

afterEach(() => {
  api.restore();
});

describe('CourtNameAutocomplete', () => {
  it('lists directory matches and fills the court on click', async () => {
    api.getExact(`${SEARCH_PATH}?search=ohio&limit=8`, {
      items: [{ id: 'c1', fullName: 'Supreme Court of Ohio', state: 'OH', courtType: 'supreme' }],
    });
    renderWithProviders(<Harness />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Court name' }), 'ohio');
    await userEvent.click(await screen.findByRole('option', { name: /Supreme Court of Ohio/ }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('renders the menu outside the field, so a clipping parent cannot cut it off', async () => {
    api.getExact(`${SEARCH_PATH}?search=ohio&limit=8`, {
      items: [{ id: 'c1', fullName: 'Supreme Court of Ohio', state: 'OH', courtType: 'supreme' }],
    });
    const { container } = renderWithProviders(
      <div data-testid="clipper" style={{ overflow: 'hidden' }}>
        <Harness />
      </div>,
    );

    await userEvent.type(screen.getByRole('combobox', { name: 'Court name' }), 'ohio');
    const listbox = await screen.findByRole('listbox');

    expect(container.contains(listbox)).toBe(false);
    expect(listbox.style.position).toBe('fixed');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-controls', listbox.id);
  });

  it('says the directory has no match instead of showing nothing', async () => {
    api.getExact(`${SEARCH_PATH}?search=ohio&limit=8`, { items: [] });
    renderWithProviders(<Harness />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Court name' }), 'ohio');

    expect(
      await screen.findByText('No match in the court directory. You can still add it by name.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('says the search failed when the directory request errors', async () => {
    api.getExact(`${SEARCH_PATH}?search=ohio&limit=8`, { status: 500, body: { error: 'boom' } });
    renderWithProviders(<Harness />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Court name' }), 'ohio');

    expect(
      await screen.findByText('Could not search the court directory. You can still add it by name.'),
    ).toBeInTheDocument();
  });

  it('shows no menu below two characters', async () => {
    renderWithProviders(<Harness />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Court name' }), 'o');

    // Longer than the debounce, so a request would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(api.calls()).toHaveLength(0);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
