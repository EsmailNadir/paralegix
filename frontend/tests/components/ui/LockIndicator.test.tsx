import { render, screen } from '@testing-library/react';
import LockIndicator from '@/components/ui/LockIndicator';

describe('LockIndicator', () => {
  it('renders default administrator message', () => {
    render(<LockIndicator />);
    expect(screen.getByText('This setting is managed by your firm administrator.')).toBeInTheDocument();
  });

  it('renders custom lock message when provided', () => {
    render(<LockIndicator message="Managed by enterprise policy" />);
    expect(screen.getByText('Managed by enterprise policy')).toBeInTheDocument();
  });
});
