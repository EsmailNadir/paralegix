import { render, screen, fireEvent } from '@testing-library/react';
import MatterBudgetCard from '@/components/matterComp/MatterBudgetCard';
import type { Matter } from '@/types';

describe('MatterBudgetCard', () => {
  const baseMatter: Matter = {
    id: 'matter-1',
    lawFirmId: 'firm-1',
    name: 'Sample Matter',
    matterReferenceId: 'MAT-001',
    status: 'active',
    billingMethod: 'hourly',
    budgetCents: 500000, // $5,000.00
    billedTotalCents: 250000, // $2,500.00 (50%)
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('renders progress bar, percentage, and remaining budget when budget is configured', () => {
    render(<MatterBudgetCard matter={baseMatter} />);

    expect(screen.getByText('Budget & Billing')).toBeInTheDocument();
    expect(screen.getByText('Hourly')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/\$2,500\.00 remaining/i)).toBeInTheDocument();
  });

  it('renders over budget warning when billed total exceeds budget cap', () => {
    const overBudgetMatter: Matter = {
      ...baseMatter,
      budgetCents: 100000, // $1,000.00
      billedTotalCents: 150000, // $1,500.00 (150%)
    };

    render(<MatterBudgetCard matter={overBudgetMatter} />);

    expect(screen.getByText(/Over budget by \$500\.00/i)).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders fallback notice when no budget is set', () => {
    const noBudgetMatter: Matter = {
      ...baseMatter,
      budgetCents: null,
      billedTotalCents: 120000,
    };

    render(<MatterBudgetCard matter={noBudgetMatter} />);

    expect(screen.getByText(/No budget set\. \$1,200\.00 invoiced to date\./i)).toBeInTheDocument();
  });

  it('triggers onEdit callback when Edit billing button is clicked', () => {
    const handleEdit = jest.fn();

    render(<MatterBudgetCard matter={baseMatter} onEdit={handleEdit} />);

    const editBtn = screen.getByRole('button', { name: /edit billing/i });
    fireEvent.click(editBtn);

    expect(handleEdit).toHaveBeenCalledTimes(1);
  });
});
