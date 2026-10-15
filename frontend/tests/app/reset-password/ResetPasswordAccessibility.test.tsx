const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => new URLSearchParams('oobCode=reset-code') }));
jest.mock('firebase/auth', () => ({ confirmPasswordReset: jest.fn() }));

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { confirmPasswordReset } from 'firebase/auth';
import ResetPassword from '@/app/reset-password/page';

const reset = jest.mocked(confirmPasswordReset);
beforeEach(() => { reset.mockReset(); mockRouter.push.mockReset(); });

async function fillPasswords(confirmation = 'different') {
  await userEvent.type(screen.getByLabelText('New Password *'), 'abcdef');
  await userEvent.type(screen.getByLabelText('Confirm New Password *'), confirmation);
}

it('focuses and describes the mismatched field again on a repeated submission', async () => {
  render(<ResetPassword />);
  expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1, name: "Reset Your Password" }));
  await fillPasswords();
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
    expect(screen.getByLabelText('Confirm New Password *')).toHaveFocus();
    expect(screen.getByLabelText('Confirm New Password *')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Confirm New Password *')).toHaveAccessibleDescription(/Passwords do not match/);
    expect(screen.getByLabelText('New Password *')).not.toHaveAttribute('aria-invalid', 'true');
  }
  expect(reset).not.toHaveBeenCalled();
});

it('focuses service errors and leaves a usable form for retry', async () => {
  reset.mockRejectedValueOnce(new Error('auth/network-request-failed'));
  render(<ResetPassword />);
  await fillPasswords('abcdef');
  await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Network error');
  expect(alert.parentElement).toHaveFocus();
  const { auth } = await import('@/lib/firebase/config');
  expect(reset).toHaveBeenCalledWith(auth, 'reset-code', 'abcdef');
  expect(screen.getByRole('button', { name: 'Reset Password' })).toBeEnabled();
});

it('focuses the successful result before the existing login redirect', async () => {
  reset.mockResolvedValueOnce(undefined);
  render(<ResetPassword />);
  await fillPasswords('abcdef');
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Reset Password' }));
    const heading = await screen.findByRole('heading', { name: 'Password Reset Successful', level: 1 });
    expect(heading).toHaveFocus();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(3000));
    expect(mockRouter.push).toHaveBeenCalledWith('/login');
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});


it('connects a provider-rejected weak password to the password field', async () => {
  reset.mockRejectedValueOnce(new Error('auth/weak-password'));
  render(<ResetPassword />);
  await fillPasswords('abcdef');
  await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
  await screen.findByText('Password is too weak. Please use at least 6 characters.');
  expect(screen.getByLabelText('New Password *')).toHaveFocus();
  expect(screen.getByLabelText('New Password *')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('New Password *')).toHaveAccessibleDescription(/Password is too weak/);
  expect(reset).toHaveBeenCalledTimes(1);
});

it.each([
  ['auth/expired-action-code', /reset link has expired/],
  ['auth/invalid-action-code', /invalid or has already been used/],
])('replaces the form with a focused invalid-link result for %s', async (code, message) => {
  reset.mockRejectedValueOnce(new Error(code));
  render(<ResetPassword />);
  await fillPasswords('abcdef');
  await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
  const heading = await screen.findByRole('heading', { name: 'This password reset link is no longer valid', level: 1 });
  expect(heading).toHaveFocus();
  expect(screen.getByRole('main')).toContainElement(heading);
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reset Password' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Request a new reset' })).toHaveAttribute('href', '/login');
  expect(reset).toHaveBeenCalledTimes(1);
});

it('announces the upcoming login redirect with the success heading and offers to continue at once', async () => {
  reset.mockResolvedValueOnce(undefined);
  render(<ResetPassword />);
  await fillPasswords('abcdef');
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Reset Password' }));
    const heading = await screen.findByRole('heading', { name: 'Password Reset Successful', level: 1 });
    expect(heading).toHaveAccessibleDescription(/Redirecting to login/);
    expect(screen.getByRole('link', { name: 'Sign In Now' })).toHaveAttribute('href', '/login');
    expect(mockRouter.push).not.toHaveBeenCalled();
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});
