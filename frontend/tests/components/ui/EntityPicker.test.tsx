import { render, screen } from '@testing-library/react';
import EntityPicker from '@/components/ui/EntityPicker';
import { useEntityLookup, useEntityByIds } from '@/hooks/useEntityLookup';

jest.mock('@/hooks/useEntityLookup');

describe('EntityPicker', () => {
  beforeEach(() => {
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [
        { id: 'matter-1', label: 'Smith Estate Planning' },
        { id: 'matter-2', label: 'Jones v. City' },
      ],
      hasMore: false,
      loading: false,
      isPlaceholder: false,
    });
    (useEntityByIds as jest.Mock).mockReturnValue({
      items: [{ id: 'matter-1', label: 'Smith Estate Planning' }],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders dropdown picker with selected entity label', () => {
    render(
      <EntityPicker
        entity="matters"
        lawFirmId="firm-1"
        value="matter-1"
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText('Smith Estate Planning')).toBeInTheDocument();
  });
});
