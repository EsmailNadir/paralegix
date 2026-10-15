import { render, screen, fireEvent } from '@testing-library/react';
import TrialBanner from '@/components/billingComp/TrialBanner';
import { useNavigation } from '@/contexts/NavigationContext';

jest.mock('@/contexts/NavigationContext', () => ({
  useNavigation: jest.fn(),
}));

describe('TrialBanner', () => {
  const mockNavigate = jest.fn();

  beforeEach(() => {
    (useNavigation as jest.Mock).mockReturnValue({
      navigate: mockNavigate,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when billingStatus is active or not trialing', () => {
    const { container } = render(
      <TrialBanner
        lawFirmId="firm-1"
        billingStatus="active"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders days remaining when trialing', () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    render(
      <TrialBanner
        lawFirmId="firm-1"
        billingStatus="trialing"
        trialEndsAt={futureDate}
      />,
    );

    expect(screen.getByText(/5 days left in your trial/i)).toBeInTheDocument();
    expect(screen.getByText('Manage subscription')).toBeInTheDocument();
  });

  it('navigates to billing settings when Manage subscription button is clicked', () => {
    const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    render(
      <TrialBanner
        lawFirmId="firm-1"
        billingStatus="trialing"
        trialEndsAt={futureDate}
      />,
    );

    const btn = screen.getByText('Manage subscription');
    fireEvent.click(btn);

    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-1/settings/billing');
  });
});
