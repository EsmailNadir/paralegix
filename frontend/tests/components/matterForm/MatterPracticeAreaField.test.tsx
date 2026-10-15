import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MatterPracticeAreaField from '@/components/matterComp/matterForm/MatterPracticeAreaField';

describe('MatterPracticeAreaField', () => {
  const mockPracticeAreas = [
    { id: 'pa-1', name: 'Immigration' },
    { id: 'pa-2', name: 'Real Estate' },
  ];

  it('shows the selected practice area and allows quick-creating one', async () => {
    const handleChange = jest.fn();
    const mockCreate = jest.fn().mockResolvedValue({ practiceArea: { id: 'pa-new' } });

    render(
      <MatterPracticeAreaField
        value="pa-1"
        onChange={handleChange}
        practiceAreas={mockPracticeAreas}
        loading={false}
        createPracticeArea={mockCreate}
        firmId="firm-1"
      />,
    );

    expect(screen.getByText('Immigration')).toBeInTheDocument();

    const plusBtn = screen.getByRole('button', { name: 'Quick-create a practice area' });
    fireEvent.click(plusBtn);

    const input = screen.getByPlaceholderText(/e\.g\. Family Law/i);
    fireEvent.change(input, { target: { value: 'Labor & Employment' } });

    const createBtn = screen.getByRole('button', { name: 'Create & Select' });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('Labor & Employment');
      expect(handleChange).toHaveBeenCalledWith('pa-new');
    });
  });
});
