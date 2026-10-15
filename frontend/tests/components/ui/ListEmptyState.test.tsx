import { render, screen } from '@testing-library/react';
import ListEmptyState from '@/components/ui/ListEmptyState';

describe('ListEmptyState', () => {
  it('renders title and descriptive message', () => {
    render(
      <ListEmptyState
        title="No matters found"
        message="Create your first matter to begin tracking legal work."
      />,
    );

    expect(screen.getByText('No matters found')).toBeInTheDocument();
    expect(screen.getByText('Create your first matter to begin tracking legal work.')).toBeInTheDocument();
  });

  it('renders call to action button when provided', () => {
    render(
      <ListEmptyState
        title="No invoices"
        action={<button>Generate Invoice</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Generate Invoice' })).toBeInTheDocument();
  });
});
