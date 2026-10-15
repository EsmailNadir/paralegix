import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SegmentedToggle, { type SegmentedToggleOption } from '@/components/ui/SegmentedToggle';

type ViewMode = 'list' | 'grid' | 'kanban';

const options: SegmentedToggleOption<ViewMode>[] = [
  { value: 'list', label: 'List View', count: 12 },
  { value: 'grid', label: 'Grid View' },
  { value: 'kanban', label: 'Board View', count: 5 },
];

describe('SegmentedToggle', () => {
  it('renders all options and marks the active value with aria-pressed', () => {
    render(
      <SegmentedToggle
        options={options}
        value="list"
        onChange={jest.fn()}
        ariaLabel="Choose view"
      />
    );

    const group = screen.getByRole('group', { name: 'Choose view' });
    expect(group).toBeInTheDocument();

    const listBtn = screen.getByRole('button', { name: /List View/ });
    const gridBtn = screen.getByRole('button', { name: /Grid View/ });
    const boardBtn = screen.getByRole('button', { name: /Board View/ });

    expect(listBtn).toHaveAttribute('aria-pressed', 'true');
    expect(gridBtn).toHaveAttribute('aria-pressed', 'false');
    expect(boardBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders count badges when specified', () => {
    render(
      <SegmentedToggle
        options={options}
        value="list"
        onChange={jest.fn()}
      />
    );

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('calls onChange with the selected value when an inactive button is clicked', () => {
    const handleChange = jest.fn();

    render(
      <SegmentedToggle
        options={options}
        value="list"
        onChange={handleChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Board View/ }));

    expect(handleChange).toHaveBeenCalledWith('kanban');
  });

  it('uses option label as aria-label when hideLabels is true', () => {
    render(
      <SegmentedToggle
        options={options}
        value="grid"
        onChange={jest.fn()}
        hideLabels={true}
      />
    );

    const gridBtn = screen.getByRole('button', { name: 'Grid View' });
    expect(gridBtn).toBeInTheDocument();
    expect(gridBtn).toHaveAttribute('aria-pressed', 'true');
  });
});
