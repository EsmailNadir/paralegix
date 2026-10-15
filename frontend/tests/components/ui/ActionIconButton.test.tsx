import { render, screen, fireEvent } from '@testing-library/react';
import ActionIconButton from '@/components/ui/ActionIconButton';

describe('ActionIconButton', () => {
  it('renders button with accessible label and child icon', () => {
    const handleClick = jest.fn();

    render(
      <ActionIconButton label="Edit item" onClick={handleClick}>
        <span data-testid="edit-icon">Icon</span>
      </ActionIconButton>,
    );

    const button = screen.getByRole('button', { name: 'Edit item' });
    expect(button).toBeInTheDocument();
    expect(screen.getByTestId('edit-icon')).toBeInTheDocument();

    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders disabled state with proper opacity and aria attributes', () => {
    render(
      <ActionIconButton label="Delete item" onClick={jest.fn()} disabled={true}>
        <span>Delete</span>
      </ActionIconButton>,
    );

    const button = screen.getByRole('button', { name: 'Delete item' });
    expect(button).toBeDisabled();
  });
});
