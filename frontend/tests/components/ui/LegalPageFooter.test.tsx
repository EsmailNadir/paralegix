import { render, screen } from '@testing-library/react';
import LegalPageFooter from '@/components/ui/LegalPageFooter';
import { useRouter } from 'next/navigation';

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
}));

describe('LegalPageFooter', () => {
  const mockPush = jest.fn();

  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ push: mockPush });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders privacy, terms, and subprocessors as real links and marks the current page', () => {
    render(<LegalPageFooter currentPage="terms" />);

    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Sub-processors' })).toHaveAttribute('href', '/subprocessors');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).not.toHaveAttribute('aria-current');
  });
});
