import { render, screen, fireEvent } from '@testing-library/react';
import { DraftNodeEditor, type DraftStage } from '@/components/matterComp/DraftStageEditor';

describe('DraftStageEditor', () => {
  const mockDraft: DraftStage = {
    localId: 'draft-1',
    name: 'Discovery Phase',
    color: '#3B82F6',
    isClosed: false,
    parentId: null,
    sortOrder: 0,
  };

  it('shows the draft, reports a name change, and closes on Done', () => {
    const handleChange = jest.fn();
    const handleClose = jest.fn();

    render(
      <DraftNodeEditor
        draft={mockDraft}
        onChange={handleChange}
        onClose={handleClose}
      />,
    );

    expect(screen.getByText('Edit stage')).toBeInTheDocument();
    expect(screen.getByText(/Ending stage/i)).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Stage name');
    expect(input).toHaveValue('Discovery Phase');
    fireEvent.change(input, { target: { value: 'Trial Prep' } });
    expect(handleChange).toHaveBeenCalledWith({ name: 'Trial Prep' });

    const closeBtn = screen.getByRole('button', { name: 'Done' });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalled();
  });
});
