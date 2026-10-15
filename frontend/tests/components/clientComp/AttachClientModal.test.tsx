import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import AttachClientModal, { type AttachClientTarget } from '@/components/clientComp/AttachClientModal';
import { useEntityLookup, useDuplicateNameCheck } from '@/hooks/useEntityLookup';
import clientsService from '@/services/clients.service';

jest.mock('@/hooks/useEntityLookup');
jest.mock('@/services/clients.service');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="org-autocomplete"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search organizations"
    />
  ),
}));

describe('AttachClientModal', () => {
  const mockTarget: AttachClientTarget = {
    label: 'Matter',
    attachedClientIds: [],
    attach: jest.fn().mockResolvedValue(undefined),
    invalidateKeys: [],
  };

  beforeEach(() => {
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [
        { id: 'client-1', label: 'Alice Smith', sublabel: 'alice@example.com', clientType: 'person' },
      ],
      hasMore: false,
      loading: false,
    });
    (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
    (clientsService.getClient as jest.Mock).mockResolvedValue({
      id: 'client-1',
      name: 'Alice Smith',
      clientType: 'person',
    });
    (clientsService.createClient as jest.Mock).mockResolvedValue({ clientId: 'client-new' });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders search mode and lists available clients to attach', () => {
    renderWithProviders(
      <AttachClientModal
        open={true}
        onClose={jest.fn()}
        lawFirmId="firm-1"
        target={mockTarget}
      />,
    );

    expect(screen.getByText('Add Client to Matter')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('attaches existing client on click', async () => {
    const handleClose = jest.fn();

    renderWithProviders(
      <AttachClientModal
        open={true}
        onClose={handleClose}
        lawFirmId="firm-1"
        target={mockTarget}
      />,
    );

    const clientRow = screen.getByText('Alice Smith');
    fireEvent.click(clientRow);

    await waitFor(() => {
      expect(mockTarget.attach).toHaveBeenCalledWith({
        clientId: 'client-1',
        name: 'Alice Smith',
      });
      expect(handleClose).toHaveBeenCalled();
    });
  });
});
