import React, { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockLookupClients = jest.fn();
jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: { lookupClients: (...args: unknown[]) => mockLookupClients(...args) },
}));

import ClientOrganizationAutocomplete from '@/components/clientComp/ClientOrganizationAutocomplete';

const onSelectCompany = jest.fn();

function Harness() {
  const [value, setValue] = useState('');
  return (
    <ClientOrganizationAutocomplete
      value={value}
      onChange={setValue}
      onSelectCompany={onSelectCompany}
      lawFirmId="firm-1"
    />
  );
}

beforeEach(() => {
  mockLookupClients.mockReset();
  onSelectCompany.mockReset();
  mockLookupClients.mockResolvedValue({ items: [{ id: 'co-1', label: 'Acme Holdings' }] });
});

describe('ClientOrganizationAutocomplete', () => {
  it('renders the canonical input classes with caller classes appended', () => {
    render(<ClientOrganizationAutocomplete value="" onChange={jest.fn()} lawFirmId="firm-1" className="text-xs" />);
    expect(screen.getByRole('combobox').className.trim()).toBe(
      'w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface '
      + 'placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring text-xs',
    );
  });

  it('shows a search failure instead of a blank menu or a no-matches message', async () => {
    mockLookupClients.mockRejectedValue(new Error('Lookup unavailable'));
    render(<Harness />);

    await userEvent.type(screen.getByRole('combobox'), 'acme');
    expect(await screen.findByText('Could not search organizations. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('No matching organizations found.')).not.toBeInTheDocument();
  });

  it('shows an empty-result message after the organization lookup finds no matches', async () => {
    mockLookupClients.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByRole('combobox'), 'unknown');

    expect(await screen.findByText('No matching organizations found.')).toBeInTheDocument();
    expect(mockLookupClients).toHaveBeenCalledWith('firm-1', expect.objectContaining({ search: 'unknown', clientType: 'company' }));
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('No matching organizations found.')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('waits for the lookup response before saying there are no matches', async () => {
    let resolveLookup!: (value: { items: [] }) => void;
    mockLookupClients.mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    render(<Harness />);

    await userEvent.type(screen.getByRole('combobox'), 'unknown');
    expect(await screen.findByText('Searching organizations…')).toBeInTheDocument();
    expect(screen.queryByText('No matching organizations found.')).not.toBeInTheDocument();

    await act(async () => resolveLookup({ items: [] }));
    expect(await screen.findByText('No matching organizations found.')).toBeInTheDocument();
  });

  it('clears the empty-result message when the search is shorter than two characters', async () => {
    mockLookupClients.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByRole('combobox'), 'unknown');
    expect(await screen.findByText('No matching organizations found.')).toBeInTheDocument();
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'a');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching organizations found.')).not.toBeInTheDocument();
  });

  it('renders the suggestions outside the field, so a clipping parent cannot cut them off', async () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <Harness />
      </div>,
    );

    await userEvent.type(screen.getByRole('combobox'), 'acme');
    const listbox = await screen.findByRole('listbox');

    expect(container.contains(listbox)).toBe(false);
    expect(listbox.style.position).toBe('fixed');
  });

  it('still picks a suggestion from the portalled list', async () => {
    render(<Harness />);

    await userEvent.type(screen.getByRole('combobox'), 'acme');
    await userEvent.click(await screen.findByRole('option', { name: /Acme Holdings/ }));

    expect(onSelectCompany).toHaveBeenCalledWith(expect.objectContaining({ id: 'co-1' }));
  });
});
