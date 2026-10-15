import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ToggleSwitch from '@/components/ui/ToggleSwitch';

describe('ToggleSwitch', () => {
  it('renders a switch button with aria-checked matching checked prop', () => {
    const { rerender } = render(
      <ToggleSwitch
        checked={false}
        onChange={jest.fn()}
        ariaLabel="Email notifications"
      />
    );

    const toggle = screen.getByRole('switch', { name: 'Email notifications' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    rerender(
      <ToggleSwitch
        checked={true}
        onChange={jest.fn()}
        ariaLabel="Email notifications"
      />
    );

    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange when clicked', () => {
    const handleChange = jest.fn();

    render(
      <ToggleSwitch
        checked={false}
        onChange={handleChange}
        ariaLabel="Dark mode"
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }));
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('disables the switch and does not fire onChange when disabled', () => {
    const handleChange = jest.fn();

    render(
      <ToggleSwitch
        checked={true}
        onChange={handleChange}
        disabled={true}
        ariaLabel="Locked setting"
      />
    );

    const toggle = screen.getByRole('switch', { name: 'Locked setting' });
    expect(toggle).toBeDisabled();

    fireEvent.click(toggle);
    expect(handleChange).not.toHaveBeenCalled();
  });
});
