import { render, screen, fireEvent } from '@testing-library/react';
import DateTimePicker from '@/components/ui/DateTimePicker';

describe('DateTimePicker', () => {
  it('renders placeholder when no datetime is provided', () => {
    render(<DateTimePicker value="" onChange={jest.fn()} placeholder="Pick event time" />);
    expect(screen.getByText('Pick event time')).toBeInTheDocument();
  });

  it('renders formatted date and time when value is provided', () => {
    render(<DateTimePicker value="2026-10-15T14:30" onChange={jest.fn()} />);
    expect(screen.getByText('Oct 15, 2026, 2:30 PM')).toBeInTheDocument();
  });

  it('opens dialog on click and displays calendar and time controls', () => {
    render(<DateTimePicker value="2026-10-15T14:30" onChange={jest.fn()} />);

    const triggerBtn = screen.getByRole('button', { name: /Oct 15, 2026, 2:30 PM/i });
    fireEvent.click(triggerBtn);

    expect(screen.getByRole('dialog', { name: 'Choose a date and time' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Hour' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'Minute' })).toHaveValue(30);
  });

  describe('time only', () => {
    it('keeps the repeated-hour offset when the existing time field is blurred unchanged', () => {
      const onChange = jest.fn();
      render(<DateTimePicker timeOnly value="2026-11-01T01:30-08:00" onChange={onChange} aria-label="End time" />);
      fireEvent.click(screen.getByRole('button', { name: 'End time' }));
      fireEvent.blur(screen.getByRole('spinbutton', { name: 'Minute' }));
      expect(onChange).toHaveBeenLastCalledWith('2026-11-01T01:30-08:00');
    });
    it('reads as a time with no date and opens without the month grid', () => {
      render(<DateTimePicker timeOnly value="2026-10-15T14:30" onChange={jest.fn()} aria-label="Start time" />);

      const trigger = screen.getByRole('button', { name: 'Start time' });
      expect(trigger).toHaveTextContent('2:30 PM');
      expect(trigger).not.toHaveTextContent('Oct 15');

      fireEvent.click(trigger);
      expect(screen.getByRole('dialog', { name: 'Choose a time' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '15' })).not.toBeInTheDocument();
    });

    it('keeps the day it was given when a time is picked on an empty value', () => {
      const onChange = jest.fn();
      render(<DateTimePicker timeOnly day="2026-10-20" value="" onChange={onChange} aria-label="Start time" />);

      fireEvent.click(screen.getByRole('button', { name: 'Start time' }));
      const hour = screen.getByRole('spinbutton', { name: 'Hour' });
      fireEvent.change(hour, { target: { value: '9' } });
      fireEvent.blur(hour);

      // An empty value starts at noon, so 9 stays on the PM side.
      expect(onChange).toHaveBeenLastCalledWith('2026-10-20T21:00');
    });
  });
});
