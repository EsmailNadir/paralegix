import { render, screen } from '@testing-library/react';
import MarketingTransition from '@/components/marketingComp/MarketingTransition';

jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => true,
}));

it('shows content immediately without a transform when reduced motion is requested', () => {
  render(<MarketingTransition><h1>Welcome</h1></MarketingTransition>);
  const main = screen.getByRole('main');
  expect(main).toBeVisible();
  expect(main.style.transform).toBe('none');
});
