import { render, screen } from '@testing-library/react';
import ListBusyIndicator from '@/components/ui/ListBusyIndicator';

describe('ListBusyIndicator', () => {
  it('renders visible status when busy is true', () => {
    render(<ListBusyIndicator busy={true} label="Refreshing list…" />);

    const indicator = screen.getByRole('status');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Refreshing list…');
    expect(indicator.className).not.toContain('invisible');
  });

  it('renders invisible placeholder when busy is false to preserve layout space', () => {
    const { container } = render(<ListBusyIndicator busy={false} />);

    const div = container.querySelector('div');
    expect(div).toBeInTheDocument();
    expect(div?.className).toContain('invisible');
  });
});
