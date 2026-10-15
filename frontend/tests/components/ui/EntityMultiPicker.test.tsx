import { render, screen, fireEvent } from '@testing-library/react';
import EntityMultiPicker from '@/components/ui/EntityMultiPicker';
import { useEntityLookup, useEntityByIdsChunked } from '@/hooks/useEntityLookup';

jest.mock('@/hooks/useEntityLookup');

describe('EntityMultiPicker', () => {
  it('reports an empty search while keeping the selected row visible and removable', async () => {
    (useEntityLookup as jest.Mock).mockReturnValue({ items: [], hasMore: false, loading: false, isPlaceholder: false });
    const onChange = jest.fn();
    render(<EntityMultiPicker entity="tasks" lawFirmId="firm-1" selectedIds={['task-1']} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Search tasks...'), { target: { value: 'nonexistent' } });
    expect(await screen.findByText('No tasks match your search.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('File Notice of Appeal'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  beforeEach(() => {
    (useEntityLookup as jest.Mock).mockReturnValue({
      items: [
        { id: 'task-1', label: 'File Notice of Appeal' },
        { id: 'task-2', label: 'Draft Opposition Brief' },
      ],
      hasMore: false,
      loading: false,
      isPlaceholder: false,
    });
    (useEntityByIdsChunked as jest.Mock).mockReturnValue({
      items: [{ id: 'task-1', label: 'File Notice of Appeal' }],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders multi-select entity list with search box and handles toggle', () => {
    const handleChange = jest.fn();

    render(
      <EntityMultiPicker
        entity="tasks"
        lawFirmId="firm-1"
        selectedIds={['task-1']}
        onChange={handleChange}
        label="Blocked Tasks"
      />,
    );

    expect(screen.getByText('Blocked Tasks')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
    expect(screen.getByText('File Notice of Appeal')).toBeInTheDocument();

    const secondRow = screen.getByText('Draft Opposition Brief');
    fireEvent.click(secondRow);

    expect(handleChange).toHaveBeenCalledWith(['task-1', 'task-2']);
  });
});
