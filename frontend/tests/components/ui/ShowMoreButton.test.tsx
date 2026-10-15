import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ShowMoreButton from '@/components/ui/ShowMoreButton';

describe('ShowMoreButton', () => {
  it('renders nothing when hiddenCount is zero or negative', () => {
    const { rerender } = render(
      <ShowMoreButton
        expanded={false}
        hiddenCount={0}
        onToggle={jest.fn()}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <ShowMoreButton
        expanded={false}
        hiddenCount={-3}
        onToggle={jest.fn()}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders "Show N more" when collapsed with hiddenCount > 0', () => {
    render(
      <ShowMoreButton
        expanded={false}
        hiddenCount={7}
        onToggle={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeInTheDocument();
  });

  it('renders "Show less" when expanded', () => {
    render(
      <ShowMoreButton
        expanded={true}
        hiddenCount={7}
        onToggle={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('calls onToggle when clicked', () => {
    const handleToggle = jest.fn();

    render(
      <ShowMoreButton
        expanded={false}
        hiddenCount={4}
        onToggle={handleToggle}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more' }));
    expect(handleToggle).toHaveBeenCalledTimes(1);
  });
});
