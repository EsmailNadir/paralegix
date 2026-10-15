jest.unmock('@/services/auth.service');
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockUser = {
  uid: 'test-uid', email: 'unverified@example.test', emailVerified: false,
  providerData: [{ providerId: 'password' }], reload: jest.fn(), getIdToken: jest.fn(),
};
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser, loading: false }) }));
jest.mock('@/lib/firebase/config', () => ({ auth: { currentUser: mockUser } }));
jest.mock('firebase/auth', () => ({
  sendEmailVerification: jest.fn(),
  GoogleAuthProvider: jest.fn(() => ({ addScope: jest.fn() })),
  OAuthProvider: jest.fn(() => ({ addScope: jest.fn(), setCustomParameters: jest.fn() })),
}));

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sendEmailVerification } from 'firebase/auth';
import VerifyEmail from '@/app/verify-email/page';

const resend = jest.mocked(sendEmailVerification);
beforeEach(() => {
  mockUser.reload.mockReset().mockResolvedValue(undefined);
  mockUser.getIdToken.mockReset().mockResolvedValue('token');
  resend.mockReset(); mockRouter.replace.mockReset();
});

it('announces resend success without announcing the cooldown every second', async () => {
  resend.mockResolvedValueOnce(undefined);
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<VerifyEmail />);
    await waitFor(() => expect(mockUser.reload).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Resend Verification Email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Verification email sent!'));
    expect(resend).toHaveBeenCalledWith(mockUser);
    expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
    await act(async () => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: 'Resend in 59s' })).toBeDisabled();
    expect(screen.getByRole('status')).not.toHaveTextContent(/59|60/);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

it('focuses a failed verification check on every attempt', async () => {
  render(<VerifyEmail />);
  await waitFor(() => expect(mockUser.reload).toHaveBeenCalledTimes(1));
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(screen.getByRole('button', { name: "I've Verified My Email" }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email not yet verified');
    expect(alert.parentElement).toHaveFocus();
  }
  expect(mockUser.reload).toHaveBeenCalledTimes(3);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('exposes the verification instructions through a main landmark and page heading', () => {
  render(<VerifyEmail />);
  expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { name: 'Check your email', level: 1 }));
});

it('announces an expired session before its login redirect and keeps an immediate way back to login', async () => {
  render(<VerifyEmail />);
  await waitFor(() => expect(mockUser.reload).toHaveBeenCalledTimes(1));
  mockUser.reload.mockRejectedValueOnce(new Error('auth/user-token-expired'));
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: "I've Verified My Email" }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has expired. Redirecting to login...');
    expect(alert.parentElement).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Back to login' })).toBeEnabled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1500));
    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});
