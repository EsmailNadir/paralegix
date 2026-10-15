import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useParams: () => ({ lawFirmId: 'firm-123' }),
}));

// The plan decides WHICH of the two screens this renders, so the spec has to own
// it. setup.ts mocks LawFirmContext with a firm that carries no plan, which
// resolves to starter.
let mockPlan: Record<string, unknown> | undefined;
jest.mock('@/contexts/LawFirmContext', () => ({
  __esModule: true,
  useLawFirm: () => ({ lawFirm: { id: 'firm-123', plan: mockPlan } }),
}));

import FeatureDisabledPage from '@/components/ui/FeatureDisabledPage';

describe('FeatureDisabledPage', () => {
  describe('when the plan does not include the feature', () => {
    beforeEach(() => {
      mockPlan = { planId: 'starter' };
    });

    it('renders plan upgrade required page with target feature label', () => {
      render(<FeatureDisabledPage feature="trustAccounting" />);

      expect(screen.getByText('Upgrade required')).toBeInTheDocument();
      expect(screen.getByText(/Trust Accounting is not available/i)).toBeInTheDocument();
      expect(screen.getByText('View Plans')).toBeInTheDocument();
    });

    it('names the plan that first includes it', () => {
      render(<FeatureDisabledPage feature="trustAccounting" />);

      expect(screen.getByText(/Available on Professional/i)).toBeInTheDocument();
    });
  });

  describe('when the plan includes it and the firm switched it off', () => {
    beforeEach(() => {
      mockPlan = { planId: 'professional' };
    });

    it('says the firm turned it off instead of asking for an upgrade', () => {
      render(<FeatureDisabledPage feature="trustAccounting" />);

      // The upgrade screen would send someone to a pricing table for the plan
      // they are already on, which reads as a billing fault in the product.
      expect(screen.queryByText('Upgrade required')).not.toBeInTheDocument();
      expect(screen.queryByText('View Plans')).not.toBeInTheDocument();
      expect(screen.getByText('Turned off')).toBeInTheDocument();
      expect(screen.getByText(/Trust Accounting is turned off for your firm/i))
        .toBeInTheDocument();
    });

    it('points at the setting that turns it back on, and says nothing was lost', () => {
      render(<FeatureDisabledPage feature="trustAccounting" />);

      expect(screen.getByText('Firm settings')).toBeInTheDocument();
      expect(screen.getByText(/can manage firm settings can turn it back on/i))
        .toBeInTheDocument();
      expect(screen.getByText(/Nothing was deleted/i)).toBeInTheDocument();
    });

    it('takes the same branch for a starter firm an admin granted the feature', () => {
      // An admin override lifts the plan ceiling, so there is nothing to upgrade
      // to here either. The reason is still the firm's own opt-out.
      mockPlan = { planId: 'starter', featureOverrides: { trustAccounting: true } };
      render(<FeatureDisabledPage feature="trustAccounting" />);

      expect(screen.getByText('Turned off')).toBeInTheDocument();
    });

    it('takes the same branch under unlimitedOverride', () => {
      mockPlan = { planId: 'starter', unlimitedOverride: true };
      render(<FeatureDisabledPage feature="trustAccounting" />);

      expect(screen.getByText('Turned off')).toBeInTheDocument();
    });
  });

  describe('an explicit title and description still win', () => {
    it('overrides the opted-out copy', () => {
      mockPlan = { planId: 'professional' };
      render(
        <FeatureDisabledPage
          feature="trustAccounting"
          title="No trust here"
          description="Ask Dana."
        />,
      );

      expect(screen.getByText('No trust here')).toBeInTheDocument();
      expect(screen.getByText('Ask Dana.')).toBeInTheDocument();
    });
  });
});
