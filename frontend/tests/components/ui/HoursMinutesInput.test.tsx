import { render, screen, fireEvent } from '@testing-library/react';
import HoursMinutesInput from '@/components/ui/HoursMinutesInput';

describe('HoursMinutesInput', () => {
  it('renders hours and minutes inputs with stepper buttons', () => {
    const handleHoursChange = jest.fn();
    const handleMinutesChange = jest.fn();

    render(
      <HoursMinutesInput
        hours="2"
        minutes="30"
        onHoursChange={handleHoursChange}
        onMinutesChange={handleMinutesChange}
        quickPicks={true}
      />,
    );

    const incHourBtn = screen.getByRole('button', { name: 'Increase hours' });
    fireEvent.click(incHourBtn);
    expect(handleHoursChange).toHaveBeenCalledWith('3');

    const incMinBtn = screen.getByRole('button', { name: 'Increase minutes' });
    fireEvent.click(incMinBtn);
    expect(handleMinutesChange).toHaveBeenCalledWith('35');
  });

  it('adds quick pick duration increments on chip click', () => {
    const handleHoursChange = jest.fn();
    const handleMinutesChange = jest.fn();

    render(
      <HoursMinutesInput
        hours="1"
        minutes="15"
        onHoursChange={handleHoursChange}
        onMinutesChange={handleMinutesChange}
        quickPicks={true}
      />,
    );

    const pick30m = screen.getByRole('button', { name: '30m' });
    fireEvent.click(pick30m);

    expect(handleHoursChange).toHaveBeenCalledWith('1');
    expect(handleMinutesChange).toHaveBeenCalledWith('45');
  });
});
