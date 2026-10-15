import { render, screen, fireEvent } from '@testing-library/react';
import dayjs from 'dayjs';
import CalendarMonthGrid from '@/components/ui/CalendarMonthGrid';
import { useCalendarWeeks } from '@/components/ui/datePickerCore';

/**
 * The three date pickers each drew this grid. What differed between them was
 * which days count as selected and how big the cells are, so those are what
 * this pins: a range picker's middle days, a single picker's one day, and the
 * compact metrics `DateTimePicker` needs to fit a 240px popover.
 */
function Harness({
  month = '2026-09-01',
  dayState = () => 'idle' as const,
  onDayClick = jest.fn(),
  size,
}: {
  month?: string;
  dayState?: (key: string) => 'selected' | 'in-range' | 'idle';
  onDayClick?: (key: string) => void;
  size?: 'default' | 'compact';
}) {
  const cursor = dayjs(month);
  const weeks = useCalendarWeeks(cursor);
  return (
    <CalendarMonthGrid
      cursor={cursor}
      onCursorChange={jest.fn()}
      weeks={weeks}
      today="2026-09-18"
      dayState={dayState}
      onDayClick={onDayClick}
      size={size}
    />
  );
}

/** The cell for a day of the shown month, by its number. */
const day = (n: string) =>
  screen.getAllByRole('button').find((b) => b.textContent === n && !b.className.includes('muted/50'))!;

describe('CalendarMonthGrid', () => {
  it('shows the month it is pointed at, with a full week header', () => {
    render(<Harness />);
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
  });

  it('reports the day the user picks as YYYY-MM-DD', () => {
    const handleClick = jest.fn();
    render(<Harness onDayClick={handleClick} />);

    fireEvent.click(day('15'));
    expect(handleClick).toHaveBeenCalledWith('2026-09-15');
  });

  it('paints a selected day differently from a day inside a range', () => {
    render(
      <Harness
        dayState={(key) => {
          if (key === '2026-09-10' || key === '2026-09-14') return 'selected';
          if (key > '2026-09-10' && key < '2026-09-14') return 'in-range';
          return 'idle';
        }}
      />,
    );

    expect(day('10').className).toContain('bg-accent-solid');
    expect(day('12').className).toContain('bg-accent-range');
    expect(day('12').className).not.toContain('bg-accent-solid');
    expect(day('16').className).toContain('hover:bg-surface-hover');
  });

  it('rings today, but not when today is the selected day', () => {
    const { unmount } = render(<Harness />);
    expect(day('18').className).toContain('ring-accent-indicator');
    unmount();

    render(<Harness dayState={(key) => (key === '2026-09-18' ? 'selected' : 'idle')} />);
    expect(day('18').className).not.toContain('ring-accent-indicator');
  });

  it('dims the days that spill in from the neighbouring months', () => {
    render(<Harness />);
    // September 2026 starts on a Tuesday, so the grid opens with August 30.
    const spill = screen.getAllByRole('button').filter((b) => b.className.includes('muted/50'));
    expect(spill.length).toBeGreaterThan(0);
  });

  it('shrinks every metric for the compact size, which the time picker needs', () => {
    const { unmount } = render(<Harness />);
    expect(day('15').className).toContain('h-7');
    unmount();

    render(<Harness size="compact" />);
    expect(day('15').className).toContain('h-6');
    expect(day('15').className).not.toContain('h-7');
  });
});
