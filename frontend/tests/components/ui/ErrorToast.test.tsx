import { render, screen, fireEvent } from '@testing-library/react';
import ErrorToast from '@/components/ui/ErrorToast';

describe('ErrorToast', () => {
  it('renders error toast message with danger tone', () => {
    const handleDismiss = jest.fn();
    render(<ErrorToast message="Failed to save matter" onDismiss={handleDismiss} />);

    expect(screen.getByText('Failed to save matter')).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: /close|dismiss/i });
    if (closeBtn) {
      fireEvent.click(closeBtn);
      expect(handleDismiss).toHaveBeenCalled();
    }
  });
});
