import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketingNav from '@/components/marketingComp/MarketingNav';
import MarketingFooter from '@/components/marketingComp/MarketingFooter';
import MarketingTransition from '@/components/marketingComp/MarketingTransition';
import PricingFaq from '@/components/marketingComp/PricingFaq';
import PricingPlans from '@/components/marketingComp/PricingPlans';
import { Btn } from '@/components/marketingComp/primitives';
import { FAQS } from '@/components/marketingComp/marketingData';
import { scanAccessibility } from '../../support/accessibility';

jest.mock('next/navigation', () => ({
  usePathname: () => '/pricing',
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}));

// Animation timing is independent of the navigation and disclosure semantics.
jest.mock('framer-motion', () => {
  const React = require('react');
  const components = new Map();
  return {
    useReducedMotion: () => true,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: new Proxy({}, {
      get: (_, tag: string) => {
        if (!components.has(tag)) {
          components.set(tag, React.forwardRef(function Motion({ children, ...props }: any, ref: any) {
            for (const key of ['initial', 'animate', 'exit', 'transition', 'variants']) delete props[key];
            return React.createElement(tag, { ...props, ref }, children);
          }));
        }
        return components.get(tag);
      },
    }),
  };
});

it('exposes marketing destinations as links and marks the current page', () => {
  render(<MarketingNav />);
  expect(screen.getByRole('link', { name: 'Paralegix home' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/features');
  expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page');
});

it('exposes footer destinations as links while cookie settings remains an action', () => {
  render(<MarketingFooter />);
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  expect(screen.getAllByRole('link', { name: 'Security' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Cookie settings' })).toBeInTheDocument();
});

it('keeps destination buttons as links and action-only buttons keyboard operable', async () => {
  const action = jest.fn();
  const user = userEvent.setup();
  render(<><Btn href="/register">Start free</Btn><Btn onClick={action}>Try action</Btn></>);
  expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/register');
  screen.getByRole('button', { name: 'Try action' }).focus();
  await user.keyboard('{Enter}');
  expect(action).toHaveBeenCalledTimes(1);
});

it('connects the mobile disclosure to its navigation and restores focus on Escape', async () => {
  const user = userEvent.setup();
  render(<MarketingNav />);
  const toggle = screen.getByRole('button', { name: 'Open menu' });
  toggle.focus();
  await user.keyboard('{Enter}');
  const mobile = screen.getByRole('navigation', { name: 'Mobile primary' });
  expect(toggle).toHaveAttribute('aria-controls', mobile.id);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  within(mobile).getByRole('link', { name: 'Features' }).focus();
  await user.keyboard('{Escape}');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('navigation', { name: 'Mobile primary' })).not.toBeInTheDocument();
  expect(toggle).toHaveFocus();
});

it('gives marketing content a working skip target', async () => {
  const user = userEvent.setup();
  render(<><MarketingNav /><MarketingTransition><h1>Pricing</h1></MarketingTransition></>);
  const skip = screen.getByRole('link', { name: 'Skip to main content' });
  skip.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('main')).toHaveFocus();
});

it('hides collapsed FAQ answers and exposes only the expanded answer to assistive technology', async () => {
  const user = userEvent.setup();
  render(<PricingFaq />);
  const first = screen.getByRole('button', { name: FAQS[0].q });
  const second = screen.getByRole('button', { name: FAQS[1].q });
  const secondAnswer = screen.getByText(FAQS[1].a);
  expect(secondAnswer).not.toBeVisible();
  expect(secondAnswer.closest('[hidden]')).not.toBeNull();
  second.focus();
  await user.keyboard('{Enter}');
  expect(second).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById(second.getAttribute('aria-controls')!)).toContainElement(secondAnswer);
  expect(secondAnswer).toBeVisible();
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText(FAQS[0].a)).not.toBeVisible();
  await user.keyboard('{Enter}');
  expect(secondAnswer).not.toBeVisible();
});

it('reports the selected billing interval and updates that state after a keyboard change', async () => {
  const user = userEvent.setup();
  render(<PricingPlans />);
  const annual = screen.getByRole('button', { name: /Annual/ });
  const monthly = screen.getByRole('button', { name: 'Monthly' });
  expect(annual).toHaveAttribute('aria-pressed', 'true');
  expect(monthly).toHaveAttribute('aria-pressed', 'false');
  monthly.focus();
  await user.keyboard('{Enter}');
  expect(monthly).toHaveAttribute('aria-pressed', 'true');
  expect(annual).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('status')).toHaveTextContent('Monthly billing selected');
  expect(screen.getAllByText('Billed monthly')).toHaveLength(2);
});

it('has no automated WCAG DOM violations in pricing, including its expanded FAQ', async () => {
  const { container } = render(<>
    <MarketingNav />
    <MarketingTransition><PricingPlans /><PricingFaq /></MarketingTransition>
    <MarketingFooter />
  </>);
  expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  expect(screen.getByText(FAQS[0].a)).toBeVisible();
  const result = await scanAccessibility(container);
  expect(result.violations).toEqual([]);
});
