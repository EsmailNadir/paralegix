import { render, screen } from '@testing-library/react';
import ClientStatusBadge from '@/components/ui/ClientStatusBadge';

describe('ClientStatusBadge', () => {
  it.each([
    ['active', 'Active'],
    ['inactive', 'Inactive'],
    ['archived', 'Archived'],
    [null, 'Active'],
  ] as const)('renders status %p as %s', (status, label) => {
    render(<ClientStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
