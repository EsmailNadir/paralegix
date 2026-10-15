import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MatterCourtField from '@/components/matterComp/matterForm/MatterCourtField';

jest.mock('@/components/courtsComp/CourtDirectoryLink', () =>
  require('../../support/fixtures/courtFieldMocks').courtDirectoryLinkModule());
jest.mock('@/components/courtsComp/CourtNameAutocomplete', () =>
  require('../../support/fixtures/courtFieldMocks').courtNameAutocompleteModule());

describe('MatterCourtField', () => {
  const mockCourts = [
    { id: 'court-1', name: 'California Supreme Court', abbreviation: 'CSC', city: 'San Francisco' },
  ];

  it('shows the selected court and handles quick court creation flow', async () => {
    const handleChange = jest.fn();
    const mockCreate = jest.fn().mockResolvedValue({ courtId: 'court-new' });

    render(
      <MatterCourtField
        value="court-1"
        onChange={handleChange}
        courts={mockCourts}
        loading={false}
        createCourt={mockCreate}
        firmId="firm-1"
      />,
    );

    expect(screen.getByText(/California Supreme Court/i)).toBeInTheDocument();

    const plusBtn = screen.getByRole('button', { name: 'Quick-create a court' });
    fireEvent.click(plusBtn);

    const nameInput = screen.getByTestId('court-autocomplete');
    fireEvent.change(nameInput, { target: { value: 'Federal District Court' } });

    const createBtn = screen.getByRole('button', { name: 'Create & Select' });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Federal District Court' }),
      );
      expect(handleChange).toHaveBeenCalledWith('court-new');
    });
  });
});
