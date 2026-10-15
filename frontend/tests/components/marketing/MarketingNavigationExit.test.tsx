import { fireEvent, render, screen, within } from '@testing-library/react';
import MarketingNav from '@/components/marketingComp/MarketingNav';

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}));

it('removes closing mobile links from keyboard and assistive technology during the exit animation', () => {
  render(<MarketingNav />);
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  const navigation = screen.getByRole('navigation', { name: 'Mobile primary' });
  const features = within(navigation).getByRole('link', { name: 'Features' });
  expect(features).toHaveAttribute('href', '/features');
  fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
  // AnimatePresence retains the DOM for its exit, so invisibility must be explicit.
  expect(navigation).toBeInTheDocument();
  expect(navigation).toHaveAttribute('aria-hidden', 'true');
  expect(navigation).toHaveAttribute('inert');
});
