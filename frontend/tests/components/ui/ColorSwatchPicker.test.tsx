import { render, screen, fireEvent } from '@testing-library/react';
import ColorSwatchPicker from '@/components/ui/ColorSwatchPicker';

describe('ColorSwatchPicker', () => {
  const colors = ['#3B82F6', '#10B981', '#EF4444'] as const;

  it('renders all color swatches and marks selected color', () => {
    render(
      <ColorSwatchPicker
        colors={colors}
        value="#10B981"
        onChange={jest.fn()}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);

    const selectedBtn = screen.getByRole('button', { name: 'Color #10B981' });
    expect(selectedBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onChange when a swatch is clicked', () => {
    const handleChange = jest.fn();

    render(
      <ColorSwatchPicker
        colors={colors}
        value="#3B82F6"
        onChange={handleChange}
      />,
    );

    const greenBtn = screen.getByRole('button', { name: 'Color #10B981' });
    fireEvent.click(greenBtn);

    expect(handleChange).toHaveBeenCalledWith('#10B981');
  });
});
