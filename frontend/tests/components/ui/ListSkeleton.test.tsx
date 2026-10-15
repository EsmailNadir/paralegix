import { render, screen } from '@testing-library/react';
import ListSkeleton from '@/components/ui/ListSkeleton';

describe('ListSkeleton', () => {
  it('renders status role with accessible loading label and default rows', () => {
    const { container } = render(<ListSkeleton label="Loading matters" rows={4} />);

    const statusEl = screen.getByRole('status', { name: 'Loading matters' });
    expect(statusEl).toBeInTheDocument();

    const rowElements = container.querySelectorAll('.flex.items-center.gap-4');
    expect(rowElements).toHaveLength(4);
  });

  it('supports unbordered mode when rendered inside an existing container', () => {
    const { container } = render(<ListSkeleton bordered={false} />);
    const rootDiv = container.querySelector('[role="status"]');
    expect(rootDiv?.className).not.toContain('border');
  });
});
