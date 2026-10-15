import { render, screen, fireEvent } from '@testing-library/react';
import BillingSummaryCard from '@/components/billingComp/BillingSummaryCard';

describe('BillingSummaryCard', () => {
  it('renders label, value, and subtitle', () => {
    render(
      <BillingSummaryCard
        label="Total Outstanding"
        value="$12,450.00"
        subtitle="3 unpaid invoices"
      />,
    );

    expect(screen.getByText('Total Outstanding')).toBeInTheDocument();
    expect(screen.getByText('$12,450.00')).toBeInTheDocument();
    expect(screen.getByText('3 unpaid invoices')).toBeInTheDocument();
  });

  it('applies highlight style when highlight prop is true', () => {
    const { container } = render(
      <BillingSummaryCard
        label="Overdue Balance"
        value="$3,500.00"
        highlight={true}
      />,
    );

    const valueEl = screen.getByText('$3,500.00');
    expect(valueEl.className).toContain('text-rose-600');
  });

  it('renders as a clickable button when onClick is provided', () => {
    const handleClick = jest.fn();
    render(
      <BillingSummaryCard
        label="Unbilled Hours"
        value="45.5 hrs"
        onClick={handleClick}
      />,
    );

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
