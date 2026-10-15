import { render, screen } from '@testing-library/react';
import ZonedEventTime from '@/components/calendarComp/ZonedEventTime';

const zone = { viewerZoneName: 'PDT', eventTime: 'Mon 10:00 AM', city: 'Auckland' };

describe('ZonedEventTime', () => {
  it('names the viewer\'s zone and the event\'s own local time and city', () => {
    const { container } = render(<ZonedEventTime when="2:00 PM" zone={zone} />);

    expect(container.textContent).toBe('2:00 PM PDT (Mon 10:00 AM in Auckland)');
  });

  it('sets the event\'s own time in the secondary tone by default', () => {
    render(<ZonedEventTime when="2:00 PM" zone={zone} />);

    expect(screen.getByText('(Mon 10:00 AM in Auckland)')).toHaveClass('text-on-surface-secondary');
  });

  it('keeps the surrounding tone on a muted line', () => {
    render(<ZonedEventTime when="2:00 PM" zone={zone} inheritTone />);

    const own = screen.getByText('(Mon 10:00 AM in Auckland)');
    expect(own.tagName).toBe('SPAN');
    expect(own).not.toHaveClass('text-on-surface-secondary');
  });

  it('shows the time alone when the event is in the viewer\'s zone', () => {
    const { container } = render(<ZonedEventTime when="2:00 PM" zone={null} />);

    expect(container.textContent).toBe('2:00 PM');
  });
});
