import { render, screen, fireEvent } from '@testing-library/react';
import BackButton from '@/components/ui/BackButton';
import { useNavigation } from '@/contexts/NavigationContext';

jest.mock('@/contexts/NavigationContext', () => ({
  useNavigation: jest.fn(),
}));

describe('BackButton', () => {
  const mockNavigate = jest.fn();

  beforeEach(() => {
    (useNavigation as jest.Mock).mockReturnValue({
      navigate: mockNavigate,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders icon variant with tooltip label and triggers navigation', () => {
    render(<BackButton href="/lawfirm/firm-1/matters" label="Back to Matters" variant="icon" />);

    const btn = screen.getByRole('button', { name: 'Back to Matters' });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/matters');
  });

  it('renders link variant with text and triggers navigation', () => {
    render(<BackButton href="/lawfirm/firm-1/clients" label="All Clients" variant="link" />);

    const btn = screen.getByRole('button', { name: 'All Clients' });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/clients');
  });

  it('steps back within the page instead of navigating when given onClick', () => {
    const onClick = jest.fn();
    render(<BackButton onClick={onClick} label="Back" variant="link" />);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
