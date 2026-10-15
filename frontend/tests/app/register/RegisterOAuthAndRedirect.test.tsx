/**
 * The public signup page's pop-up providers, its signed-in redirect and its
 * native validation. The real auth service runs; only Firebase's pop-up and
 * persistence calls and the network are faked, so a provider rejection travels
 * the same path a browser's would.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/privacy.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: jest.fn() }));
jest.mock('next/image', () => ({ __esModule: true, default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => jest.requireActual('react').createElement('img', { ...props, priority: undefined }) }));
jest.mock('firebase/auth', () => ({
  ...jest.requireActual('firebase/auth'),
  setPersistence: jest.fn().mockResolvedValue(undefined),
  signInWithPopup: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
}));

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createUserWithEmailAndPassword, signInWithPopup } from 'firebase/auth';
import Register from '@/app/register/RegisterClient';
import { useAuth } from '@/hooks/useAuth';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../../support/apiMock';
import { deferred } from '../../support/deferred';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
const popup = jest.mocked(signInWithPopup);
const createUser = jest.mocked(createUserWithEmailAndPassword);
const useAuthMock = useAuth as jest.Mock;
const firebaseError = (code: string) => Object.assign(new Error(code), { code });
const OWN_FIRM = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  __resetDuplicateRequestGuard();
  useAuthMock.mockReturnValue({ user: null, loading: false });
});

describe.each(['Google', 'Microsoft'])('%s pop-up signup', (provider) => {
  it.each(['auth/popup-closed-by-user', 'auth/cancelled-popup-request'])(
    'exposes the open pop-up as busy, then announces %s as a cancellation and returns focus to the provider',
    async (code) => {
      const held = deferred<never>();
      popup.mockReturnValueOnce(held.promise);
      render(<Register />);
      const button = screen.getByRole('button', { name: provider });
      await userEvent.click(button);

      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(`Signing up with ${provider}...`);
      expect(screen.getByRole('button', { name: 'Create Account' })).toBeDisabled();

      // A browser drops focus from a control as it becomes disabled. jsdom keeps
      // it there and refuses to blur a disabled control, so park focus on the
      // landmark instead, or the restoration below would pass vacuously.
      screen.getByRole('main').focus();
      expect(screen.getByRole('main')).toHaveFocus();

      held.reject(firebaseError(code));

      await waitFor(() => expect(button).toBeEnabled());
      expect(button).toHaveFocus();
      expect(button).not.toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(`${provider} sign-up was cancelled.`);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create Account' })).toBeEnabled();
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(api.callsTo('/auth/login')).toHaveLength(0);
    },
  );

  it.each([
    ['auth/popup-blocked', /pop-up was blocked/i],
    ['auth/network-request-failed', /network error/i],
    ['auth/account-exists-with-different-credential', /different sign-in method/i],
  ])('focuses the %s summary, re-enables every control, and dismissal returns to the provider', async (code, message) => {
    popup.mockRejectedValueOnce(firebaseError(code));
    const { container } = render(<Register />);
    await userEvent.click(screen.getByRole('button', { name: provider }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.parentElement).toHaveFocus();
    expect(screen.getByRole('status')).not.toHaveTextContent(/signing up with/i);
    expect(screen.getByRole('button', { name: provider })).toBeEnabled();
    expect(screen.getByRole('button', { name: provider })).not.toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeEnabled();
    expect(screen.getByLabelText('Email *')).not.toHaveAttribute('aria-invalid', 'true');
    expect((await scanAccessibility(container)).violations).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: provider })).toHaveFocus();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('a cancelled pop-up signup', () => {
  it('stops reporting the cancellation once an email signup starts', async () => {
    popup.mockRejectedValueOnce(firebaseError('auth/popup-closed-by-user'));
    render(<Register />);
    await userEvent.click(screen.getByRole('button', { name: 'Google' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Google sign-up was cancelled.'));

    await userEvent.type(screen.getByLabelText('Full Name *'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email *'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('Password *'), 'abc');
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'xyz');
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(screen.getByLabelText('Confirm Password *')).toHaveAccessibleDescription(/Passwords do not match/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/cancelled/);
  });
});

describe('a signed-in visitor being redirected', () => {
  it('shows an announced waiting state in a focused main landmark, never the signup form, then routes to the firm', async () => {
    const held = deferred<{ needsRegistration: boolean; userType: string }>();
    api.getExact('/api/auth/user-type', () => held.promise);
    api.getExact('/api/users/profile', { id: 'user-1', userType: 'firm_member' });
    api.getExact('/api/users/my-lawfirms', { lawFirmIds: [OWN_FIRM] });
    api.getExact(`/api/lawfirms/${OWN_FIRM}/subscriptions/status`, { billingStatus: 'active' });
    useAuthMock.mockReturnValue({ user: { uid: 'user-1', email: 'ada@example.test', emailVerified: true }, loading: false });
    const { container } = render(<Register />);

    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Redirecting to your dashboard...');
    expect(screen.queryByRole('heading', { name: 'Create your account' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email *')).not.toBeInTheDocument();
    expect((await scanAccessibility(container)).violations).toEqual([]);

    held.resolve({ needsRegistration: false, userType: 'firm_member' });
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
    expect(screen.queryByRole('heading', { name: 'Create your account' })).not.toBeInTheDocument();
  });
});

describe('native constraint validation', () => {
  it('blocks an empty or malformed signup before any account is created', async () => {
    render(<Register />);
    const form = screen.getByLabelText('Email *').closest('form')!;
    expect(form.noValidate).toBe(false);
    for (const label of ['Full Name *', 'Email *', 'Password *', 'Confirm Password *']) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }
    expect(screen.getByLabelText('Email *')).toHaveAttribute('type', 'email');
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByLabelText('Full Name *')).toBeInvalid();
    await userEvent.type(screen.getByLabelText('Full Name *'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email *'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password *'), 'abcdef');
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'abcdef');
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByLabelText('Email *')).toBeInvalid();
    expect(createUser).not.toHaveBeenCalled();
    expect(api.callsTo('/auth/create-user')).toHaveLength(0);
  });
});
