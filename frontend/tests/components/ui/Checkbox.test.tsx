import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Checkbox from '@/components/ui/Checkbox';

describe('Checkbox', () => {
  it('renders a checkbox input with checked state', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={jest.fn()} />);

    const input = screen.getByRole('checkbox');
    expect(input).not.toBeChecked();

    rerender(<Checkbox checked={true} onChange={jest.fn()} />);
    expect(input).toBeChecked();
  });

  it('renders label and description when provided in standalone mode', () => {
    render(
      <Checkbox
        checked={false}
        onChange={jest.fn()}
        label="Billable item"
        description="Include in next invoice calculation"
      />
    );

    expect(screen.getByText('Billable item')).toBeInTheDocument();
    expect(screen.getByText('Include in next invoice calculation')).toBeInTheDocument();
  });

  it('calls onChange with inverted boolean when clicked', () => {
    const handleChange = jest.fn();

    render(
      <Checkbox
        checked={false}
        onChange={handleChange}
        label="Enable notifications"
      />
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it('disables input and does not fire onChange when disabled is true', () => {
    const handleChange = jest.fn();

    render(
      <Checkbox
        checked={true}
        onChange={handleChange}
        disabled={true}
        label="Locked item"
      />
    );

    const input = screen.getByRole('checkbox');
    expect(input).toBeDisabled();

    fireEvent.click(input);
    expect(handleChange).not.toHaveBeenCalled();
  });
});
