import { render, screen, fireEvent } from '@testing-library/react';
import DateRangePicker from '@/components/ui/DateRangePicker';

describe('DateRangePicker', () => {
  it('renders placeholder when no date bounds are provided', () => {
    render(<DateRangePicker from="" to="" onChange={jest.fn()} placeholder="Select dates" />);
    expect(screen.getByText('Select dates')).toBeInTheDocument();
  });

  it('renders formatted date span when both endpoints are provided', () => {
    render(<DateRangePicker from="2026-09-01" to="2026-09-30" onChange={jest.fn()} />);
    expect(screen.getByText('Sep 1 – Sep 30, 2026')).toBeInTheDocument();
  });

  it('opens calendar dialog on click and allows clearing selection', () => {
    const handleChange = jest.fn();

    render(
      <DateRangePicker
        from="2026-09-01"
        to="2026-09-30"
        onChange={handleChange}
      />,
    );

    const triggerBtn = screen.getByRole('button', { name: /Sep 1 – Sep 30, 2026/i });
    fireEvent.click(triggerBtn);

    expect(screen.getByRole('dialog', { name: 'Choose a date range' })).toBeInTheDocument();

    const clearBtn = screen.getByRole('button', { name: 'Clear' });
    fireEvent.click(clearBtn);

    expect(handleChange).toHaveBeenCalledWith({ from: undefined, to: undefined });
  });
});
