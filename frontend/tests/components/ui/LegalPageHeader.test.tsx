import { render, screen } from '@testing-library/react';
import LegalPageHeader from '@/components/ui/LegalPageHeader';
import { useRouter } from 'next/navigation';

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
}));

describe('LegalPageHeader', () => {
  const mockPush = jest.fn();

  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ push: mockPush });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders sign in and get started as real links to their destinations', () => {
    render(<LegalPageHeader />);

    expect(screen.getByRole('link', { name: /Sign In/i })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /Get Started/i })).toHaveAttribute('href', '/register');
  });
});
