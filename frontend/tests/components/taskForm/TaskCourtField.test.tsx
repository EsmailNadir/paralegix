import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskCourtField from '@/components/taskComp/taskForm/TaskCourtField';

jest.mock('@/components/courtsComp/CourtDirectoryLink', () =>
  require('../../support/fixtures/courtFieldMocks').courtDirectoryLinkModule());
jest.mock('@/components/courtsComp/CourtNameAutocomplete', () =>
  require('../../support/fixtures/courtFieldMocks').courtNameAutocompleteModule());

describe('TaskCourtField', () => {
  const mockCourts = [
    { id: 'court-1', name: 'US District Court', abbreviation: 'USDC', city: 'San Jose' },
  ];

  it('shows the selected court, then opens the quick-create panel and creates one', async () => {
    const handleSetCourtId = jest.fn();
    const mockCreateCourt = jest.fn().mockResolvedValue({ courtId: 'new-court-99' });

    render(
      <TaskCourtField
        courtId="court-1"
        setCourtId={handleSetCourtId}
        courts={mockCourts}
        createCourt={mockCreateCourt}
      />,
    );

    expect(screen.getByText(/US District Court/i)).toBeInTheDocument();

    const plusBtn = screen.getByRole('button', { name: 'Quick-create a court' });
    fireEvent.click(plusBtn);

    expect(screen.getByText('Quick Create Court')).toBeInTheDocument();

    const nameInput = screen.getByTestId('court-autocomplete');
    fireEvent.change(nameInput, { target: { value: 'Ninth Circuit Court of Appeals' } });

    const submitBtn = screen.getByRole('button', { name: 'Create & Select' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateCourt).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Ninth Circuit Court of Appeals' }),
      );
      expect(handleSetCourtId).toHaveBeenCalledWith('new-court-99');
    });
  });
});
