import { render, screen } from '@testing-library/react';
import TaskDependencyPicker from '@/components/taskComp/taskForm/TaskDependencyPicker';

jest.mock('@/components/ui/EntityMultiPicker', () => ({
  __esModule: true,
  default: ({ selectedIds }: { selectedIds: string[] }) => (
    <div data-testid="entity-multi-picker">
      <span>Selected count: {selectedIds.length}</span>
    </div>
  ),
}));

describe('TaskDependencyPicker', () => {
  it('renders label and description and passes task dependencies to picker', () => {
    render(
      <TaskDependencyPicker
        lawFirmId="firm-1"
        dependencies={['task-1', 'task-2']}
        setDependencies={jest.fn()}
        excludeTaskId="task-current"
      />,
    );

    expect(screen.getByText('Blocked By (Dependencies)')).toBeInTheDocument();
    expect(screen.getByText(/Select tasks that must be completed/i)).toBeInTheDocument();
    expect(screen.getByTestId('entity-multi-picker')).toBeInTheDocument();
    expect(screen.getByText('Selected count: 2')).toBeInTheDocument();
  });
});
