import React from 'react';
import { render, screen } from '@testing-library/react';
import RoleBadge from '@/components/ui/RoleBadge';

describe('RoleBadge', () => {
  it('renders normalized role names', () => {
    const { rerender } = render(<RoleBadge roleName="Managing Attorney" />);
    expect(screen.getByText('Managing Attorney')).toBeInTheDocument();

    rerender(<RoleBadge roleName="Senior Paralegal" />);
    expect(screen.getByText('Senior Paralegal')).toBeInTheDocument();

    rerender(<RoleBadge roleName="Firm Admin" />);
    expect(screen.getByText('Firm Admin')).toBeInTheDocument();

    rerender(<RoleBadge roleName="Staff Member" />);
    expect(screen.getByText('Staff Member')).toBeInTheDocument();
  });

  it('renders "Owner" and amber dot when isOwner is true', () => {
    render(<RoleBadge roleName="Admin" isOwner={true} />);
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('defaults to "Unknown" when roleName is null or empty', () => {
    const { rerender } = render(<RoleBadge roleName={null} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();

    rerender(<RoleBadge roleName="" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
