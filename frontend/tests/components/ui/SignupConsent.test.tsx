import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignupConsent from '@/components/ui/SignupConsent';

describe('SignupConsent', () => {
  it('points to the analytics explanation without treating sign-up as consent to it', () => {
    render(<SignupConsent onNavigate={jest.fn()} />);

    expect(screen.getByText(/By creating an account, you agree to our/)).toHaveTextContent(
      'By creating an account, you agree to our Terms of Service and acknowledge our Privacy Policy, which explains our product analytics and how to turn it off.',
    );
  });

  it('hands each policy link to the page to navigate', () => {
    const onNavigate = jest.fn();
    render(<SignupConsent onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));
    fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));

    expect(onNavigate.mock.calls).toEqual([['/terms'], ['/privacy']]);
  });
});

it('exposes legal destinations and keeps the page navigation callback for keyboard activation', async () => {
  const navigate = jest.fn();
  render(<SignupConsent onNavigate={navigate} />);
  const terms = screen.getByRole('link', { name: 'Terms of Service' });
  expect(terms).toHaveAttribute('href', '/terms');
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  terms.focus();
  await userEvent.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledWith('/terms');
  await userEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
  expect(navigate).toHaveBeenLastCalledWith('/privacy');
});

it('leaves modified legal-link clicks to the browser without starting the leaving state', () => {
  const navigate = jest.fn();
  render(<SignupConsent onNavigate={navigate} />);
  const terms = screen.getByRole('link', { name: 'Terms of Service' });
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    expect(fireEvent.click(terms, { [modifier]: true })).toBe(true);
  }
  expect(navigate).not.toHaveBeenCalled();
});
