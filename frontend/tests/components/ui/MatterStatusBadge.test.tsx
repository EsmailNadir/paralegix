import { render, screen } from '@testing-library/react';
import MatterStatusBadge from '@/components/ui/MatterStatusBadge';

describe('MatterStatusBadge', () => {
  it.each([
    ['active', 'Active'],
    ['completed', 'Completed'],
    ['archived', 'Archived'],
    [null, 'Active'],
  ] as const)('renders status %p as %s', (status, label) => {
    render(<MatterStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
