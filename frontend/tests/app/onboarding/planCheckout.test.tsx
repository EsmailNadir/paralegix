/**
 * `checkout_started` on the onboarding plan page. The page sits outside the
 * firm layout, so the firm id the layout registers on every other event is not
 * there for a firm that was created a moment ago. The event has to carry the
 * firm itself, or the checkout step cannot be joined to `law_firm_created` and
 * `subscription_started` in a per-firm funnel.
 */
const mockTrack = jest.fn();
jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
}));

const mockCreateCheckout = jest.fn();
jest.mock('@/services/subscription.service', () => ({
  __esModule: true,
  default: {
    createCheckout: (...args: unknown[]) => mockCreateCheckout(...args),
    getStatus: jest.fn(),
  },
}));

let mockSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => mockSearch,
  usePathname: () => '/onboarding/plan',
  useParams: () => ({}),
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnboardingPlanPage from '@/app/onboarding/plan/page';

const FIRM_ID = 'firm-new';

describe('onboarding plan checkout_started', () => {
  beforeEach(() => {
    mockSearch = new URLSearchParams({ firmId: FIRM_ID });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('carries the firm being checked out once the checkout session exists', async () => {
    mockCreateCheckout.mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.test/session' });
    render(<OnboardingPlanPage />);

    const choose = await screen.findAllByRole('button', { name: /continue to checkout/i });
    fireEvent.click(choose[0]);

    await waitFor(() => expect(mockTrack).toHaveBeenCalled());
    expect(mockCreateCheckout).toHaveBeenCalledWith(FIRM_ID, 'basic', 'monthly');
    expect(mockTrack).toHaveBeenCalledWith('checkout_started', {
      plan_id: 'basic',
      interval: 'monthly',
      law_firm_id: FIRM_ID,
    });
  });

  it('does not fire when the checkout session is refused', async () => {
    mockCreateCheckout.mockRejectedValue(new Error('Firm already subscribed'));
    render(<OnboardingPlanPage />);

    const choose = await screen.findAllByRole('button', { name: /continue to checkout/i });
    fireEvent.click(choose[0]);

    await waitFor(() => expect(mockCreateCheckout).toHaveBeenCalled());
    await screen.findByText(/already subscribed/i);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
