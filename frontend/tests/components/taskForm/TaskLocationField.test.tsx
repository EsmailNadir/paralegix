import { render, screen } from '@testing-library/react';
import TaskLocationField from '@/components/taskComp/taskForm/TaskLocationField';

describe('TaskLocationField', () => {
  const mockCourts = [
    {
      id: 'court-1',
      name: 'County Courthouse',
      address: '400 McAllister St',
      city: 'San Francisco',
      state: 'CA',
    },
  ];

  it('shows the typed location, and autofills the court address once a court is picked over a blank one', () => {
    const handleSetLocation = jest.fn();

    const { rerender } = render(
      <TaskLocationField
        location="Room 302"
        setLocation={handleSetLocation}
        courtId=""
        courts={mockCourts}
      />,
    );

    expect(screen.getByPlaceholderText(/e\.g\. Conference Room A/i)).toHaveValue('Room 302');

    rerender(
      <TaskLocationField
        location=""
        setLocation={handleSetLocation}
        courtId=""
        courts={mockCourts}
      />,
    );

    rerender(
      <TaskLocationField
        location=""
        setLocation={handleSetLocation}
        courtId="court-1"
        courts={mockCourts}
      />,
    );

    expect(handleSetLocation).toHaveBeenCalledWith('400 McAllister St, San Francisco, CA');
  });
});
