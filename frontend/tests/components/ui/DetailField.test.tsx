import { render, screen } from '@testing-library/react';
import DetailField from '@/components/ui/DetailField';

describe('DetailField', () => {
  it('renders label and provided value', () => {
    render(<DetailField label="Practice Area" value="Corporate Law" />);

    expect(screen.getByText('Practice Area')).toBeInTheDocument();
    expect(screen.getByText('Corporate Law')).toBeInTheDocument();
  });

  it('renders empty placeholder text when value is null or empty', () => {
    render(<DetailField label="Court" value={null} empty="No court assigned" />);

    expect(screen.getByText('Court')).toBeInTheDocument();
    expect(screen.getByText('No court assigned')).toBeInTheDocument();
  });

  it('renders children instead of value when children are passed', () => {
    render(
      <DetailField label="Status">
        <span data-testid="custom-child">Active Status</span>
      </DetailField>,
    );

    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByTestId('custom-child')).toBeInTheDocument();
  });
});
