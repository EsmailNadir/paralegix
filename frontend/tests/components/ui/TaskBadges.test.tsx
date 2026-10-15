import React from 'react';
import { render, screen } from '@testing-library/react';
import TaskPriorityBadge from '@/components/ui/TaskPriorityBadge';
import TaskStatusBadge from '@/components/ui/TaskStatusBadge';

describe('TaskPriorityBadge', () => {
  it('renders standard priority labels', () => {
    const { rerender } = render(<TaskPriorityBadge priority="urgent" />);
    expect(screen.getByText('Urgent')).toBeInTheDocument();

    rerender(<TaskPriorityBadge priority="high" />);
    expect(screen.getByText('High')).toBeInTheDocument();

    rerender(<TaskPriorityBadge priority="medium" />);
    expect(screen.getByText('Medium')).toBeInTheDocument();

    rerender(<TaskPriorityBadge priority="low" />);
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('handles null/unspecified priority gracefully', () => {
    render(<TaskPriorityBadge priority={null} />);
    expect(screen.getByText(/medium/i)).toBeInTheDocument();
  });
});

describe('TaskStatusBadge', () => {
  it('renders status label without overdue text when overdue is false', () => {
    render(<TaskStatusBadge status="in_progress" overdue={false} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('folds overdue indicator into badge label when overdue is true', () => {
    render(<TaskStatusBadge status="in_progress" overdue={true} />);
    expect(screen.getByText('In Progress · Overdue')).toBeInTheDocument();
  });

  it('handles completed status', () => {
    render(<TaskStatusBadge status="completed" />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });
});
