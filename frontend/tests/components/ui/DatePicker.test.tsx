import { render, screen, fireEvent, within } from '@testing-library/react';
import DatePicker from '@/components/ui/DatePicker';

describe('DatePicker', () => {
  it('renders placeholder when no value is provided', () => {
    render(<DatePicker value="" onChange={jest.fn()} placeholder="Pick deadline" />);
    expect(screen.getByText('Pick deadline')).toBeInTheDocument();
  });

  it('renders formatted date when value is provided', () => {
    render(<DatePicker value="2026-10-15" onChange={jest.fn()} />);
    expect(screen.getByText('Oct 15, 2026')).toBeInTheDocument();
  });

  it('opens calendar dialog on click', () => {
    render(<DatePicker value="2026-10-15" onChange={jest.fn()} />);

    const triggerBtn = screen.getByRole('button', { name: /Oct 15, 2026/i });
    fireEvent.click(triggerBtn);

    expect(screen.getByRole('dialog', { name: 'Choose a date' })).toBeInTheDocument();
    expect(screen.getByText('October 2026')).toBeInTheDocument();
  });

  it('opens an empty picker on the month it is pointed at, not the current one', () => {
    render(<DatePicker value="" openTo="2026-05-20" onChange={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Select date/ }));

    expect(within(screen.getByRole('dialog', { name: 'Choose a date' })).getByText(/May 2026/)).toBeInTheDocument();
  });
});
