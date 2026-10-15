/**
 * `AttachClientModal` moving between its search, edit and create views.
 *
 * The create and edit views share one set of form fields. Two ways that went
 * wrong both end in a wrong client record:
 *
 *   OPENING "CREATE" AFTER "EDIT" MUST START BLANK. Otherwise the edited
 *   client's email, phone and address ride along into a brand-new client.
 *
 *   A SLOW DETAIL READ FOR ONE CLIENT MUST NOT LAND ON ANOTHER. Editing client A,
 *   going back and editing client B, then having A's detail arrive late must
 *   leave B's details in the form, or "Save & Add" writes A's details onto B.
 */
// Stable handles: the global service mock hands out a fresh function on every
// property access, so a per-spec answer would never reach the component.
const mockGetClient = jest.fn();
jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: { getClient: (...args: unknown[]) => mockGetClient(...args) },
}));

import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import AttachClientModal, { type AttachClientTarget } from '@/components/clientComp/AttachClientModal';
import { useEntityLookup, useDuplicateNameCheck } from '@/hooks/useEntityLookup';

jest.mock('@/hooks/useEntityLookup');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="Organization" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const ALICE = { id: 'client-1', label: 'Alice Smith', sublabel: 'alice@example.com', clientType: 'person' };
const BOB = { id: 'client-2', label: 'Bob Jones', sublabel: 'bob@example.com', clientType: 'person' };

function target(): AttachClientTarget {
  return { label: 'Matter', attachedClientIds: [], attach: jest.fn().mockResolvedValue(undefined), invalidateKeys: [] };
}

function editButtons() {
  return screen.getAllByRole('button', { name: 'Edit Client' });
}

beforeEach(() => {
  (useEntityLookup as jest.Mock).mockReturnValue({ items: [ALICE, BOB], hasMore: false, loading: false });
  (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
});

afterEach(() => {
  jest.clearAllMocks();
  mockGetClient.mockReset();
});

describe('opening Create after editing a client', () => {
  // Red if: switching to create keeps the edited client's fields.
  it('starts from an empty form', async () => {
    mockGetClient.mockResolvedValue({
      id: 'client-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      phone: '555-0100',
      address: '1 Main St',
      preferredContactMethod: 'phone',
      clientType: 'person',
    });
    renderWithProviders(<AttachClientModal open onClose={jest.fn()} lawFirmId="firm-1" target={target()} />);

    fireEvent.click(editButtons()[0]);
    await waitFor(() => expect(screen.getByPlaceholderText('(555) 123-4567')).toHaveValue('555-0100'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    fireEvent.click(screen.getByRole('button', { name: /Create New Client/ }));

    expect(screen.getByRole('heading', { name: 'Create New Client' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Full name')).toHaveValue('');
    expect(screen.getByPlaceholderText('email@example.com')).toHaveValue('');
    expect(screen.getByPlaceholderText('(555) 123-4567')).toHaveValue('');
    expect(screen.getByPlaceholderText('Street, City, State ZIP')).toHaveValue('');
  });
});

describe('a client detail that arrives after the user moved on', () => {
  // Red if: the late response for the first client overwrites the second's form.
  it('leaves the client now being edited in the form', async () => {
    let resolveAlice: (value: unknown) => void = () => {};
    mockGetClient.mockImplementation((_firm: string, id: string) =>
      id === 'client-1'
        ? new Promise((resolve) => { resolveAlice = resolve; })
        : Promise.resolve({ id: 'client-2', name: 'Bob Jones', email: 'bob@example.com', phone: '555-0200', clientType: 'person' }),
    );
    renderWithProviders(<AttachClientModal open onClose={jest.fn()} lawFirmId="firm-1" target={target()} />);

    fireEvent.click(editButtons()[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    fireEvent.click(editButtons()[1]);
    await waitFor(() => expect(screen.getByPlaceholderText('(555) 123-4567')).toHaveValue('555-0200'));

    await act(async () => {
      resolveAlice({ id: 'client-1', name: 'Alice Smith', email: 'alice@example.com', phone: '555-0100', clientType: 'person' });
    });

    expect(screen.getByPlaceholderText('Full name')).toHaveValue('Bob Jones');
    expect(screen.getByPlaceholderText('email@example.com')).toHaveValue('bob@example.com');
    expect(screen.getByPlaceholderText('(555) 123-4567')).toHaveValue('555-0200');
  });
});
