import { render, screen, fireEvent } from '@testing-library/react';
import TaskRecurrenceField, { type RecurrenceState } from '@/components/taskComp/taskForm/TaskRecurrenceField';

describe('TaskRecurrenceField', () => {
  const createMockState = (overrides: Partial<RecurrenceState> = {}): RecurrenceState => ({
    recurrenceEnabled: false,
    setRecurrenceEnabled: jest.fn(),
    recurrencePattern: 'weekly',
    setRecurrencePattern: jest.fn(),
    recurrenceInterval: 1,
    setRecurrenceInterval: jest.fn(),
    recurrenceDaysOfWeek: [1, 3, 5], // Mon, Wed, Fri
    setRecurrenceDaysOfWeek: jest.fn(),
    recurrenceDayOfMonth: null,
    setRecurrenceDayOfMonth: jest.fn(),
    recurrenceEndDate: null,
    setRecurrenceEndDate: jest.fn(),
    recurrenceMaxOccurrences: null,
    setRecurrenceMaxOccurrences: jest.fn(),
    ...overrides,
  });

  it('renders collapsed state with Off status badge', () => {
    const state = createMockState({ recurrenceEnabled: false });

    render(<TaskRecurrenceField state={state} />);

    expect(screen.getByRole('button', { name: /repeat/i })).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByText('Pattern')).not.toBeInTheDocument();
  });

  it('expands form fields when recurrenceEnabled is true', () => {
    const state = createMockState({
      recurrenceEnabled: true,
      recurrencePattern: 'weekly',
    });

    render(<TaskRecurrenceField state={state} />);

    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('Pattern')).toBeInTheDocument();
    expect(screen.getByText('Days of Week')).toBeInTheDocument();
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Wed')).toBeInTheDocument();
  });

  it('calls setRecurrenceEnabled when toggled', () => {
    const state = createMockState({ recurrenceEnabled: false });

    render(<TaskRecurrenceField state={state} />);

    const repeatBtn = screen.getByRole('button', { name: /repeat/i });
    fireEvent.click(repeatBtn);

    expect(state.setRecurrenceEnabled).toHaveBeenCalledWith(true);
  });

  it('allows toggling days of week for weekly recurrence', () => {
    const state = createMockState({
      recurrenceEnabled: true,
      recurrencePattern: 'weekly',
      recurrenceDaysOfWeek: [1], // Mon
    });

    render(<TaskRecurrenceField state={state} />);

    // Click 'Tue' (index 2)
    const tueBtn = screen.getByRole('button', { name: 'Tue' });
    fireEvent.click(tueBtn);

    expect(state.setRecurrenceDaysOfWeek).toHaveBeenCalledWith([1, 2]);
  });
});
