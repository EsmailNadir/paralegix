import { render, screen } from '@testing-library/react';
import FieldError from '@/components/ui/FieldError';

describe('FieldError', () => {
  it('renders nothing when message is empty or null', () => {
    const { container } = render(<FieldError message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders alert paragraph with error message', () => {
    render(<FieldError message="Name is required" />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Name is required');
  });
});
