import { render, screen } from '@testing-library/react';
import CountPill from '@/components/ui/CountPill';

describe('CountPill', () => {
  it('renders count pill with neutral styling by default', () => {
    render(<CountPill count={5} />);
    const pill = screen.getByText('5');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('bg-surface');
  });

  it('renders accent tone when requested', () => {
    render(<CountPill count={12} tone="accent" />);
    const pill = screen.getByText('12');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('bg-accent-solid');
  });

  it('returns null when count is 0 and showZero is false', () => {
    const { container } = render(<CountPill count={0} showZero={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders 0 when showZero is true', () => {
    render(<CountPill count={0} showZero={true} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('caps large counts when a maximum is provided', () => {
    render(<CountPill count={120} max={99} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });
});
