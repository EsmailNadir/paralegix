jest.unmock('@/services/auth.service');
const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockQuery = new URLSearchParams('mode=verifyEmail&oobCode=code-a');
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => mockQuery }));
jest.mock('firebase/auth', () => ({
  applyActionCode: jest.fn(), sendEmailVerification: jest.fn(),
  GoogleAuthProvider: jest.fn(() => ({ addScope: jest.fn() })),
  OAuthProvider: jest.fn(() => ({ addScope: jest.fn(), setCustomParameters: jest.fn() })),
}));

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { applyActionCode, sendEmailVerification } from 'firebase/auth';
import AuthAction from '@/app/auth/action/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { deferred } from '../../support/deferred';

const apply = jest.mocked(applyActionCode);
const resend = jest.mocked(sendEmailVerification);
let auth: typeof import('@/lib/firebase/config').auth;
beforeEach(async () => {
  ({ auth } = await import('@/lib/firebase/config'));
  mockQuery = new URLSearchParams('mode=verifyEmail&oobCode=code-a');
  mockRouter.push.mockReset(); mockRouter.replace.mockReset();
  apply.mockReset().mockResolvedValue(undefined); resend.mockReset().mockResolvedValue(undefined);
});

it.each([
  ['mode=verifyEmail', /verification code is missing/],
  ['', /navigated here directly/],
  ['mode=unsupported&oobCode=a', /action is not supported/],
])('rejects malformed action parameters %s without calling Firebase', async (query, message) => {
  mockQuery = new URLSearchParams(query);
  renderWithProviders(<AuthAction />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
});

it.each([
  ['auth/expired-action-code', /verification link has expired/],
  ['auth/invalid-action-code', /invalid or has already been used/],
  ['auth/network-request-failed', /Network error/],
])('shows the appropriate recovery for %s', async (code, message) => {
  apply.mockRejectedValue(new Error(code));
  renderWithProviders(<AuthAction />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(apply).toHaveBeenCalledWith(auth, 'code-a');
  expect(mockRouter.push).not.toHaveBeenCalled();
});

it('preserves the password reset code in its redirect', () => {
  mockQuery = new URLSearchParams('mode=resetPassword&oobCode=code%2B%26');
  renderWithProviders(<AuthAction />);
  expect(mockRouter.replace).toHaveBeenCalledWith('/reset-password?oobCode=code%2B%26');
  expect(apply).not.toHaveBeenCalled();
});

it('waits for successful verification before navigating to login', async () => {
  jest.useFakeTimers();
  try {
    const pending = deferred<void>();
    apply.mockReturnValueOnce(pending.promise);
    renderWithProviders(<AuthAction />);
    await waitFor(() => expect(apply).toHaveBeenCalledWith(auth, 'code-a'));
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(screen.queryByText('Email Verified')).not.toBeInTheDocument();
    expect(mockRouter.push).not.toHaveBeenCalled();
    await act(async () => pending.resolve(undefined));
    await screen.findByText('Email Verified');
    const heading = screen.getByRole('heading', { name: 'Email Verified', level: 1 });
    expect(heading).toHaveFocus();
    expect(apply).toHaveBeenCalledWith(auth, 'code-a');
    expect(mockRouter.push).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(3000); });
    expect(mockRouter.push).toHaveBeenCalledWith('/login');
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

it('resends through the real auth service and shows provider throttling', async () => {
  apply.mockRejectedValue(new Error('auth/expired-action-code'));
  resend.mockRejectedValueOnce(new Error('auth/too-many-requests')).mockResolvedValueOnce(undefined);
  renderWithProviders(<AuthAction />);
  await userEvent.click(await screen.findByRole('button', { name: 'Resend verification email' }));
  expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
  expect(auth).not.toBeNull();
  expect(resend).toHaveBeenCalledWith(auth!.currentUser);
  await userEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
  expect(await screen.findByText(/A new verification email has been sent/)).toBeInTheDocument();
  expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
  expect(resend).toHaveBeenCalledTimes(2);
});


it('announces resend failures and the successful retry', async () => {
  apply.mockRejectedValueOnce(new Error('auth/expired-action-code'));
  resend.mockRejectedValueOnce(new Error('auth/too-many-requests')).mockResolvedValueOnce(undefined);
  renderWithProviders(<AuthAction />);
  await userEvent.click(await screen.findByRole('button', { name: 'Resend verification email' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  expect(resend).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
  expect(await screen.findByRole('status')).toHaveTextContent('A new verification email has been sent');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(resend).toHaveBeenCalledTimes(2);
});

it('announces the pending verification as a named status inside the main landmark', async () => {
  const pending = deferred<void>();
  apply.mockReturnValueOnce(pending.promise);
  renderWithProviders(<AuthAction />);
  await waitFor(() => expect(apply).toHaveBeenCalledWith(auth, 'code-a'));
  try {
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Verifying your email...');
    expect(screen.getByRole('main')).toContainElement(status);
  } finally {
    await act(async () => pending.reject(new Error('auth/expired-action-code')));
  }
});

it.each([
  ['auth/expired-action-code', 'This verification link is no longer valid'],
  ['auth/network-request-failed', 'We could not complete this email action'],
])('moves focus from the pending check to the result heading for %s', async (code, title) => {
  const pending = deferred<void>();
  apply.mockReturnValueOnce(pending.promise);
  renderWithProviders(<AuthAction />);
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  await act(async () => pending.reject(new Error(code)));
  expect(await screen.findByRole('heading', { name: title, level: 1 })).toHaveFocus();
  expect(screen.getAllByRole('link', { name: 'Back to login' })[0]).toHaveAttribute('href', '/login');
});

it('announces the upcoming login redirect with the verified heading and offers to continue at once', async () => {
  jest.useFakeTimers();
  try {
    renderWithProviders(<AuthAction />);
    const heading = await screen.findByRole('heading', { name: 'Email Verified', level: 1 });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAccessibleDescription(/Redirecting to login/);
    expect(screen.getByRole('link', { name: 'Sign In Now' })).toHaveAttribute('href', '/login');
    expect(mockRouter.push).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(3000); });
    expect(mockRouter.push).toHaveBeenCalledWith('/login');
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});
