import { render, screen } from '@testing-library/react';
import MatterClientPicker from '@/components/matterComp/matterForm/MatterClientPicker';
import { useEntityLookup } from '@/hooks/useEntityLookup';

jest.mock('@/hooks/useEntityLookup');

describe('MatterClientPicker', () => {
  beforeEach(() => {
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [
        { id: 'client-1', label: 'Bruce Wayne', sublabel: 'bruce@wayne.test', clientType: 'person' },
        { id: 'client-2', label: 'Lex Corp', sublabel: 'lex@lexcorp.test', clientType: 'company' },
      ],
      hasMore: false,
      loading: false,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders client search dropdown picker', () => {
    render(
      <MatterClientPicker
        lawFirmId="firm-1"
        excludeIds={['client-1']}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByText('Search existing clients by name or email...')).toBeInTheDocument();
  });
});
